/**
 * 生络 — DSH 原生会话接口的能力探测与会话参数构造。
 *
 * 设计原则：
 * - 会话创建/续接用 DSH 原生接口，不自己造 Runtime；
 * - 启动时先检查接口是否真的可用（不是“目录里有这个服务”就算可用）；
 * - 不可用时如实报错，不静默降级到别的方式。
 */

/** 生络面板使用的 DSH Agent preset。 */
export const SHENGLUO_PRESET = 'shengluo'

/**
 * 检查会话接口是否具备生络需要的能力。
 * @param {unknown} api ctx.sessions（Client）或 sessionController（Host）
 * @returns {{ available: boolean, canCreate: boolean, canRetain: boolean, ok: boolean, missing: string[], detail: string|null }}
 */
export function sessionApiCapability(api, { requireRetain = true } = {}) {
  const available = Boolean(api) && typeof api === 'object'
  const canCreate = available && typeof api.create === 'function'
  const canRetain = available && typeof api.retain === 'function'
  const missing = []
  if (!available) missing.push('sessions')
  else {
    if (!canCreate) missing.push('create')
    if (requireRetain && !canRetain) missing.push('retain')
  }
  return {
    available,
    canCreate,
    canRetain,
    ok: available && canCreate && (!requireRetain || canRetain),
    requiresRetain: requireRetain,
    missing,
    detail: available
      ? (missing.length ? '缺少会话接口：' + missing.join(', ') : null)
      : '当前 DSH 没有提供会话服务',
  }
}

/**
 * 生络创建会话时使用的参数。
 * 只带 DSH 公开契约里的字段：agentPreset、cwd（可选）。
 * @param {{ cwd?: string|null, preset?: string }} input
 */
export function sessionCreateOptions({ cwd = null, preset = SHENGLUO_PRESET } = {}) {
  const options = { agentPreset: preset }
  if (typeof cwd === 'string' && cwd.trim()) options.cwd = cwd.trim()
  return options
}

/**
 * 探测某个 Agent preset 是否已注册（Host 侧，异步）。
 * 返回结构固定，不抛错：面板/健康检查要能稳定展示。
 * @param {unknown} agentPresets ctx.get('agentPresets')
 * @param {string} name
 */
export async function probePreset(agentPresets, name = SHENGLUO_PRESET) {
  if (!agentPresets || typeof agentPresets.resolve !== 'function') {
    return { name, registered: null, detail: '当前 DSH 没有提供 agentPresets 服务' }
  }
  try {
    const preset = await agentPresets.resolve(name)
    return { name, registered: Boolean(preset), detail: preset ? null : 'preset 未注册' }
  } catch (error) {
    return { name, registered: false, detail: String(error && error.message ? error.message : error) }
  }
}
