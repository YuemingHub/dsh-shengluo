/**
 * 生络 — Today 主动发现（纯规则）。
 *
 * 输入是已经读到的真实事实；本文件不做 IO，也不编数据。
 * 输出最多 3 件值得关注的事；没有证据就是 empty。
 * 标题/说明允许来自本人已授权的现实（只用于本次内存展示），不持久化。
 */
export const TODAY_LIMIT = 3
const DAY = 86400000
const RECENT_DAYS = 14

const clip = (value, limit = 60) => {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s.length > limit ? s.slice(0, limit) + '…' : s
}

const iso = (value) => {
  const t = Date.parse(value ?? '')
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * @param {object} input
 * @param {string} [input.now]
 * @param {{state:string, results?:object[], error?:string}} [input.reality]
 * @param {string|null} [input.activeGoal]
 * @param {Array} [input.runs]
 * @param {Array} [input.decisions]
 * @param {Array} [input.projects]
 * @param {{state?:string, files?:object[]}} [input.knowledge]
 * @param {string[]} [input.errors]
 */
export function buildToday({
  now = new Date().toISOString(),
  reality = { state: 'unauthorized', results: [] },
  activeGoal = null,
  runs = [],
  decisions = [],
  projects = [],
  knowledge = {},
  errors = [],
} = {}) {
  const nowMs = Date.parse(now) || Date.now()
  const cutoff = nowMs - RECENT_DAYS * DAY
  const items = []
  const push = (item) => {
    if (item && Array.isArray(item.evidence) && item.evidence.length > 0) items.push(item)
  }

  // 1) 还在等本人决定的事：优先级最高
  for (const decision of decisions) {
    if (!decision || decision.resolved || (!decision.id && !decision.title)) continue
    const sessionId = decision.sessionId ?? null
    push({
      id: 'today-decision-' + (decision.id ?? clip(decision.title, 24)),
      kind: 'decision',
      priority: 90,
      at: iso(decision.at),
      title: '有一件事还在等你决定：' + clip(decision.title, 50),
      why: '它停在需要你点头的地方，还没往下走。',
      evidence: [{ type: 'decision', ref: decision.id ?? null, label: '待你决定', at: iso(decision.at), sessionId }],
      unknown: '我不知道你现在是否已经决定，只是它还在这里。',
      next: '回原生会话把它处理掉，或明确先放着。',
      action: sessionId ? { kind: 'open-session', ref: sessionId } : null,
    })
  }

  // 2) 已经开始的 run，但还没有收口
  for (const run of runs) {
    if (!run || !run.runId || !run.goal || !['running', 'waiting-for-you', 'verifying'].includes(run.status)) continue
    push({
      id: 'today-run-' + run.runId,
      kind: 'run',
      priority: 80,
      at: iso(run.startedAt),
      title: '还有一件没做完的事：' + clip(run.goal, 50),
      why: '这次已经开始，但还没有收口。',
      evidence: [{ type: 'run', ref: run.runId, label: '原生会话', at: iso(run.startedAt), sessionId: run.sessionId ?? null }],
      unknown: '我不知道你现在是否还想继续它。',
      next: '回原生会话继续，或明确停下。',
      action: run.sessionId ? { kind: 'open-session', ref: run.sessionId } : null,
    })
  }

  // 3) 最近 14 天里本人自己说过/经历过的事
  if (reality?.state === 'authorized' && Array.isArray(reality.results)) {
    const recent = reality.results
      .filter((fact) => {
        const t = Date.parse(fact?.time?.eventTime ?? '')
        return Number.isFinite(t) && t >= cutoff
      })
      .sort((a, b) => Date.parse(b.time.eventTime) - Date.parse(a.time.eventTime))
    for (const fact of recent.slice(0, 2)) {
      if (!fact || (!fact.id && !fact.statement)) continue
      const at = iso(fact.time?.eventTime)
      const conversationId = fact.source?.conversationId ?? null
      push({
        id: 'today-reality-' + (fact.id ?? clip(fact.statement, 20)),
        kind: 'reality',
        priority: 70,
        at,
        title: clip(fact.statement, 62),
        why: '这是你最近自己说过/经历过的事；先摆出来，是否要处理由你判断。',
        evidence: [{
          type: 'reality',
          ref: fact.id ?? null,
          label: fact.source?.label ?? '家庭空间',
          at,
          speaker: fact.assertedBy === 'owner' ? '本人' : (fact.assertedBy ?? null),
          factStatus: fact.factStatus ?? null,
          conversationId,
        }],
        unknown: '我不知道这件事现在是否还需要你处理，也不替你下结论。',
        next: activeGoal
          ? '如果它和「' + clip(activeGoal, 28) + '」有关，说一句，我把它接进来。'
          : '如果它还没处理完，可以从这里说一句。',
        action: conversationId ? { kind: 'open-conversation', ref: conversationId } : null,
      })
    }
  }

  // 4) 项目里有未提交改动（有界：最多 3 个工作区）
  for (const project of projects) {
    if (!project?.path) continue
    const git = project.git
    if (!git?.dirty || !Array.isArray(git.changed) || git.changed.length === 0) continue
    push({
      id: 'today-project-' + project.path,
      kind: 'project',
      priority: 60,
      at: iso(git.lastAt),
      title: '「' + clip(project.title ?? project.path, 40) + '」里有还没收口的改动',
      why: '这些改动还没提交，可能正卡着你现在的进展。',
      evidence: [{
        type: 'project',
        ref: project.path,
        label: '项目仓库',
        at: iso(git.lastAt),
        head: git.head ?? null,
        changed: git.changed.slice(0, 6),
      }],
      unknown: '我不知道这些改动是不是你有意留着的。',
      next: '回项目决定提交、继续还是撤销。',
      action: null,
    })
  }

  // 5) 已连接的知识里有近期新内容
  if (knowledge?.state === 'connected' && Array.isArray(knowledge.files)) {
    const recent = knowledge.files.filter((file) => {
      const t = Date.parse(file?.modifiedAt ?? '')
      return Number.isFinite(t) && t >= cutoff
    })
    for (const file of recent.slice(0, 1)) {
      if (!file || (!file.id && !file.title && !file.relPath)) continue
      push({
        id: 'today-knowledge-' + (file.id ?? file.title),
        kind: 'knowledge',
        priority: 40,
        at: iso(file.modifiedAt),
        title: '知识里有新内容：' + clip(file.title ?? file.relPath, 40),
        why: '这是最近发布的知识，可能和你在做的事有关。',
        evidence: [{ type: 'knowledge', ref: file.id ?? file.relPath ?? null, label: 'MKI', at: iso(file.modifiedAt) }],
        unknown: '我不知道它是否真的适用于你现在这件事。',
        next: '去知识页看这条，或让我在任务里引用它。',
        action: { kind: 'view', ref: 'knowledge' },
      })
    }
  }

  items.sort((a, b) => b.priority - a.priority || String(b.at ?? '').localeCompare(String(a.at ?? '')))
  const top = items.slice(0, TODAY_LIMIT).map(({ priority, ...rest }) => rest)
  const unauthorized = reality?.state && reality.state !== 'authorized'
  const note = top.length
    ? ''
    : (unauthorized
        ? '个人现实尚未授权，今天只能看工作区与任务；这不是没有事，只是未知。'
        : '目前没有值得打扰你的事。')
  return {
    at: now,
    state: top.length ? 'ready' : (errors.length ? 'error' : 'empty'),
    items: top,
    note,
    errors: errors.filter(Boolean).slice(0, 3),
    realityState: reality?.state ?? 'unauthorized',
  }
}
