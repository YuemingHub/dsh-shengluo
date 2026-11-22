/**
 * 生络 — Agent Space 项目登记（只读）。
 *
 * 唯一来源：`agent-workspace/00_索引/项目登记.md`。
 * 只做两件事：把「这件事属于哪个项目、真源在哪、下一步去哪看」读出来；
 * 不复制项目状态（SHA / 部署 / 进度都不在这里）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 默认登记表位置：用户目录下的 Agent Space 挂载点。
 * 不写死任何机器的盘符/绝对路径；换机器时只要把 Agent Space 挂到同一相对位置即可。
 */
export function defaultRegistryPath(env = process.env) {
  if (text(env?.SL_AGENT_SPACE_REGISTRY)) return text(env.SL_AGENT_SPACE_REGISTRY)
  return join(homedir(), '.agent-space', '00_索引', '项目登记.md')
}

/** 兼容旧引用：保留常量名，但值改为函数式默认路径。 */
export const DEFAULT_REGISTRY_PATH = defaultRegistryPath()

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanCell(cell) {
  return String(cell ?? '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitRow(line) {
  const parts = line.split('|')
  if (parts.length < 5) return null
  return parts.slice(1, -1).map(cleanCell)
}

/**
 * 解析项目登记。返回：
 * { state:'connected'|'not_configured'|'error', path, at, routes:[{say, repo, nextAt}], projects:[{name, oneLine, repo, whereToLook}] }
 */
export function readProjectRegistry(config = {}) {
  const path = text(config.agentSpaceRegistry) || defaultRegistryPath()
  if (!existsSync(path)) {
    return { state: 'not_configured', path, routes: [], projects: [], at: null, error: '项目登记文件不存在' }
  }
  let body = ''
  let mtime = null
  try {
    body = readFileSync(path, 'utf8')
    mtime = new Date(statSync(path).mtimeMs).toISOString()
  } catch (error) {
    return { state: 'error', path, routes: [], projects: [], at: null, error: '读不到项目登记：' + (error && error.message) }
  }

  const routes = []
  const projects = []
  let section = ''
  for (const line of body.split(/\r?\n/)) {
    if (/^###?\s+/.test(line)) section = cleanCell(line.replace(/^#+\s*/, ''))
    if (!line.trim().startsWith('|')) continue
    const cells = splitRow(line)
    if (!cells || cells.length < 3) continue
    if (/^-+$|^:?-+:?$/.test(cells[0]) || cells[0] === '你说' || cells[0] === '项目') continue
    // 路由表：你说 / 去哪个仓 / 下一步在哪
    if (cells.length >= 3 && /YuemingHub|知识库|项目仓/.test(cells[1] ?? '') && section.includes('一句话开工')) {
      routes.push({ say: cells[0], repo: cells[1], nextAt: cells[2] })
      continue
    }
    // 分类总表：项目 / 一句话 / 真源 / 现状去哪看
    if (cells.length >= 4 && cells[1]) {
      projects.push({ name: cells[0], oneLine: cells[1], repo: cells[2], whereToLook: cells[3], category: section })
    }
  }

  return {
    state: 'connected',
    path,
    at: mtime,
    routes: routes.slice(0, 40),
    projects: projects.slice(0, 60),
  }
}

/** 按关键词在登记表里找项目（名称/一句话/仓库名）。空查询返回前几个。 */
export function matchProjects(registry, query, limit = 5) {
  if (!registry || registry.state !== 'connected') return []
  const q = text(query).toLowerCase()
  const tokens = q ? q.split(/[\s,，。、]+/).filter((token) => token.length >= 2) : []
  const score = (item) => {
    if (!q) return 1
    const haystack = [item.name, item.oneLine, item.repo, item.whereToLook].join(' ').toLowerCase()
    if (!tokens.length) return haystack.includes(q) ? 2 : 0
    return tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
  }
  return registry.projects
    .map((item) => ({ item, value: score(item) }))
    .filter((entry) => entry.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((entry) => entry.item)
}
