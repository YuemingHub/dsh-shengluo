/**
 * 生络 — 路径解析。
 *
 * 用和 DSH 一致的优先级找 DSH home：$DSH_HOME → ~/.dsh。
 * 不 import @deepseek-ai/dsh-home-paths：本地 link 安装解析不到那个包；
 * 而且这里只用于「生络自己的数据目录」，不需要与 DSH 内部路径同源。
 * profile 目录从 ctx.get('profileContext') 读，读不到就算 null（不进 profile 的日常状态）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv) return fromEnv
  return join(homedir(), '.dsh')
}

export function shengluoDataDir(env = process.env) {
  return join(resolveDshHome(env), 'shengluo')
}

export function readProfileContext(ctx) {
  try {
    const profile = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
    if (!profile) return null
    return {
      name: typeof profile.name === 'string' ? profile.name : null,
      dir: typeof profile.dir === 'string' ? profile.dir : null,
      home: typeof profile.home === 'string' ? profile.home : null,
    }
  } catch {
    return null
  }
}
