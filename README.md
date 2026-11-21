# 生络 ShengLuo — DeepSeek Harness 原生插件

以人为单位的个人智能伙伴。装进 DSH 之后，左侧栏只有一个「生络」入口，点进去是一块网络主面板：

- 中间一个生络智能核心，围绕它默认 5–9 个与当前这件事有关的真实节点（你的现实 / 项目 / 目标 / 执行 / 成果 / 待你决定 / 知识），关系用普通话说清楚；
- 右侧是「当前正在处理的事情、我现在的理解、用了哪些现实和资料、下一步、待你决定」；
- 底部一句「今天你想推进什么？」→ 先给三行契约（我会用到 / 我会交付 / 需要你定）→ 你点头才动手。

执行全部借用 DSH 原生能力：原生会话、原生工具调用、**原生审批**（到会话里允许或拒绝）、原生文件预览、
原生 Agent preset（「生络伙伴」）、原生插件管理。插件不自己造任务系统，也不接管执行。

## 安装

要求：DeepSeek Harness **0.2.2-rc.5**（`engines.dsh: >=0.2.2-rc.5 <0.3.0-0`）。

**方式一：从本仓库装（GitHub 地址）**

DSH → 左侧「插件」→「添加插件」→ 粘贴：

```
https://github.com/YuemingHub/dsh-shengluo
```

> 私有仓库时只有本机登录过 GitHub 的环境能装。想给别人用就把仓库设为 public。

**方式二：本地目录**

```
DSH → 插件 → 添加插件 → 粘贴本机这个文件夹的绝对路径
```

装完在「已安装插件」里看到 **生络**，左侧栏出现入口。没出现就重启一次 DSH。

## 连接个人现实（Family Space）

个人现实走**只读**的设备授权，插件永远不接触 Family Space 的登录 Cookie：

1. 面板右侧点「连接家庭空间」→ 浏览器打开 `https://ymai.love/connect/shengluo`；
2. 用你自己的 Family Space 账号登录，看清申请的两个范围（读取你自己的对话、使用你自己的个人现实）再同意；
3. 插件轮询拿到令牌（15 分钟，自动刷新），之后按任务检索个人现实；
4. 撤回：面板里点「撤回」，或 Family Space → 我的 → 隐私和数据 → 生络连接授权。

边界：只请求 `conversation.read.own` 与 `personal_reality.read.own`；别人的私人对话、孩子本人直接表达、
老师/外部转述都不会从接口出来（服务端与本插件两侧都拦）。未授权时个人现实显示「未知」，不猜、不填。

## 支持的 DSH 版本

0.2.2-rc.5 实测。DSH 的插件接口还没冻结，升级后请跑一次 `npm test` 并手点一遍侧栏入口。
不承诺上游升级后永远免维护。

## 开发

```bash
npm test                 # 单元逻辑 + Family Space 集成契约（跑本地替身，不需要网络）
npm run build:client     # client.src.js → client.js
node tests/family-space-live.mjs   # 真连线上 ymai.love（开码与错误语义；授权后的读取需本人点同意）
```

面板 UI 源码在 `client.src.js`（纯 JS，`window.__ModuleLoader__.load` 格式，无打包步骤）；
Host 半个在 `index.js` + `lib/`。数据权威：个人现实在 Family Space、执行过程在 DSH 原生会话、
成果在工作区文件、网络关系与界面偏好是可重建的产品层投影。

## 许可

MIT
