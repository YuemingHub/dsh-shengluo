/**
 * 生络 — 语义神经网络（产品层）。
 *
 * 这里只做「投影 + 人话关系」：
 * - 节点全部来自真实来源（个人现实 / 项目仓库 / 执行会话 / 工作区成果 / 知识 / 目标 / 待决定）；
 * - 每条关系带一句普通人能读懂的话和它成立的理由；
 * - 默认只呈现 5–9 个与当前事情有关的节点，其余收进二级详情。
 *
 * 关系与界面偏好是生络产品层的数据（可重建），不是权威事实来源。
 */
import { shortHash } from './util.mjs'

const RELATION_TEXT = {
  informs: (a, b) => '"' + a + '" 是理解「' + b + '」的依据',
  hosts: (a, b) => '「' + b + '」在这个项目里：' + a,
  hosts_file: (a, b) => '"' + b + '" 就在这个项目目录里：' + a,
  pursued_by: (a, b) => '"' + a + '" 正在这里推进',
  produced: (a, b) => '"' + b + '" 是这次留下的成果',
  raises: (a, b) => '"' + b + '" 还在等这个人决定',
  guides: (a, b) => '"' + a + '" 在给「' + b + '」定方向',
  about_you: (a, b) => '"' + a + '" 来自你自己的现实，不是猜的：' + b,
  // 未授权时不能说"来自你的现实"：那是把未知说成事实。
  reality_unknown: (a, b) => '「' + b + '」可能会用到' + a + '，但还没授权，现在是未知',
}

