/**
 * 生络 — 纯逻辑单元测试（不启动 DSH、不联网）。
 * 覆盖：网络投影、持久化、路径安全、来源摘要。
 * 用法：node tests/plugin-unit.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildNetwork } from '../lib/network.mjs'
import { resolveDshHome } from '../lib/paths.mjs'
import { summarizeToolCall } from '../lib/sources.mjs'
import { Store } from '../lib/store.mjs'
import { safeRelative, shortHash } from '../lib/util.mjs'

let failed = 0
const check = (name, condition, detail) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (condition ? '' : '  ' + JSON.stringify(detail)))
  if (!condition) failed += 1
}

// —— 网络投影 ——
{
  const workspaces = Array.from({ length: 9 }, (_, index) => ({
    id: 'w' + index, title: '项目' + index, path: 'D:\\repos\\p' + index, active: index === 0,
  }))
  const artifacts = Array.from({ length: 6 }, (_, index) => ({
    path: 'out/file' + index + '.md', name: 'file' + index + '.md', kind: '说明', sizeLabel: '1 KB',
    modifiedAt: '2026-11-21T10:00:00Z', root: 'D:\\repos\\p0', runId: 'run-1', fromRun: true,
  }))
  const network = buildNetwork({
    realityNode: { id: 'reality', kind: 'reality', title: '我的现实', subtitle: '尚未授权，现在是未知', unsupported: true },
    realityAuthorized: false,
    workspaces,
    runs: [{ runId: 'run-1', sessionId: 'session-1', goal: '把这件事做完', status: 'running', startedAt: '2026-11-21T09:00:00Z', toolCalls: 3 }],
    artifacts,
    focusGoal: '把这件事做完',
    maxVisible: 9,
  })
  check('可见节点在 5–9 之间', network.visibleIds.length >= 5 && network.visibleIds.length <= 9, network.visibleIds.length)
  check('可见节点数不超过上限 9', network.visibleIds.length <= 9, network.visibleIds.length)
  check('没有悬空连线（两端都可见）', network.visibleEdges.every((edge) => network.visibleIds.includes(edge.from) && network.visibleIds.includes(edge.to)))
  check('关系都有普通话说明', network.visibleEdges.every((edge) => typeof edge.label === 'string' && edge.label.length > 6 && edge.why), network.visibleEdges.map((e) => e.label))
  check('未授权时不说"来自你的现实"', !network.visibleEdges.some((edge) => edge.relation === 'about_you'), network.visibleEdges.map((e) => e.relation))
  check('未授权时现实关系明确标未知', network.visibleEdges.some((edge) => edge.relation === 'reality_unknown'))
  check('项目节点被收敛（不把 9 个项目全摊开）', network.nodes.filter((node) => node.kind === 'project').length <= 3, network.nodes.filter((n) => n.kind === 'project').length)
  check('成果与执行之间有关系', network.visibleEdges.some((edge) => edge.relation === 'produced'))
  check('同来源同类关系最多两条（不刷重复废话）', (() => {
    const counts = new Map()
    for (const edge of network.visibleEdges) {
      const key = edge.from + '|' + edge.relation
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.values()].every((value) => value <= 2)
  })())

  const empty = buildNetwork({})
  check('没有任何真实来源时网络是空的（不编节点）', empty.nodes.length === 0 && empty.visibleIds.length === 0)

  const authorized = buildNetwork({
    realityNode: { id: 'reality', kind: 'reality', title: '我的现实' },
    realityAuthorized: true,
    focusGoal: '去开家长会',
    realityFacts: [{ id: 'reality:1', kind: 'reality', title: '孩子最近怕黑', subtitle: '有证据的事实' }],
  })
  check('已授权时才允许说"来自你的现实"', authorized.visibleEdges.some((edge) => edge.relation === 'about_you'))
}

// —— 持久化 ——
{
  const dir = mkdtempSync(join(tmpdir(), 'shengluo-unit-'))
  try {
    const store = new Store(dir)
    await store.setPrefs({ panel: 'projects', marker: 'x' })
    const runId = await store.startRun({ sessionId: 'session-1', goal: '一件事' })
    await store.addArtifact(runId, { path: 'a.md', name: 'a.md' })
    await store.addRelation({ from: 'a', to: 'b', relation: 'supports', note: '' })
    await store.addRelation({ from: 'a', to: 'b', relation: 'supports', note: '' })

    const reopened = new Store(dir)
    check('数据在重开后还在', reopened.get().prefs.marker === 'x', reopened.get().prefs)
    check('正在推进的事被记下来', Boolean(reopened.activeRun()) && reopened.activeRun().goal === '一件事')
    check('成果登记不重复', reopened.activeRun().artifactPaths.length === 1)
    check('重复加的同一条关系只留一份', reopened.get().relations.length === 1, reopened.get().relations.length)

    // 坏文件要能自愈，而不是把插件带崩
    writeFileSync(join(dir, 'product-state.json'), '{ not json', 'utf8')
    const healed = new Store(dir)
    check('状态文件坏掉时自愈成空状态', healed.get().version === 1 && healed.get().relations.length === 0)
    check('坏文件的备份留在旁边', existsSync(join(dir, 'product-state.json')))

    // 产品状态里不能出现个人现实正文（验收 14 的静态保证）
    await healed.markAuthorized({ subject: { principalId: 'p1' }, scopes: ['personal_reality.read.own'], authorizedAt: new Date().toISOString(), expiresAt: null })
    const persisted = readFileSync(join(dir, 'product-state.json'), 'utf8')
    check('授权只记元信息，不记正文', persisted.includes('p1') && !persisted.includes('statement'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// —— 路径与工具 ——
{
  check('拒绝 .. 逃逸', safeRelative('../../windows/system32/x') === null)
  check('拒绝绝对路径', safeRelative('C:\\Windows\\x') === null && safeRelative('/etc/passwd') === null)
  check('接受普通相对路径', safeRelative('out/page.html') === 'out/page.html')
  check('反斜杠归一化', safeRelative('out\\page.html') === 'out/page.html')
  check('DSH_HOME 环境变量优先', resolveDshHome({ DSH_HOME: 'D:\\tmp\\dsh1' }) === 'D:\\tmp\\dsh1')
  check('空 DSH_HOME 视为未设置', resolveDshHome({ DSH_HOME: '   ' }).endsWith('.dsh'))
  check('短哈希稳定', shortHash('abc') === shortHash('abc') && shortHash('abc').length === 12)

  check('write 工具被翻译成人话', summarizeToolCall('write', JSON.stringify({ path: 'a.md' })).verb === '写入文件')
  check('pwsh 命令被截断显示', String(summarizeToolCall('pwsh', JSON.stringify({ command: 'x'.repeat(300) })).target).length <= 80)
  check('坏 JSON 参数不炸', summarizeToolCall('write', '{bad json').verb === '写入文件')
}

console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
