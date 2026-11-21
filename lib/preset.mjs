/**
 * 生络 DSH plugin — preset 那一行。
 *
 * 和 DSH 自带的 @deepseek-ai/dsh-agent-preset 一个形状，但只用全局 Symbol，
 * 不从 @deepseek-ai/* 里 import：本地 link: 安装时插件目录在 DSH 目录之外，
 * 那些包解析不到，import 一次整行就起不来，清单里根本没有这个 preset。
 */
export default class ShengluoPreset {
  static inject = ['agentPresets']
  /** 子插件配置原样留着，等各自激活时再由 loader 解析（官方 EntryGroup.key）。 */
  static [Symbol.for('cordis.group')] = true

  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  async * [Symbol.for('cordis.init')]() {
    yield await this.ctx.agentPresets.register(this.config)
  }
}
