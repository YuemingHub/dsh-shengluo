/**
 * 生络 — Family Space **线上**联调（不需要家长登录的那部分）。
 *
 * 真连 https://ymai.love/api/integrations/shengluo，验证：
 * - 设备授权真的能开（信封、user_code、授权页链接、范围标签、interval）；
 * - 未批准时轮询如实返回 authorization_pending，不会假装成功；
 * - 错误语义与线上一致（invalid_grant / invalid_token）；
 * - 授权页本身可访问；
 * - device_code 只留内存、不落盘、不回 UI。
 *
 * 不能自动化的部分（需要家长本人在浏览器登录并点同意）明确标注为 SKIP，
 * 由本人在真机上完成一次，然后用 --manual 复核已授权状态。
 *
 * 用法：node tests/family-space-live.mjs [--manual]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { FamilySpace } from '../lib/family-space.mjs'

const BASE = process.env.SL_FS_LIVE_BASE || 'https://ymai.love/api/integrations/shengluo'
const CONNECT = 'https://ymai.love/connect/shengluo'
const manual = process.argv.includes('--manual')
const results = []
const check = (name, condition, detail = {}) => {
  results.push({ ...detail, name, ok: Boolean(condition) })
  console.log((condition ? '  ✓ ' : '  ✗ ') + name + (condition ? '' : '  ' + JSON.stringify(detail).slice(0, 400)))
  return Boolean(condition)
}
const skip = (name, why) => {
  results.push({ name, ok: true, skipped: true, why })
  console.log('  ⋯ ' + name + '（跳过：' + why + '）')
}

function fakeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) { const next = await mutate(records.get(key)); if (next !== undefined) records.set(key, JSON.parse(JSON.stringify(next))); return records.get(key) },
    async deleteRecord(key) { records.delete(key) },
  }
}
function fakeStore() {
  const state = { installationId: 'live-probe-' + Math.random().toString(36).slice(2, 10), reality: { state: 'unauthorized', subject: null, scopes: [], authorizedAt: null, expiresAt: null, lastQueriedAt: null, lastError: null } }
  return {
    state, get: () => state, realityMeta: () => ({ ...state.reality }),
    async markAuthorized({ subject, scopes, authorizedAt, expiresAt }) { state.reality = { state: 'authorized', subject: subject ?? null, scopes: scopes ?? [], authorizedAt: authorizedAt ?? null, expiresAt: expiresAt ?? null, lastQueriedAt: null, lastError: null } },
    async markRealityState(next, lastError = null) { state.reality.state = next; state.reality.lastError = lastError },
    async markQueried() { state.reality.lastQueriedAt = new Date().toISOString() },
  }
}

async function run() {
  console.log('\n线上目标：' + BASE)
  const credentials = fakeCredentials()
  const store = fakeStore()
  const client = new FamilySpace({ ctx: { credentials }, store, config: { baseUrl: BASE }, logger: { warn() {} } })

  console.log('\n[1] 授权页可达')
  try {
    const page = await fetch(CONNECT, { redirect: 'manual' })
    const html = page.status === 200 ? await page.text() : ''
    check('GET /connect/shengluo 返回 200', page.status === 200, { status: page.status })
    check('授权页是 HTML（给家长看的页面）', /text\/html/i.test(page.headers.get('content-type') ?? ''), { contentType: page.headers.get('content-type') })
    check('授权页里的脚本来自同源、不是外部注入', !/src="https?:\/\/(?!ymai\.love)/i.test(html), { hasForeignScript: /src="https?:\/\/(?!ymai\.love)/i.test(html) })
  } catch (error) {
    check('GET /connect/shengluo 返回 200', false, { error: String(error.message) })
  }

  console.log('\n[2] 真实设备授权：开码')
  let started = null
  try {
    started = await client.beginDeviceAuth()
    check('POST /device 成功并解析出 data 信封', Boolean(started?.userCode), started)
    check('user_code 形如 ABCD-EFGH', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(started?.userCode ?? ''), { userCode: started?.userCode })
    check('verification_uri 指向线上授权页', String(started?.verificationUri).startsWith('https://ymai.love/connect/shengluo'), { uri: started?.verificationUri })
    check('verification_uri_complete 带上了 user_code', String(started?.verificationUriComplete).includes('user_code=' + encodeURIComponent(started?.userCode ?? '')), { uri: started?.verificationUriComplete })
    check('拿回两个范围的中文说明（家长看到的就是这个）', (started?.requestedScopeLabels ?? []).length >= 2, started?.requestedScopeLabels)
    check('范围只有两个 .own', (started?.requestedScopeLabels ?? []).every((label) => /^(conversation|personal_reality)\.read\.own$/.test(label.id)), started?.requestedScopeLabels?.map((l) => l.id))
    check('device_code 没进给 UI 的对象', !('deviceCode' in (started ?? {})) && !JSON.stringify(started ?? {}).includes('device_code'), Object.keys(started ?? {}))
    check('device_code 没写进产品状态/凭据库',
      !JSON.stringify(store.state).includes('device_code') && credentials.records.size === 0)
    console.log('    （10 分钟内有效；本次只用于验证协议，不会有人批准）')
  } catch (error) {
    check('POST /device 成功', false, { error: String(error.message) })
  }

  console.log('\n[3] 未批准时的轮询语义')
  if (started) {
    const first = await client.pollDeviceAuth()
    check('未批准时如实返回 pending，不假装成功', first.state === 'pending', first)
    check('pending 的原因是 authorization_pending 或 slow_down',
      ['authorization_pending', 'slow_down'].includes(first.code), { code: first.code })
    const second = await client.pollDeviceAuth()
    check('连续轮询仍不假装成功', second.state !== 'linked', second)
  } else {
    skip('轮询语义', '没能开码')
  }

  console.log('\n[4] 错误语义与线上一致')
  const bogusToken = await fetch(BASE + '/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shengluo-installation': store.state.installationId },
    body: JSON.stringify({ device_code: 'bogus-device-code', installation_id: store.state.installationId }),
  })
  const bogusBody = await bogusToken.json().catch(() => ({}))
  check('无效设备码返回 invalid_grant', bogusToken.status === 400 && bogusBody.error === 'invalid_grant', { status: bogusToken.status, body: bogusBody })

  const noAuthQuery = await fetch(BASE + '/context/query', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'x', limit: 5 }),
  })
  const noAuthBody = await noAuthQuery.json().catch(() => ({}))
  check('未带令牌的数据请求被拒（401）', noAuthQuery.status === 401, { status: noAuthQuery.status })
  check('拒绝原因是 invalid_token，且不泄露任何数据', noAuthBody.code === 'invalid_token' && !('data' in noAuthBody), noAuthBody)

  const noAuthConversation = await fetch(BASE + '/conversations/conv_probe', { headers: { 'x-shengluo-installation': store.state.installationId } })
  check('未带令牌读对话被拒（401）', noAuthConversation.status === 401, { status: noAuthConversation.status })

  const wrongInstallation = await fetch(BASE + '/context/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bogus', 'x-shengluo-installation': 'wrong-installation' },
    body: JSON.stringify({ task: 'x', limit: 5 }),
  })
  check('假令牌 + 乱安装实例都被拒（不枚举、不细分）', wrongInstallation.status === 401, { status: wrongInstallation.status })

  console.log('\n[5] 已授权状态（需家长本人完成一次）')
  if (manual) {
    const status = await client.status()
    check('本地凭据里已有授权（--manual 模式）', status.state === 'authorized', status)
    if (status.state === 'authorized') {
      const query = await client.queryReality({ task: '今天我想推进一件事', limit: 5 })
      check('能读到本人有权访问的个人现实或明确的 unknowns', query.ok === true, { code: query.code, results: query.results?.length ?? 0, unknowns: query.unknowns?.length ?? 0 })
      if (query.ok) {
        const sample = query.results[0]
        check('每条都带事实状态与来源（不是裸文本）',
          query.results.every((item) => Boolean(item.factStatus) && Boolean(item.source?.label)), sample)
        const conversationId = sample?.source?.conversationId
        if (conversationId) {
          const conversation = await client.readConversation(conversationId)
          check('能回溯到原始对话', conversation.ok === true, { code: conversation.code })
        } else {
          skip('回溯原始对话', '这次没有带 conversation 来源')
        }
      }
    }
  } else {
    skip('已授权后的读取', '需要家长本人在浏览器登录并同意；用 --manual 复跑')
  }

  const hardFailed = results.filter((item) => !item.ok && !item.skipped).length
  const passed = results.filter((item) => item.ok && !item.skipped).length
  const skipped = results.filter((item) => item.skipped).length
  console.log('\n线上联调：' + passed + ' 通过 / ' + hardFailed + ' 失败 / ' + skipped + ' 跳过')

  const dir = (process.env.SHENGLUO_EVIDENCE_DIR ?? '')
  if (existsSync(dir)) {
    const file = dir + '\\family-space-live.json'
    writeFileSync(file, JSON.stringify({
      at: new Date().toISOString(),
      target: BASE,
      note: '真连线上 Family Space 集成接口。approval 需要家长本人登录，已标注 skip。',
      passed, failed: hardFailed, skipped,
      results,
    }, null, 2), 'utf8')
    console.log('证据：' + file)
  }
  process.exit(hardFailed === 0 ? 0 : 1)
}

run().catch((error) => {
  console.error('线上联调崩了：' + (error?.stack ?? error))
  process.exit(1)
})
