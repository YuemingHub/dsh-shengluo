/**
 * 生络 — 个人现实的产品层投影。
 *
 * 权威是 Family Space。这里只做两件事：
 * 1) 把授权状态说人话（未授权 = 未知，不是空）；
 * 2) 把一次查询结果投影成网络节点与"我现在的理解"，并**只在内存里**保留最近一次。
 *    正文不落盘：验收要求「不发生个人现实正文向本地图数据库的全量复制」。
 */
import { nowIso } from './util.mjs'

const FACT_STATUS_LABEL = {
  owner_said: '你亲口说的',
  fact: '有依据的陈述',
  inference: '家明归纳的暂定理解',
  unknown: '未知',
}

const ASSERTED_LABEL = {
  owner: '你说的',
  co_parent: '另一位家长',
  child: '孩子',
  system: '系统记录',
  unknown: '来源不明',
}

export class RealityProjection {
  constructor({ familySpace, store }) {
    this.familySpace = familySpace
    this.store = store
    // 只在这里留最近一次查询，进程结束即消失，不写盘。
    this.last = null
  }

  async status() {
    return this.familySpace.status()
  }

  /** 按任务问个人现实；结果留在内存供本次界面使用。 */
  async query({ task, limit, timeRange, conversationIds } = {}) {
    const outcome = await this.familySpace.queryReality({ task, limit, timeRange, conversationIds })
    if (outcome.ok) {
      this.last = {
        at: nowIso(),
        task: task ?? null,
        results: outcome.results,
        conversations: outcome.conversations ?? [],
        unknowns: outcome.unknowns ?? [],
        personId: outcome.personId ?? null,
        counts: outcome.counts ?? null,
        emptyReason: outcome.emptyReason ?? null,
      }
    } else if (outcome.state === 'unauthorized' || outcome.state === 'expired') {
      this.last = null
    }
    return outcome
  }

  async readConversation(id) {
    return this.familySpace.readConversation(id)
  }

  async revoke() {
    this.last = null
    return this.familySpace.revoke()
  }

  /** 网络里的「个人现实」节点。未授权时它是一个明确的未知节点，不是假数据。 */
  async node() {
    const status = await this.status()
    const meta = this.store.realityMeta()
    if (status.state !== 'authorized') {
      return {
        id: 'reality',
        kind: 'reality',
        title: '我的现实',
        subtitle: status.state === 'expired' ? '授权已过期，现在是未知' : '尚未授权，现在是未知',
        factStatus: 'unknown',
        assertedBy: 'system',
        sourceRef: { type: 'family-space', label: '家庭空间（未连接）', uri: null },
        time: { at: null, label: '—' },
        visibility: 'private',
        openable: { kind: 'connect' },
        unsupported: true,
      }
    }
    const subject = status.subject ?? null
    const count = this.last?.results?.length ?? 0
    return {
      id: 'reality',
      kind: 'reality',
      title: '我的现实',
      subtitle: [
        subject?.displayName ?? '本人',
        count > 0 ? '本次用到 ' + count + ' 条' : '本次还没有查',
      ].join(' · '),
      factStatus: 'fact',
      assertedBy: 'owner',
      sourceRef: { type: 'family-space', label: '家庭空间 · 个人现实', uri: null },
      time: { at: meta.authorizedAt ?? null, label: meta.authorizedAt ? '授权于 ' + String(meta.authorizedAt).slice(0, 10) : '已授权' },
      visibility: 'private',
      openable: { kind: 'reality' },
      scopes: status.scopes,
    }
  }

  /** 把最近一次查询结果变成少量「现实」节点，带来源、时间、归属、事实状态。 */
  factNodes(limit = 4) {
    if (!this.last) return []
    return this.last.results.slice(0, limit).map((fact) => ({
      id: 'reality:' + (fact.id || fact.statement.slice(0, 24)),
      kind: 'reality',
      title: fact.statement.length > 46 ? fact.statement.slice(0, 46) + '…' : fact.statement,
      // 服务端自带 status_label 时直接用它的说法（"你自己说过的情况"这类），不要自己另编一套。
      subtitle: [fact.statusLabel || FACT_STATUS_LABEL[fact.factStatus] || '未知', fact.source?.label ?? '家庭空间']
        .filter(Boolean)
        .join(' · '),
      factStatus: fact.factStatus,
      assertedBy: fact.assertedBy,
      sourceRef: {
        type: 'family-space',
        label: fact.source?.label ?? '家庭空间',
        uri: fact.source?.conversationId ? 'conversation:' + fact.source.conversationId : null,
      },
      time: {
        at: fact.time?.eventTime ?? null,
        label: fact.time?.eventTime ? String(fact.time.eventTime).slice(0, 10) : '时间未知',
      },
      quote: fact.verbatimQuote ? fact.statement : null,
      basis: fact.basis ?? null,
      visibility: 'private',
      openable: fact.source?.conversationId ? { kind: 'conversation', target: fact.source.conversationId } : null,
      raw: fact,
    }))
  }

  understanding() {
    const status = this.store.realityMeta()
    if (status.state !== 'authorized') {
      return {
        headline: '我还不知道你的个人现实',
        points: [
          '家庭空间尚未授权，所以关于你的生活、家庭对话，我现在只能标成未知。',
          '我不会用测试数据或猜测补这个空白。',
          '你可以先让我用工作区里的真实项目做事；需要个人现实时，连接一次就行。',
        ],
      }
    }
    if (!this.last) {
      return {
        headline: '已经可以读你的个人现实，但这件事还没查过',
        points: [
          '你在家庭空间里授权了「本人有权访问的个人现实」与「本人的家庭对话」。',
          '当前这件事我还没查现实；需要时我会按任务去问，不会在启动时全量同步。',
        ],
      }
    }
    const points = []
    const factCount = this.last.results.filter((r) => r.factStatus === 'owner_said' || r.factStatus === 'fact').length
    const inferenceCount = this.last.results.filter((r) => r.factStatus === 'inference').length
    if (factCount > 0) points.push('这次有 ' + factCount + ' 条有来源的陈述，来源和时间都标在节点上了。')
    if (inferenceCount > 0) points.push('另有 ' + inferenceCount + ' 条是家明归纳的暂定理解，我没有把它们当事实用。')
    if (this.last.results.length === 0) {
      points.push(this.last.unknowns?.[0]?.message || '这次没查到相关现实。没有不等于不存在，只是这次范围内没有匹配。')
    }
    if ((this.last.counts?.omitted_conversations ?? 0) > 0) {
      points.push('另有 ' + this.last.counts.omitted_conversations + ' 段对话不在你的授权范围内，我不会去猜它们是什么。')
    }
    points.push('我只读你有权访问的部分：孩子本人的直接表达、老师/外部转述、其他家长的内容都不会从这里出来。')
    return { headline: '这件事和你自己说过的、发生过的事有关', points }
  }
}
