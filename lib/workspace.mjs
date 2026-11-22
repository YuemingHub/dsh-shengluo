/**
 * 生络 — 会话工作区解析（产品级安全边界）。
 *
 * 规则：
 * - 只允许在显式声明的 roots 内建会话；
 * - 没有显式选择就报错，**绝不静默回退到当前活动工作区**（2026-11-23 真实事故）；
 * - 越界/不存在都明确报错，调用方必须展示原因。
 */
import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const WORKSPACE_ERROR = {
  NO_ROOTS: 'no_workspace_roots',
  NOT_SELECTED: 'no_workspace_selected',
  NOT_ALLOWED: 'workspace_not_allowed',
  NOT_FOUND: 'workspace_not_found',
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** target 是否在 root 内（含 root 本身）。 */
export function isWithin(root, target) {
  if (!root || !target) return false
  const r = resolve(root)
  const t = resolve(target)
  if (samePath(r, t)) return true
  const back = relative(r, t)
  return Boolean(back) && !back.startsWith('..') && !isAbsolute(back)
}

/**
 * 解析本次运行的工作区。
 * @param {{ requested?: string|null, defaultCwd?: string|null, roots?: string[] }} input
 * @returns {{ ok: boolean, cwd?: string, root?: string, code?: string, detail?: string }}
 */
export function resolveRunCwd({ requested = null, defaultCwd = null, roots = [] } = {}) {
  const cleaned = (Array.isArray(roots) ? roots : []).map((item) => String(item ?? '').trim()).filter(Boolean)
  if (cleaned.length === 0) {
    return { ok: false, code: WORKSPACE_ERROR.NO_ROOTS, detail: '没有配置允许运行的工作区根目录（SL_RUN_WORKSPACE_ROOTS）；已拒绝运行，避免落到别的工作区。' }
  }
  const candidate = String(requested ?? '').trim() || String(defaultCwd ?? '').trim()
  if (!candidate) {
    return { ok: false, code: WORKSPACE_ERROR.NOT_SELECTED, detail: '这次没有选定工作区；已拒绝运行，不会静默回退到当前活动工作区。' }
  }
  const target = resolve(candidate)
  const root = cleaned.find((item) => isWithin(item, target))
  if (!root) {
    return { ok: false, code: WORKSPACE_ERROR.NOT_ALLOWED, detail: '工作区不在允许的范围内：' + target }
  }
  if (!existsSync(target)) {
    return { ok: false, code: WORKSPACE_ERROR.NOT_FOUND, detail: '工作区不存在：' + target }
  }
  return { ok: true, cwd: target, root: resolve(root) }
}

/** 给界面/健康检查看的公开信息（不含凭据）。 */
export function describeRunWorkspace({ defaultCwd = null, roots = [] } = {}) {
  return { defaultCwd: String(defaultCwd ?? '') || null, roots: (Array.isArray(roots) ? roots : []).map(String) }
}
