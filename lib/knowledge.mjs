/**
 * 生络 — MKI 知识正文检索（只读，无向量库）。
 *
 * 事实边界：
 * - 知识目录由本人配置（SL_MKI_DIR / config.knowledgeDir）；未配置 = 未连接，不编条目。
 * - 只读目录内的 Markdown 正文；索引与正文只留在内存，不写进产品状态。
 * - 返回片段必须带文件路径与行号，便于本人核对原文。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { mkiConfig, searchMki } from './mki.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next'])
const MAX_FILES = 300
const MAX_FILE_BYTES = 512 * 1024
const CHUNK_CHARS = 700
const CACHE_TTL_MS = 5 * 60 * 1000

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 中英混合的轻量分词：英文按词，中文按 2-gram（无依赖）。 */
export function tokens(query) {
  const out = new Set()
  const source = text(query).toLowerCase()
  for (const match of source.matchAll(/[a-z0-9_]{2,}/g)) out.add(match[0])
  for (const match of source.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    if (run.length <= 2) out.add(run)
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

function safeRelative(from, full) {
  const rel = relative(from, full).replace(/\\/g, '/')
  return rel.startsWith('..') || rel.includes(':') ? null : rel
}

/** 把正文切成带行号范围的块（按空行分段，超长再硬切）。 */
export function chunkMarkdown(body) {
  const lines = String(body ?? '').split(/\r?\n/)
  const chunks = []
  let current = []
  let start = 1
  const flush = (endLine) => {
    const content = current.join('\n').trim()
    if (content) chunks.push({ text: content, startLine: start, endLine })
    current = []
    start = endLine + 1
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) {
      if (current.join('\n').length >= CHUNK_CHARS) flush(i + 1)
      else current.push(line)
      continue
    }
    current.push(line)
    if (current.join('\n').length >= CHUNK_CHARS * 1.5) flush(i + 1)
  }
  if (current.join('\n').trim()) flush(lines.length)
  return chunks
}

function scan(dir) {
  const files = []
  const walk = (current, depth) => {
    if (depth > 3 || files.length >= MAX_FILES) return
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) { walk(full, depth + 1); continue }
      if (extname(entry.name).toLowerCase() !== '.md') continue
      const rel = safeRelative(dir, full)
      if (!rel) continue
      let info
      try { info = statSync(full) } catch { continue }
      let body = ''
      try {
        const raw = readFileSync(full)
        body = raw.subarray(0, Math.min(raw.length, MAX_FILE_BYTES)).toString('utf8')
      } catch { continue }
      files.push({
        id: rel,
        title: entry.name.replace(/\.md$/i, ''),
        path: full,
        relPath: rel,
        size: info.size,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
        chunks: chunkMarkdown(body),
      })
    }
  }
  walk(dir, 0)
  return files
}

/**
 * 建/取索引。返回：
 * { configured, state: 'connected'|'not_configured'|'empty'|'error', dir, files, totalChunks, error? }
 */
export function loadKnowledgeIndex(config, { now = Date.now(), force = false } = {}) {
  const dir = text(config?.knowledgeDir)
  if (!dir) {
    return { configured: false, state: 'not_configured', dir: '', files: [], totalChunks: 0 }
  }
  if (!existsSync(dir)) {
    return { configured: true, state: 'error', dir, files: [], totalChunks: 0, error: '知识目录不存在：' + dir }
  }
  const cache = config?.__knowledgeCache
  if (!force && cache && cache.dir === dir && now - cache.at < CACHE_TTL_MS) return cache.index
  const files = scan(dir)
  const totalChunks = files.reduce((sum, file) => sum + file.chunks.length, 0)
  const index = {
    configured: true,
    state: files.length === 0 ? 'empty' : 'connected',
    dir,
    files,
    totalChunks,
    indexedAt: new Date(now).toISOString(),
  }
  if (config && typeof config === 'object') config.__knowledgeCache = { dir, at: now, index }
  return index
}

function scoreChunk(chunk, title, queryTokens) {
  if (queryTokens.length === 0) return { score: 0, hitTokens: [] }
  const bodyLower = chunk.text.toLowerCase()
  const titleLower = String(title).toLowerCase()
  let score = 0
  const hitTokens = []
  for (const token of queryTokens) {
    const inTitle = titleLower.includes(token)
    let count = 0
    let index = bodyLower.indexOf(token)
    while (index !== -1 && count < 8) { count += 1; index = bodyLower.indexOf(token, index + token.length) }
    if (inTitle || count > 0) {
      hitTokens.push(token)
      score += (inTitle ? 3 : 0) + count
    }
  }
  return { score, hitTokens }
}

function snippetAround(content, hitTokens) {
  const lower = content.toLowerCase()
  let at = -1
  for (const token of hitTokens) {
    const index = lower.indexOf(token)
    if (index !== -1 && (at === -1 || index < at)) at = index
  }
  if (at === -1) return content.slice(0, 240)
  const start = Math.max(0, at - 100)
  const end = Math.min(content.length, at + 160)
  return (start > 0 ? '…' : '') + content.slice(start, end).replace(/\s+/g, ' ') + (end < content.length ? '…' : '')
}

