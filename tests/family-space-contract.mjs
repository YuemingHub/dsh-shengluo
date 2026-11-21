/**
 * 生络 — Family Space 集成契约测试（插件侧，对齐线上 v1 契约）。
 *
 * 直接驱动 lib/family-space.mjs 打本地替身（tests/family-space-mock.mjs）。
 * 替身严格镜像线上契约，所以这份测试断言的是"插件这一侧照线上契约做对了"。
 * 真连线上、且不需要家长登录的那部分，由 tests/family-space-live.mjs 覆盖。
 *
 * 用法：node tests/family-space-contract.mjs
 */
import { existsSync, writeFileSync } from 'node:fs'

import { FamilySpace } from '../lib/family-space.mjs'
import { startMockFamilySpace } from './family-space-mock.mjs'

const results = []
const check = (name, condition, detail = {}) => {
  // detail 里也可能有 ok 字段，所以 ok 必须最后写，否则会覆盖断言结果。
  results.push({ ...detail, name, ok: Boolean(condition) })
  console.log((condition ? '  ✓ ' : '  ✗ ') + name + (condition ? '' : '  ' + JSON.stringify(detail)))
  return Boolean(condition)
}

function fakeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key)
      else records.set(key, JSON.parse(JSON.stringify(next)))
      return records.get(key)
    },
    async deleteRecord(key) { records.delete(key) },
  }
}

function fakeStore() {
  const state = {
    installationId: 'dsh-installation-test-0001',
    reality: { state: 'unauthorized', subject: null, scopes: [], authorizedAt: null, expiresAt: null, lastQueriedAt: null, lastError: null },
  }
  const snapshot = () => JSON.parse(JSON.stringify(state))
  return {
    state,
    get: () => state,
    realityMeta: () => snapshot().reality,
    async markAuthorized({ subject, scopes, authorizedAt, expiresAt }) {
      state.reality = { state: 'authorized', subject: subject ?? null, scopes: scopes ?? [], authorizedAt: authorizedAt ?? new Date().toISOString(), expiresAt: expiresAt ?? null, lastQueriedAt: state.reality.lastQueriedAt, lastError: null }
    },
    async markRealityState(next, lastError = null) {
      state.reality.state = next
      state.reality.lastError = lastError
      if (next !== 'authorized') { state.reality.subject = null; state.reality.scopes = [] }
    },
    async markQueried() { state.reality.lastQueriedAt = new Date().toISOString() },
  }
}

const GRANT_KEY = 'shengluo/family-space-grant'
const INSTALLATION = 'dsh-installation-test-0001'

