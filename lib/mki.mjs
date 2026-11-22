/**
 * 生络 — MKI 知识服务客户端（只读 HTTP）。
 *
 * 契约来源：Family Space `src/services/mki-knowledge-bridge.js`
 *   POST {MKI_BASE_URL}/v1/knowledge/match   Authorization: Bearer {MKI_API_KEY}
 *   响应 { data: { results: [...], not_applicable: [], information_gaps: [], rules_version } }
 *   KCP 条目 governance.status 必须为 PUBLISHED 才可用；KCP_PREVIEW 只预览、不引用（fail-closed）。
 *
 * 纪律：
 * - 未配置（无 baseUrl / apiKey）→ not_configured，UI 诚实显示未连接；
 * - 不可用 / 契约不符 → unavailable，不编知识；
 * - 只读：不发任何写请求。
 */

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function firstString(...values) {
  for (const value of values) {
    const t = text(value)
    if (t) return t
  }
  return ''
}

export function mkiConfig(config = {}) {
  const baseUrl = firstString(process.env.MKI_BASE_URL, config.mkiBaseUrl)
  const apiKey = firstString(process.env.MKI_API_KEY, config.mkiApiKey)
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, configured: Boolean(baseUrl && apiKey) }
}

function readWarnings(payload) {
  const list = []
  if (Array.isArray(payload?.warnings)) list.push(...payload.warnings)
  if (Array.isArray(payload?.data?.meta?.warnings)) list.push(...payload.data.meta.warnings)
  return list.map((item) => String(item ?? '')).filter(Boolean)
}

function isPublished(result) {
  // KCP 条目按 governance.status；没有该字段的旧条目按 rules_version 的 v1.3 语义处理（不是 KCP）。
  const gov = result?.governance
  if (!gov || typeof gov !== 'object') return true
  return text(gov.status) === 'PUBLISHED'
}

function pickSnippet(result) {
  const candidates = [
    result?.answer,
    result?.summary,
    result?.content,
    result?.snippet,
    result?.statement,
    result?.title,
  ]
  for (const candidate of candidates) {
    const t = text(candidate)
    if (t) return t.length > 500 ? t.slice(0, 500) + '…' : t
  }
  return ''
}

function pickSource(result) {
  const src = result?.source ?? result?.citation ?? {}
  return {
    title: firstString(result?.title, result?.name),
    chapter: firstString(src.chapter, src.chapter_title, src.section),
    url: firstString(src.url, result?.url),
    ref: firstString(result?.id, result?.knowledge_id, src.id),
  }
}

/**
 * 检索知识。返回：
 * { ok, state:'connected'|'not_configured'|'unavailable', detail, hits:[{title, snippet, source, verdict, preview}], warnings }
 */
export async function searchMki(config, query, { limit = 5, timeoutMs = 8000 } = {}) {
  const { baseUrl, apiKey, configured } = mkiConfig(config)
  if (!configured) {
    return { ok: false, state: 'not_configured', detail: '知识服务还没有配置（MKI_BASE_URL / MKI_API_KEY）。现在是未连接，不是没有知识。', hits: [] }
  }
  const q = text(query)
  if (!q) return { ok: true, state: 'connected', detail: '', hits: [], warnings: [] }

  const body = {
    subject: q.slice(0, 200),
    situation: { summary: q.slice(0, 1200) },
    topics: [],
    options: { max_results: Math.max(1, Math.min(Number(limit) || 5, 8)) },
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(baseUrl + '/v1/knowledge/match', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error) {
    return { ok: false, state: 'unavailable', detail: '知识服务连不上（' + (text(error?.message) || 'network error') + '）。', hits: [] }
  } finally {
    clearTimeout(timer)
  }

  if (response.status !== 200) {
    return { ok: false, state: 'unavailable', detail: '知识服务返回 HTTP ' + response.status + '。', hits: [] }
  }
  let payload = null
  try { payload = await response.json() } catch { payload = null }
  const data = payload && payload.data
  if (!data || !Array.isArray(data.results)) {
    return { ok: false, state: 'unavailable', detail: '知识服务返回的形状不符合契约。', hits: [] }
  }

  const warnings = readWarnings(payload)
  const previewMode = warnings.some((warning) => /KCP_PREVIEW/i.test(warning))
  const hits = []
  for (const result of data.results) {
    if (!result || typeof result !== 'object') continue
    const verdict = text(result.verdict) || 'applicable'
    if (verdict === 'not_applicable') continue
    if (!isPublished(result)) continue // fail-closed：非 PUBLISHED 的 KCP 条目一律不用
    const snippet = pickSnippet(result)
    if (!snippet) continue
    hits.push({
      title: firstString(result.title, result.name) || '知识条目',
      snippet,
      source: pickSource(result),
      verdict,
      preview: previewMode,
    })
  }
  return {
    ok: true,
    state: 'connected',
    detail: hits.length === 0 ? '这次没有匹配到可用的已发布知识。' : '',
    rulesVersion: text(data.rules_version) || null,
    gaps: Array.isArray(data.information_gaps) ? data.information_gaps.slice(0, 5).map((item) => String(item ?? '')) : [],
    warnings,
    hits: previewMode ? [] : hits,
  }
}

/** 连通性摘要（给网络与连接页；不发明数据）。 */
export async function mkiStatus(config) {
  const { configured } = mkiConfig(config)
  if (!configured) return { state: 'not_configured', detail: '未配置（MKI_BASE_URL / MKI_API_KEY）' }
  return { state: 'configured', detail: '已配置（每次按任务检索；检索失败会如实显示不可用）' }
}