/**
 * 检索知识正文。返回：
 * { ok, state, hits: [{ title, relPath, path, snippet, startLine, endLine, score }], indexedAt, totalChunks }
 * 没有命中时 hits=[] —— 空就是空，不编。
 */
export function searchLocalKnowledge(config, query, { limit = 5 } = {}) {
  const index = loadKnowledgeIndex(config)
  if (index.state === 'not_configured') {
    return { ok: false, state: 'not_configured', detail: '知识目录还没有配置（SL_MKI_DIR）。现在是未连接，不是没有知识。', hits: [] }
  }
  if (index.state === 'error') {
    return { ok: false, state: 'error', detail: index.error, hits: [] }
  }
  if (index.state === 'empty') {
    return { ok: true, state: 'empty', detail: '知识目录里还没有 Markdown 知识。', hits: [], indexedAt: index.indexedAt, totalChunks: 0 }
  }
  const queryTokens = tokens(query)
  if (queryTokens.length === 0) {
    return { ok: true, state: 'empty', detail: '这次没有可检索的关键词。', hits: [], indexedAt: index.indexedAt, totalChunks: index.totalChunks }
  }
  const scored = []
  for (const file of index.files) {
    for (const chunk of file.chunks) {
      const { score, hitTokens } = scoreChunk(chunk, file.title, queryTokens)
      if (score <= 0) continue
      scored.push({
        title: file.title,
        relPath: file.relPath,
        path: file.path,
        snippet: snippetAround(chunk.text, hitTokens),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score,
        modifiedAt: file.modifiedAt,
      })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return {
    ok: true,
    state: 'connected',
    indexedAt: index.indexedAt,
    totalChunks: index.totalChunks,
    hits: scored.slice(0, Math.max(1, Math.min(Number(limit) || 5, 10))),
  }
}

/**
 * 检索知识（对外唯一入口）：
 * 1) 配置了 MKI 服务 → 走服务（正式架构）；
 * 2) 未配置服务、但显式开启本地开发模式（SL_MKI_LOCAL=1）→ 扫本地 Markdown（仅开发用）；
 * 3) 都没有 → not_configured，诚实显示未连接。
 */
export async function searchKnowledge(config, query, { limit = 5 } = {}) {
  const mki = mkiConfig(config)
  if (mki.configured) {
    const result = await searchMki(config, query, { limit })
    return {
      ok: result.ok,
      state: result.state,
      detail: result.detail ?? '',
      source: 'mki-service',
      rulesVersion: result.rulesVersion ?? null,
      gaps: result.gaps ?? [],
      warnings: result.warnings ?? [],
      hits: (result.hits ?? []).map((hit) => ({
        title: hit.title,
        relPath: hit.source?.chapter || hit.source?.title || hit.source?.ref || '知识条目',
        path: hit.source?.url ?? null,
        snippet: hit.snippet,
        startLine: null,
        endLine: null,
        score: 1,
        verdict: hit.verdict,
      })),
    }
  }
  const localEnabled = String(process.env.SL_MKI_LOCAL ?? '') === '1' || config?.knowledgeLocalEnabled === true
  if (config?.knowledgeDir && localEnabled) {
    const local = searchLocalKnowledge(config, query, { limit })
    return { ...local, source: 'local-dir(dev)' }
  }
  return {
    ok: false,
    state: 'not_configured',
    detail: '知识服务还没有配置（MKI_BASE_URL / MKI_API_KEY）。现在是未连接，不是没有知识。',
    source: 'none',
    hits: [],
  }
}

/** 网络投影用的轻量摘要（不含正文）。 */
export function knowledgeSummary(config, limit = 6) {
  const mki = mkiConfig(config)
  if (mki.configured) {
    return { state: 'connected', source: 'mki-service', dir: mki.baseUrl, totalChunks: 0, indexedAt: null, files: [] }
  }
  const localEnabled = String(process.env.SL_MKI_LOCAL ?? '') === '1' || config?.knowledgeLocalEnabled === true
  if (!localEnabled) {
    return { state: 'not_configured', source: 'none', dir: '', totalChunks: 0, indexedAt: null, files: [] }
  }
  return { ...summaryFromLocalDir(config, limit), source: 'local-dir(dev)' }
}

function summaryFromLocalDir(config, limit = 6) {
  const index = loadKnowledgeIndex(config)
  return {
    state: index.state,
    dir: index.dir,
    totalChunks: index.totalChunks,
    indexedAt: index.indexedAt ?? null,
    files: index.files.slice(0, limit).map((file) => ({
      id: file.id,
      title: file.title,
      relPath: file.relPath,
      size: file.size,
      modifiedAt: file.modifiedAt,
      chunks: file.chunks.length,
    })),
  }
}