async function run() {
  const mock = await startMockFamilySpace({ interval: 1, slowDownOnce: true })
  const credentials = fakeCredentials()
  const store = fakeStore()
  const ctx = { credentials }
  const client = new FamilySpace({ ctx, store, config: { baseUrl: mock.url }, logger: { warn() {} } })

  try {
    console.log('\n[1] 未授权时的默认状态')
    const before = await client.status()
    check('未授权时 state=unauthorized', before.state === 'unauthorized', before)
    const deniedQuery = await client.queryReality({ task: '今晚讲什么故事' })
    check('未授权时查现实返回 not_authorized，而不是空结果冒充「没有」',
      deniedQuery.ok === false && deniedQuery.code === 'not_authorized', deniedQuery)

    console.log('\n[2] 设备授权：开码 → 轮询 → 批准 → 拿 token（线上信封）')
    const started = await client.beginDeviceAuth()
    check('device 回包按 data 信封解析出 user_code',
      typeof started.userCode === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(started.userCode), { userCode: started.userCode })
    check('device 带回可一键打开的授权链接', String(started.verificationUriComplete).includes('user_code=' + encodeURIComponent(started.userCode)), started.verificationUriComplete)
    check('device_code 不出现在给 UI 的对象里（只留内存）',
      !('deviceCode' in started) && !JSON.stringify(started).includes('test_dc_'), Object.keys(started))
    check('把服务端给的范围说明（中文标签）带回来给界面用',
      Array.isArray(started.requestedScopeLabels) && started.requestedScopeLabels.length === 2, started.requestedScopeLabels)
    check('只申请两个 .own scope，没有更宽范围',
      JSON.stringify(started.requestedScopeLabels.map((label) => label.id)).includes('conversation.read.own')
      && !JSON.stringify(started).includes('family.'), started.requestedScopeLabels.map((label) => label.id))

    let sawSlowDown = null
    let pendingSeen = false
    let linked = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const step = await client.pollDeviceAuth()
      if (step.state === 'pending') {
        pendingSeen = true
        if (step.code === 'slow_down') sawSlowDown = step
        if (attempt === 1) await mock.approve()
        continue
      }
      linked = step
      break
    }
    check('未批准时是 pending，不是错误', pendingSeen)
    check('slow_down 被当成正常状态并按服务端给的 interval 放慢',
      Boolean(sawSlowDown) && (sawSlowDown.interval ?? 0) >= 6, sawSlowDown ?? '没有观察到 slow_down')
    check('批准后拿到 token（state=linked）', linked?.state === 'linked', linked)

    const grant = credentials.records.get(GRANT_KEY)?.payload
    check('token 落在 DSH 凭据库，不在产品状态里',
      Boolean(grant?.accessToken) && !JSON.stringify(store.state).includes(String(grant?.accessToken)))
    check('凭据记住 refresh_token 与安装实例，刷新/撤回都需要它',
      Boolean(grant?.refreshToken) && grant?.installationId === INSTALLATION, { installationId: grant?.installationId })
    check('scope 只有两个 .own，没有家庭级/冒充孩子',
      Array.isArray(grant?.scopes) && grant.scopes.length === 2 && !grant.scopes.some((scope) => /family|child|impersonat/.test(scope)), grant?.scopes)

    const after = await client.status()
    check('授权后 state=authorized', after.state === 'authorized', after)

    console.log('\n[3] 按任务读个人现实（线上 /context/query 形状）')
    const reality = await client.queryReality({ task: '今晚给孩子讲睡前故事，别太吓人', limit: 10 })
    check('查询成功且带回 personal_reality', reality.ok === true && reality.results.length > 0, { count: reality.results?.length })
    const fact = reality.results.find((item) => item.factStatus === 'fact' || item.factStatus === 'owner_said')
    check('每条带 factStatus / 来源 / 事件时间 / 归属',
      Boolean(fact) && Boolean(fact.source?.label) && Boolean(fact.time?.eventTime) && fact.assertedBy === 'owner', fact)
    check('服务端自带的中文 status_label 被原样保留（不另编一套说法）',
      Boolean(fact?.statusLabel), fact?.statusLabel)
    check('稳定 id 与可回溯的 conversation_id 都在',
      Boolean(fact?.id) && Boolean(fact?.source?.conversationId), { id: fact?.id, conversationId: fact?.source?.conversationId })
    check('ai_summary / inference 被标成推断，不会当事实用',
      reality.results.some((item) => item.factStatus === 'inference'), reality.results.map((item) => item.factStatus))
    check('verbatim_quote=true 的条目被标成本人原话', reality.results.some((item) => item.verbatimQuote === true && item.factStatus === 'owner_said'), reality.results.map((item) => [item.factStatus, item.verbatimQuote]))
    check('返回里带本人 person_id（用于界面显示当前账号）',
      Boolean(reality.personId) && store.state.reality.subject?.principalId === reality.personId, { personId: reality.personId })

    console.log('\n[4] 读对话证据：本人可读、别人的读不到')
    const own = await client.readConversation(fact.source.conversationId)
    check('本人有权访问的对话读得到逐字原文', own.ok === true && own.conversation.messages.length > 0, { count: own.conversation?.messages?.length })
    check('消息带说话人与时间（user=本人，assistant=家明）',
      own.conversation?.messages?.[0]?.speakerRef === 'self'
      && own.conversation?.messages?.some((message) => message.speakerRef === 'ai')
      && Boolean(own.conversation?.messages?.[0]?.at), own.conversation?.messages?.map((m) => [m.speakerRef, m.at]))
    const foreign = await client.readConversation('conv_other_1')
    check('别人的私人对话读不到（404，不泄露存在性）', foreign.ok === false && foreign.code === 'not_found', foreign)
    check('读不到时响应里没有任何正文', !('conversation' in foreign) && !JSON.stringify(foreign).includes('不该被读到'), Object.keys(foreign))

    console.log('\n[5] 安装实例绑定（线上强制 X-Shengluo-Installation）')
    // 直接在 HTTP 层验：同一个 token，换安装实例头必须被服务端拒绝。
    const liveToken = credentials.records.get(GRANT_KEY).payload.accessToken
    const withWrongInstallation = await fetch(mock.url + '/context/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + liveToken, 'x-shengluo-installation': 'another-installation-9999' },
      body: JSON.stringify({ task: '换安装实例还能读吗', limit: 5 }),
    })
    const withRightInstallation = await fetch(mock.url + '/context/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + liveToken, 'x-shengluo-installation': INSTALLATION },
      body: JSON.stringify({ task: '原安装实例还能读吗', limit: 5 }),
    })
    const withoutInstallation = await fetch(mock.url + '/context/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + liveToken },
      body: JSON.stringify({ task: '不带安装实例', limit: 5 }),
    })
    check('换安装实例头被服务端拒绝（401）', withWrongInstallation.status === 401, { status: withWrongInstallation.status })
    check('不带安装实例头也被拒绝', withoutInstallation.status === 400 || withoutInstallation.status === 401, { status: withoutInstallation.status })
    check('原安装实例可以正常读取', withRightInstallation.status === 200, { status: withRightInstallation.status })

    console.log('\n[6] 没有把个人现实正文写进本地产品状态（验收 14）')
    const persisted = JSON.stringify(store.state)
    check('产品状态里没有出现现实正文', !persisted.includes('小夜灯') && !persisted.includes('怕黑'), persisted.slice(0, 200))

    console.log('\n[7] token 快过期 → 用 refresh 自动续（线上 15 分钟寿命）')
    const expiredGrant = { ...credentials.records.get(GRANT_KEY).payload, expiresAt: new Date(Date.now() - 60_000).toISOString() }
    await credentials.modifyRecord(GRANT_KEY, async () => ({ payload: expiredGrant }))
    const refreshed = await client.queryReality({ task: '继续讲睡前故事' })
    check('过期后自动 refresh 并继续读得到', refreshed.ok === true, { state: refreshed.state, code: refreshed.code })
    const rotated = credentials.records.get(GRANT_KEY).payload
    check('刷新后 access/refresh 都换了新值（服务端轮换）',
      rotated.accessToken !== expiredGrant.accessToken && rotated.refreshToken !== expiredGrant.refreshToken)

    console.log('\n[8] 撤回：立即停止读取，旧 token 服务端失效')
    const oldAccess = credentials.records.get(GRANT_KEY).payload.accessToken
    const revoked = await client.revoke()
    check('撤回后本地凭据立刻删除', !credentials.records.has(GRANT_KEY) && revoked.ok === true, revoked)
    check('撤回后状态回到未授权', (await client.status()).state === 'unauthorized')
    const readAfterRevoke = await client.queryReality({ task: '撤回后还能读吗' })
    check('撤回后不再读取（not_authorized）', readAfterRevoke.ok === false && readAfterRevoke.code === 'not_authorized', readAfterRevoke)
    const direct = await fetch(mock.url + '/context/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + oldAccess, 'x-shengluo-installation': INSTALLATION },
      body: JSON.stringify({ task: 'x', limit: 5 }),
    })
    check('旧 token 在服务端已经不能用（401）', direct.status === 401, { status: direct.status })

    console.log('\n[9] 家长拒绝')
    const second = new FamilySpace({ ctx, store, config: { baseUrl: mock.url }, logger: { warn() {} } })
    await second.beginDeviceAuth()
    await mock.deny()
    const denied = await second.pollDeviceAuth()
    check('拒绝后是终态 denied，不再轮询', denied.state === 'denied', denied)

    console.log('\n[10] 错误语义与不伪造')
    const bogus = new FamilySpace({ ctx, store, config: { baseUrl: mock.url }, logger: { warn() {} } })
    await bogus.beginDeviceAuth()
    const bogusResult = await bogus.pollDeviceAuth()
    check('未知设备码/异常不会假装成功', bogusResult.state !== 'linked', bogusResult)
  } finally {
    await mock.stop()
  }

  const passed = results.filter((item) => item.ok).length
  const failed = results.length - passed
  console.log('\n' + passed + '/' + results.length + ' 条契约断言通过' + (failed ? '，' + failed + ' 条失败' : ''))

  const evidenceDir = (process.env.SHENGLUO_EVIDENCE_DIR ?? '')
  if (existsSync(evidenceDir)) {
    writeFileSync(evidenceDir + '\\family-space-contract.json', JSON.stringify({
      at: new Date().toISOString(),
      contract: 'Family Space 线上 v1（docs/integrations/SHENGLUO_CONNECTOR.md）',
      ranAgainst: 'tests/family-space-mock.mjs（严格镜像线上契约）',
      passed, total: results.length,
      results,
    }, null, 2), 'utf8')
    console.log('证据：' + evidenceDir + '\\family-space-contract.json')
  }

  process.exit(failed === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('契约测试崩了：' + (error?.stack ?? error))
  process.exit(1)
})
