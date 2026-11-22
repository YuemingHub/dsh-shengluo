/**
 * 生络 — 个人理解索引与本人纠正（纯规则）。
 *
 * 硬边界：
 * - 只保存来源指针、时间、说话人、事实状态、结构与本人确认的纠正文本；
 * - 不保存结构化理解块的 headline / known / inference / unknown 原文；
 * - 不保存 Family Space 个人现实正文。
 */
const MAX_SOURCES = 10

/** 从一次真实 Family Space 查询结果里抽来源指针（不含正文、标题）。 */
export function sourceRefsFromReality(last, limit = MAX_SOURCES) {
  if (!last || typeof last !== 'object') return []
  const refs = []
  for (const fact of (last.results ?? []).slice(0, limit)) {
    if (!fact?.id) continue
    refs.push({
      type: 'reality',
      id: fact.id,
      speaker: fact.assertedBy === 'owner' ? '本人' : (fact.assertedBy ?? null),
      time: fact.time?.eventTime ?? null,
      factStatus: fact.factStatus ?? null,
      conversationId: fact.source?.conversationId ?? null,
    })
  }
  for (const conversation of (last.conversations ?? []).slice(0, 3)) {
    if (!conversation?.id) continue
    refs.push({
      type: 'conversation',
      id: conversation.id,
      speaker: null,
      time: conversation.startedAt ?? null,
      factStatus: 'conversation',
      conversationId: conversation.id,
    })
  }
  return refs.slice(0, limit)
}

/**
 * 把一次结构化理解编译成可持久化索引：只留来源指针、计数、action、是否留下 headline。
 * @param {{runId:string, at?:string|null, block?:object|null, sources?:object[]}} input
 */
export function compileUnderstanding({ runId, at = null, block = null, sources = [] } = {}) {
  if (!runId || !block || typeof block !== 'object') return null
  const sourceRefs = sources.slice(0, MAX_SOURCES).map((source) => ({
    type: source.type ?? 'unknown',
    id: source.id ?? null,
    speaker: source.speaker ?? null,
    time: source.time ?? null,
    factStatus: source.factStatus ?? null,
    conversationId: source.conversationId ?? null,
  }))
  return {
    id: 'und-' + runId,
    runId,
    at: at ?? null,
    sourceCount: sourceRefs.length,
    sources: sourceRefs,
    counts: {
      known: Array.isArray(block.known) ? block.known.length : 0,
      inference: Array.isArray(block.inference) ? block.inference.length : 0,
      unknown: Array.isArray(block.unknown) ? block.unknown.length : 0,
    },
    action: typeof block.action === 'string' ? block.action : null,
    headlinePresent: Boolean(block.headline),
    updatedAt: at ?? null,
  }
}

/** 给 Agent 阅读的索引文本：只有指针/状态/本人纠正，没有现实正文。 */
export function renderUnderstandingForAgent({ entries = [], corrections = [] } = {}) {
  const lines = []
  if (entries.length === 0) {
    lines.push('还没有保存的理解索引。')
  } else {
    lines.push('我的理解索引（只有来源指针与事实状态，不含个人现实正文）：')
    for (const entry of entries.slice(0, 8)) {
      const sources = (entry.sources ?? []).map((source) => source.type + ':' + (source.id ?? '?')).join(', ')
      const counts = entry.counts ?? {}
      lines.push('- ' + (entry.at ?? '时间未知')
        + ' · 来源 ' + (entry.sourceCount ?? 0) + ' 个'
        + ' · known ' + (counts.known ?? 0) + ' / inference ' + (counts.inference ?? 0) + ' / unknown ' + (counts.unknown ?? 0)
        + (sources ? ' · ' + sources : ''))
    }
  }
  lines.push('')
  if (corrections.length === 0) {
    lines.push('本人还没有纠正过我的理解。')
  } else {
    lines.push('本人确认过的纠正（后续任务必须优先使用；不得被历史推断覆盖）：')
    for (const correction of corrections.slice(-8)) {
      lines.push('- ' + (correction.at ?? '时间未知') + '：' + correction.text)
    }
  }
  return lines.join('\n')
}
