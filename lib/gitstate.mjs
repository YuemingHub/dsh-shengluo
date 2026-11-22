/**
 * 生络 — 项目改动指纹（只取指纹/路径，不保存 diff 正文）。
 *
 * before/after 都只含：HEAD、status 哈希、diff 哈希、变更文件路径。
 * 用于 workloop 判断「这次到底有没有改项目」，不靠模型自称。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const run = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8',
  timeout: 3000,
  windowsHide: true,
  maxBuffer: 4 * 1024 * 1024,
}).trim()

const sha1 = (value) => createHash('sha1').update(String(value ?? '')).digest('hex')

export function gitState(cwd) {
  if (!cwd) return null
  try {
    const head = run(cwd, ['rev-parse', 'HEAD'])
    const status = run(cwd, ['status', '--porcelain'])
    const diff = run(cwd, ['diff', '--no-color', '--no-ext-diff'])
    const changed = status ? status.split(/\r?\n/).filter(Boolean).slice(0, 12) : []
    return {
      head,
      statusHash: sha1(status),
      diffHash: sha1(diff),
      dirty: changed.length > 0,
      changed,
    }
  } catch {
    return null
  }
}

export function gitChanged(before, after) {
  if (!before || !after) return false
  return before.head !== after.head || before.statusHash !== after.statusHash || before.diffHash !== after.diffHash
}