/** 关系句子里引用标题时先截短，避免出现半截话。 */
const short = (value, limit = 14) => {
  const text = String(value ?? '')
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

const NODE_WEIGHT = {
  goal: 100,
  decision: 92,
  // 正在推进的那件事必须比它的产出更靠前：否则一堆成果会把「谁在跑」挤出去。
  task: 80,
  reality: 74,
  project: 66,
  artifact: 58,
  knowledge: 34,
}

const rank = (node) => (NODE_WEIGHT[node.kind] ?? 10) + (node.boost ?? 0)

function edge(from, to, relation, why, extra = {}) {
  return {
    id: 'edge-' + shortHash(from + '|' + to + '|' + relation),
    from,
    to,
    relation,
    label: (RELATION_TEXT[relation] ?? ((a, b) => a + ' → ' + b))(
      from === 'core' ? '生络' : (extra.fromTitle ?? from),
      to === 'core' ? '生络' : (extra.toTitle ?? to),
    ),
    why,
    ...extra,
  }
}

/**
 * 组装网络。所有输入都是「已经真实读到的数据」，本函数不做 IO。
 * @returns {{ nodes: object[], edges: object[], visibleIds: string[], hiddenCount: number }}
 */
export function buildNetwork({
  realityNode = null,
  realityAuthorized = false,
  realityFacts = [],
  workspaces = [],
  goals = [],
  runs = [],
  knowledge = [],
  artifacts = [],
  decisions = [],
  curated = [],
  focusGoal = null,
  maxVisible = 9,
} = {}) {
  const nodes = []
  const edges = []
  const seen = new Set()
  const push = (node) => {
    if (!node || seen.has(node.id)) return node
    seen.add(node.id)
    nodes.push(node)
    return node
  }

  // 1) 个人现实（永远在，未授权时是明确的未知节点）
  if (realityNode) push(realityNode)

  // 2) 当前这件事（目标）—— 有明确目标时它就是网络的中心话题
  const goalId = 'goal:current'
  if (focusGoal) {
    push({
      id: goalId,
      kind: 'goal',
      title: focusGoal.length > 42 ? focusGoal.slice(0, 42) + '…' : focusGoal,
      subtitle: '当前这件事',
      assertedBy: 'owner',
      factStatus: 'owner_said',
      sourceRef: { type: 'owner', label: '你自己说的', uri: null },
      time: { at: null, label: '刚刚' },
      visibility: 'private',
      boost: 10,
    })
    if (realityNode) {
      if (realityAuthorized) {
        edges.push(edge(realityNode.id, goalId, 'about_you', '这件事会用到你授权过的个人现实。', {
          fromTitle: realityNode.title, toTitle: short(focusGoal, 12),
        }))
      } else {
        edges.push(edge(realityNode.id, goalId, 'reality_unknown', '要不要用你的个人现实由你决定；未授权时我不猜。', {
          fromTitle: short(realityNode.title, 8), toTitle: short(focusGoal, 12),
        }))
      }
    }
  }

  // 3) 项目（DSH 原生 workspace；权威在项目仓库本身）
  //    只放当前相关的几个：有焦点就用带焦点的那个，没焦点最多 4 个，避免把本机所有项目都摊上来。
  const projectLimit = focusGoal ? 3 : 4
  for (const workspace of workspaces.slice(0, projectLimit)) {
    const node = push({
      id: 'project:' + workspace.id,
      kind: 'project',
      title: workspace.title || workspace.path,
      subtitle: workspace.path,
      assertedBy: 'system',
      factStatus: 'fact',
      sourceRef: { type: 'workspace', label: '项目目录', uri: workspace.path },
      time: { at: workspace.openedAt ?? null, label: workspace.openedAt ? String(workspace.openedAt).slice(0, 10) : '本机项目' },
      visibility: 'workspace',
      openable: { kind: 'workspace', target: workspace.path },
      boost: workspace.active ? 8 : 0,
    })
    if (goalId !== 'goal:current' || focusGoal) {
      edges.push(edge(node.id, goalId, 'hosts', '这件真实存在的项目目录，是这件事的现场。', {
        fromTitle: node.title, toTitle: short(focusGoal ?? '当前这件事', 12),
      }))
    }
  }

  // 4) 目标（DSH 原生 goal 服务，绑定在真实会话上）
  for (const goal of goals) {
    const node = push({
      id: 'goal:' + goal.sessionId,
      kind: 'goal',
      title: goal.title ?? '会话里的目标',
      subtitle: '原生会话目标 · ' + (goal.status ?? '进行中'),
      assertedBy: 'owner',
      factStatus: 'owner_said',
      sourceRef: { type: 'session', label: 'DSH 原生会话', uri: goal.sessionId },
      time: { at: goal.at ?? null, label: goal.at ? String(goal.at).slice(0, 10) : '—' },
      visibility: 'private',
      openable: { kind: 'session', target: goal.sessionId },
    })
    if (focusGoal) edges.push(edge(node.id, goalId, 'informs', '这是你在原生会话里立过的目标。', { fromTitle: node.title, toTitle: short(focusGoal, 12) }))
  }

  // 5) 执行（原生会话里真实发生的事）
  for (const run of runs) {
    const node = push({
      id: 'task:' + run.runId,
      kind: 'task',
      title: run.goal.length > 36 ? run.goal.slice(0, 36) + '…' : run.goal,
      subtitle: runStatusText(run.status) + (run.toolCalls ? ' · ' + run.toolCalls + ' 次工具调用' : ''),
      assertedBy: 'system',
      factStatus: 'fact',
      sourceRef: { type: 'session', label: 'DSH 原生会话', uri: run.sessionId },
      time: { at: run.startedAt ?? null, label: run.startedAt ? String(run.startedAt).slice(0, 16).replace('T', ' ') : '—' },
      visibility: 'private',
      openable: run.sessionId ? { kind: 'session', target: run.sessionId } : null,
      boost: run.status === 'running' ? 12 : 0,
    })
    if (focusGoal) edges.push(edge(goalId, node.id, 'pursued_by', '这件事在一个真实的 DSH 会话里跑，不是模拟。', { fromTitle: short(focusGoal, 12), toTitle: node.title }))
  }

  // 6) 成果（工作区文件；权威是文件本身）
  for (const artifact of artifacts) {
    const node = push({
      id: 'artifact:' + artifact.path,
      kind: 'artifact',
      title: artifact.name,
      subtitle: [artifact.kind, artifact.sizeLabel].filter(Boolean).join(' · '),
      assertedBy: 'system',
      factStatus: 'fact',
      sourceRef: { type: 'file', label: artifact.path, uri: artifact.path },
      time: { at: artifact.modifiedAt ?? null, label: artifact.modifiedAt ? String(artifact.modifiedAt).slice(0, 10) : '—' },
      visibility: 'workspace',
      openable: { kind: 'artifact', target: artifact.path },
      boost: artifact.fromRun ? 10 : 0,
    })
    const owner = artifact.runId ? 'task:' + artifact.runId : goalId
    if (seen.has(owner)) {
      edges.push(edge(owner, node.id, 'produced', '这个文件是真实写在工作区里的，可以打开核对。', {
        fromTitle: owner === goalId ? short(focusGoal ?? '当前这件事', 12) : '', toTitle: node.title,
      }))
      continue
    }
    // 没有正在推进的事时，用「文件真的在这个项目目录里」这条真关系接上，不编。
    const host = workspaces.find((workspace) => artifact.root && workspace.path === artifact.root)
    if (host && seen.has('project:' + host.id)) {
      edges.push(edge('project:' + host.id, node.id, 'hosts_file', '按目录归属判断：这个文件确实在这个项目的路径下。', {
        fromTitle: host.title, toTitle: node.title,
      }))
    }
  }

  // 7) 待决定（原生审批 + 明确需要人定的点）
  for (const decision of decisions) {
    const node = push({
      id: 'decision:' + decision.id,
      kind: 'decision',
      title: decision.title,
      subtitle: decision.detail ?? '等你决定',
      assertedBy: 'system',
      factStatus: 'fact',
      sourceRef: { type: 'session', label: 'DSH 原生审批', uri: decision.sessionId ?? null },
      time: { at: decision.at ?? null, label: decision.at ? String(decision.at).slice(0, 16).replace('T', ' ') : '刚刚' },
      visibility: 'private',
      openable: decision.sessionId ? { kind: 'session', target: decision.sessionId } : null,
      boost: 14,
    })
    if (focusGoal) edges.push(edge(goalId, node.id, 'raises', '这一步会改变结果，我不替你决定。', { fromTitle: short(focusGoal, 12), toTitle: node.title }))
  }

  // 8) 知识（MKI；权威在知识源本身）
  for (const item of knowledge) {
    const node = push({
      id: 'knowledge:' + item.id,
      kind: 'knowledge',
      title: item.title,
      subtitle: item.label ?? '知识',
      assertedBy: 'system',
      factStatus: 'fact',
      sourceRef: { type: 'knowledge', label: item.label ?? 'MKI', uri: item.uri ?? null },
      time: { at: item.at ?? null, label: item.at ? String(item.at).slice(0, 10) : '—' },
      visibility: 'private',
      openable: item.uri ? { kind: 'file', target: item.uri } : null,
    })
  }

  // 9) 个人现实的事实节点（只在内存，来源/时间/归属/事实状态都带上）
  for (const fact of realityFacts) push(fact)

  // 10) 人工策展的关系（本人加的，优先级高于投影）
  for (const relation of curated) {
    if (!seen.has(relation.from) || !seen.has(relation.to)) continue
    edges.push(edge(relation.from, relation.to, relation.relation, relation.note || '这是你自己加的关系。'))
  }

  // 排序：与当前事情越相关越靠前；其余按类型权重。
  const sorted = [...nodes].sort((a, b) => rank(b) - rank(a))
  const visible = sorted.slice(0, Math.max(5, Math.min(maxVisible, 9)))
  const visibleIds = visible.map((node) => node.id)

  // 只保留两端都可见的连线，避免出现悬空线；同一对（来源+关系）最多留两条，
  // 否则「三个文件都在同一个项目里」会刷出一排一模一样的话。
  const visibleSet = new Set(visibleIds)
  const perPair = new Map()
  const visibleEdges = edges.filter((e) => {
    if (!visibleSet.has(e.from) || !visibleSet.has(e.to)) return false
    const key = e.from + '|' + e.relation
    const used = perPair.get(key) ?? 0
    if (used >= 2) return false
    perPair.set(key, used + 1)
    return true
  })

  return {
    nodes: sorted,
    edges,
    visibleIds,
    visibleEdges,
    hiddenCount: Math.max(0, sorted.length - visible.length),
  }
}

export function runStatusText(status) {
  if (status === 'running') return '正在执行'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '如实停下'
  return '已记录'
}
