# 生络 ShengLuo · DSH 原生插件

以人为单位的个人智能伙伴。安装后在 DSH 侧边栏提供「生络」入口。

## 来源与发行

- 唯一源码：YuemingHub/ShengLuo 的 packages/shengluo-dsh-plugin/
- 发行仓：YuemingHub/dsh-shengluo（只接收主仓生成的发行内容，不独立开发）
- 发行候选由主仓 scripts/build-plugin-release.mjs 生成，带 MANIFEST.sha256.json。

## 安装

要求 DeepSeek Harness 0.2.2-rc.5（engines.dsh: >=0.2.2-rc.5 <0.3.0-0）。

在 DSH 中通过插件管理器从本地目录或发行仓安装；本机安装需保留可回滚备份。

## 边界

- 不新建 Runtime、调度器、图数据库、第二个 PRK 或第二套知识系统。
- 使用 DSH 原生 Session、工具、审批、Agent、Skills、MCP 与调度能力。
- Family Space 只读；MKI 独立；不改 Family Space 业务与授权范围。
