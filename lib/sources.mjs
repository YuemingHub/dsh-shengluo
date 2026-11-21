/**
 * 生络 — 真实来源读取。
 *
 * 每条来源都对应一个权威：项目 = DSH workspace（项目仓库本身）；
 * 执行 = DSH 原生会话；成果 = 工作区文件；知识 = MKI 目录；目标 = DSH goal 服务。
 * 读不到就返回空数组并给出原因，不编。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

import { safeRelative, text } from './util.mjs'

const OPENABLE = new Set(['.html', '.htm', '.md', '.txt', '.json', '.csv', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.pdf'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.cache', '.turbo', 'target', '__pycache__', '.venv'])

const sizeLabel = (bytes) => {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

const kindOf = (path) => {
  const ext = extname(path).toLowerCase()
  if (ext === '.html' || ext === '.htm') return '页面'
  if (ext === '.md') return '说明'
  if (ext === '.json') return '数据'
  if (ext === '.csv') return '表格'
  if (['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) return '图片'
  if (ext === '.pdf') return '文档'
  return '文件'
}

/** DSH 原生项目（workspace registry）。 */
export function readWorkspaces(ctx, activeCwd) {
  const out = []
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    const list = registry && typeof registry.list === 'function' ? registry.list() : []
    for (const workspace of list) {
      const path = text(workspace?.path)
      if (!path) continue
      out.push({
        id: text(workspace?.id) || path,
        title: text(workspace?.title) || path.split(/[\\/]/).filter(Boolean).pop() || path,
        path,
        openedAt: Number(workspace?.createdAt ?? workspace?.updatedAt ?? 0) || null,
        active: activeCwd ? path === activeCwd : false,
      })
    }
  } catch {
    return []
  }
  if (out.length === 0 && activeCwd) {
    out.push({ id: activeCwd, title: activeCwd.split(/[\\/]/).filter(Boolean).pop() || activeCwd, path: activeCwd, openedAt: null, active: true })
  }
  return out.slice(0, 12)
}

/** DSH 原生 goal（绑定在真实会话上）。字段做防御式读取，读不到就跳过这一条。 */
export function readGoals(ctx, limit = 6) {
  const out = []
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    const goals = typeof ctx.get === 'function' ? ctx.get('goals') : undefined
    if (!agents || typeof agents.list !== 'function' || !goals || typeof goals.get !== 'function') return out
    for (const agent of agents.list()) {
      try {
        const goal = goals.get(agent)
        if (!goal) continue
        const title = text(goal.title) || text(goal.objective) || text(goal.text) || null
        if (!title) continue
        out.push({
          sessionId: text(agent?.id),
          title,
          status: text(goal.status) || null,
          percent: typeof goal.percent === 'number' ? goal.percent : null,
          at: text(goal.createdAt) || null,
        })
      } catch {
        continue
      }
    }
  } catch {
    return []
  }
  return out.slice(0, limit)
}

/** 知识来源：配置的 MKI 目录里的 markdown。没有目录就是没有，不编条目。 */
export function readKnowledge(config, limit = 6) {
  const dir = text(config?.knowledgeDir)
  if (!dir || !existsSync(dir)) return []
  const out = []
  try {
    const walk = (current, depth) => {
      if (depth > 2 || out.length >= limit) return
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (out.length >= limit) return
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
        const full = join(current, entry.name)
        if (entry.isDirectory()) { walk(full, depth + 1); continue }
        if (extname(entry.name).toLowerCase() !== '.md') continue
        let size = 0
        let modifiedAt = null
        try {
          const info = statSync(full)
          size = info.size
          modifiedAt = new Date(info.mtimeMs).toISOString()
        } catch { continue }
        const rel = safeRelative(relative(dir, full)) ?? entry.name
        out.push({
          id: rel,
          title: entry.name.replace(/\.md$/i, ''),
          label: 'MKI',
          uri: full,
          sizeLabel: sizeLabel(size),
          at: modifiedAt,
        })
      }
    }
    walk(dir, 0)
  } catch {
    return []
  }
  return out
}

/** 工作区成果：在给定目录里找近期可打开的文件。权威是文件本身。 */
export function scanArtifacts({ roots = [], since = 0, limit = 8, runId = null } = {}) {
  const found = []
  const walk = (current, root, depth) => {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (found.length >= limit * 4) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) { walk(full, root, depth + 1); continue }
      const ext = extname(entry.name).toLowerCase()
      if (!OPENABLE.has(ext)) continue
      let info
      try { info = statSync(full) } catch { continue }
      if (!info.isFile()) continue
      if (since && info.mtimeMs < since) continue
      const rel = safeRelative(relative(root, full)) ?? entry.name
      found.push({
        path: rel,
        absolutePath: full,
        name: entry.name,
        kind: kindOf(rel),
        size: info.size,
        sizeLabel: sizeLabel(info.size),
        modifiedAt: new Date(info.mtimeMs).toISOString(),
        root,
        runId,
      })
    }
  }
  for (const root of roots) {
    if (root && existsSync(root)) walk(root, root, 0)
  }
  return found
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
    .slice(0, limit)
}

/** 把 tool/call 事件里真实发生的工具名折叠成「这次做了什么」，只用于展示，不冒充结果。 */
export function summarizeToolCall(name, argsJson) {
  let args = null
  try { args = argsJson ? JSON.parse(argsJson) : null } catch { args = null }
  const path = text(args?.path) || text(args?.file_path) || text(args?.filePath) || ''
  switch (name) {
    case 'write': return { verb: '写入文件', target: path }
    case 'edit': return { verb: '修改文件', target: path }
    case 'read': return { verb: '读取资料', target: path }
    case 'glob': return { verb: '查找文件', target: text(args?.pattern) }
    case 'grep': return { verb: '查找内容', target: text(args?.pattern) }
    case 'pwsh':
    case 'bash': return { verb: '执行命令', target: text(args?.command).slice(0, 80) }
    case 'web_search': return { verb: '查资料', target: text(args?.query ?? args?.queries?.[0]) }
    case 'web_fetch': return { verb: '打开网页', target: text(args?.url) }
    case 'subagent': return { verb: '交给子 Agent', target: text(args?.description ?? args?.prompt).slice(0, 60) }
    case 'present': return { verb: '交付文件', target: path }
    default: return { verb: name || '工具调用', target: path }
  }
}
