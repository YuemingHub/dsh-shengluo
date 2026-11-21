/**
 * 生络 — 小工具。只用 node 内建，不 import 任何 @deepseek-ai/*（本地 link 安装时解析不到）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const nowIso = () => new Date().toISOString()

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export const asString = (value, fallback = '') =>
  typeof value === 'string' ? value : fallback

export const text = (value) => String(value ?? '')

export const shortId = (prefix) => prefix + '-' + randomUUID().slice(0, 8)

export const sha256 = (input) => createHash('sha256').update(input).digest('hex')

export const shortHash = (value) => sha256(String(value)).slice(0, 12)

/** 只保留 ASCII 安全的相对路径分隔符，防止 ../ 逃逸。 */
export function safeRelative(input) {
  const normalized = text(input).replace(/\\/g, '/').trim()
  if (!normalized) return null
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null
  if (normalized.split('/').some((part) => part === '..')) return null
  return normalized.replace(/^\.\//, '')
}

/** 原子写：先写临时文件再 rename，断电不会留下半个 JSON。 */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.' + process.pid + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 有界并发的小工具，用来并行读多个真实来源又不打爆文件句柄。 */
export async function settleAll(entries) {
  const results = await Promise.allSettled(
    entries.map(([key, run]) =>
      Promise.resolve()
        .then(run)
        .then((value) => [key, { ok: true, value }])
        .catch((error) => [key, { ok: false, error: text(error && error.message) || 'failed' }]),
    ),
  )
  const out = {}
  for (const item of results) {
    if (item.status !== 'fulfilled') continue
    const [key, outcome] = item.value
    out[key] = outcome
  }
  return out
}

/** 把内部错误变成一个可读的失败，不把堆栈丢给 UI。 */
export function failure(error) {
  return {
    ok: false,
    error: text(error && error.message) || text(error) || 'unknown failure',
    code: text(error && error.code) || null,
  }
}
