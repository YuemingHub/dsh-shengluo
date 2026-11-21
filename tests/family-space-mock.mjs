/**
 * 生络验收用 — Family Space 集成契约的本地替身。
 *
 * 严格镜像**线上 v1 契约**（Family Space 仓库 docs/integrations/SHENGLUO_CONNECTOR.md）：
 * - /device 回 {success:true, data:{...}}；/token 成功是扁平的 {success:true, access_token,...}；
 *   数据接口错误是 {success:false, code, error}，而 /token 错误是 {error, error_description}；
 * - 数据请求必须同时带 Authorization: Bearer 与 X-Shengluo-Installation，且 token 绑定 installation_id；
 * - /context/query 回 personal_reality（带 status/summary_type/verbatim_quote/attribution/sources）；
 * - /conversations/:id 不可见一律 404，不泄露存在性。
 *
 * 它是测试替身，不是真实服务。真服务在 https://ymai.love/api/integrations/shengluo。
 */
import { createServer } from 'node:http'

const SCOPES = ['conversation.read.own', 'personal_reality.read.own']
const OWN_PERSON = 'ownr_test_01'
const OTHER_PERSON = 'ownr_other_02'

const MEMORIES = [
  {
    memory_id: 'mem_sleep_light',
    summary: '孩子最近怕黑，睡前会要求留一盏小夜灯。',
    summary_type: 'reported_text',
    verbatim_quote: true,
    status: 'confirmed_report',
    status_label: '你确认过的情况',
    basis: '你自己在对话里说过，并确认过',
    speaker: 'self',
    source_label: '你自己在对话里说过的话',
    event_time: '2026-11-20T12:30:00.000Z',
    observed_at: '2026-11-20T12:31:10.000Z',
    attribution: 'self',
    sources: [{ type: 'message', conversation_id: 'conv_own_1', message_id: 'msg_1' }],
    limits: { audience: 'only_authorized_person', ai_usable: true, shareable_to_family: true },
  },
  {
    memory_id: 'mem_story_soft',
    summary: '讲睡前故事时不要太吓人，讲完要关灯。',
    summary_type: 'ai_summary',
    verbatim_quote: false,
    status: 'inference',
    status_label: '家明归纳的暂定理解',
    basis: '从最近几次对话里归纳，还没有被你确认',
    speaker: 'assistant_inference',
    source_label: '家明归纳的暂定理解',
    event_time: '2026-11-19T13:00:00.000Z',
    observed_at: '2026-11-19T13:00:05.000Z',
    attribution: 'self',
    sources: [{ type: 'message', conversation_id: 'conv_own_1', message_id: 'msg_1' }],
    limits: { audience: 'only_authorized_person', ai_usable: true, shareable_to_family: false },
  },
]

const CONVERSATIONS = {
  conv_own_1: {
    conversation: {
      id: 'conv_own_1', title: '睡前故事', status: 'active', message_count: 2,
      created_at: '2026-11-20T12:25:00.000Z', updated_at: '2026-11-20T12:40:00.000Z',
    },
    messages: [
      { message_id: 'msg_1', conversation_id: 'conv_own_1', role: 'user', content: '他这两天说怕黑，要留个小夜灯。', created_at: '2026-11-20T12:30:00.000Z', position: 0 },
      { message_id: 'msg_2', conversation_id: 'conv_own_1', role: 'assistant', content: '记下了，讲故事时我会避开吓人的情节。', created_at: '2026-11-20T12:31:00.000Z', position: 1 },
    ],
    person_id: OWN_PERSON,
  },
  conv_other_1: {
    conversation: {
      id: 'conv_other_1', title: '另一位家长的私人对话', status: 'active', message_count: 1,
      created_at: '2026-11-20T09:00:00.000Z', updated_at: '2026-11-20T09:05:00.000Z',
    },
    messages: [{ message_id: 'msg_other_1', conversation_id: 'conv_other_1', role: 'user', content: '不该被读到的内容', created_at: '2026-11-20T09:00:00.000Z', position: 0 }],
    person_id: OTHER_PERSON,
  },
}

const json = (res, status, body, extra = {}) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extra,
  })
  res.end(payload)
}

const readBody = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
  })
})

export async function startMockFamilySpace({ interval = 1, slowDownOnce = false } = {}) {
  const devices = new Map() // device_code -> { userCode, status, expiresAt, installationId }
  const tokens = new Map() // access_token -> { installationId, scopes, personId, revoked }
  const refreshTokens = new Map() // refresh_token -> same record
  const calls = []
  let slowRemaining = slowDownOnce ? 1 : 0

  const issue = ({ installationId, personId = OWN_PERSON }) => {
    const accessToken = 'test_at_' + Math.random().toString(36).slice(2, 12)
    const refreshToken = 'test_rt_' + Math.random().toString(36).slice(2, 12)
    const record = { installationId, scopes: [...SCOPES], personId, revoked: false }
    tokens.set(accessToken, record)
    refreshTokens.set(refreshToken, record)
    return {
      success: true,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 900,
      refresh_expires_in: 2592000,
      scope: SCOPES.join(' '),
      scopes: [...SCOPES],
    }
  }

  /** 数据接口的鉴权：Bearer + X-Shengluo-Installation，且 token 绑定该安装实例。 */
  const authenticate = (req) => {
    const header = String(req.headers.authorization ?? '')
    if (!header) return { ok: false, status: 401, body: { success: false, code: 'invalid_token', error: '缺少访问令牌。' } }
    const match = /^Bearer (.+)$/.exec(header)
    if (!match) return { ok: false, status: 401, body: { success: false, code: 'invalid_token', error: '缺少访问令牌。' } }
    const record = tokens.get(match[1])
    if (!record || record.revoked) return { ok: false, status: 401, body: { success: false, code: 'invalid_token', error: '访问令牌无效或已过期。' } }
    const installation = String(req.headers['x-shengluo-installation'] ?? '')
    if (!installation) return { ok: false, status: 400, body: { success: false, code: 'invalid_request', error: '缺少安装实例。' } }
    if (installation !== record.installationId) {
      return { ok: false, status: 401, body: { success: false, code: 'invalid_token', error: '令牌与这个安装实例不匹配。' } }
    }
    return { ok: true, record }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.local')
    // 客户端配的 baseUrl 是 .../api/integrations/shengluo，路由表按相对路径写。
    const PREFIX = '/api/integrations/shengluo'
    let path = url.pathname.replace(/\/+$/, '')
    if (path.startsWith(PREFIX)) path = path.slice(PREFIX.length) || '/'
    const method = req.method ?? 'GET'
    calls.push({ method, path, at: Date.now() })

    // —— 测试控制口（不属于契约）——
    if (path === '/__test/approve') {
      for (const device of devices.values()) device.status = 'approved'
      return json(res, 200, { ok: true })
    }
    if (path === '/__test/deny') {
      for (const device of devices.values()) device.status = 'denied'
      return json(res, 200, { ok: true })
    }
    if (path === '/__test/seed-conversation') {
      // 模拟"服务端新增了一段本人可见的对话"
      return json(res, 200, { ok: true })
    }

    // ————————————————— 1. POST /device —————————————————
    if (path === '/device' && method === 'POST') {
      const body = await readBody(req)
      if (!body.installation_id) return json(res, 400, { success: false, code: 'invalid_request', error: '缺少安装实例。' })
      if (Array.isArray(body.scopes) && body.scopes.some((scope) => !SCOPES.includes(scope))) {
        return json(res, 400, { success: false, code: 'invalid_scope', error: '包含不支持的授权范围。' })
      }
      const deviceCode = 'test_dc_' + Math.random().toString(36).slice(2, 14)
      const userCode = 'WDJB-' + Math.random().toString(36).slice(2, 6).toUpperCase()
      devices.set(deviceCode, {
        userCode, status: 'pending', expiresAt: Date.now() + 600_000,
        installationId: body.installation_id, used: false,
      })
      return json(res, 200, {
        success: true,
        data: {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: base + '/connect/shengluo',
          verification_uri_complete: base + '/connect/shengluo?user_code=' + encodeURIComponent(userCode),
          expires_in: 600,
          interval,
          requested_scopes: [...SCOPES],
          requested_scope_labels: [
            { id: 'conversation.read.own', label: '读取你自己和家明的对话' },
            { id: 'personal_reality.read.own', label: '使用你自己的个人现实' },
          ],
        },
      })
    }

    // ————————————————— 2. POST /token —————————————————
    if (path === '/token' && method === 'POST') {
      const body = await readBody(req)
      if (!body.installation_id) return json(res, 400, { error: 'invalid_grant', error_description: '缺少安装实例。' })
      const device = devices.get(body.device_code)
      if (!device || device.used || device.installationId !== body.installation_id) {
        return json(res, 400, { error: 'invalid_grant', error_description: '设备码无效，请重新发起连接。' })
      }
      if (Date.now() > device.expiresAt) return json(res, 400, { error: 'expired_token', error_description: '设备码已过期。' })
      if (slowRemaining > 0) {
        slowRemaining -= 1
        return json(res, 400, { error: 'slow_down', error_description: '轮询太快，请放慢。', interval: interval + 5 })
      }
      if (device.status === 'pending') return json(res, 400, { error: 'authorization_pending', error_description: '家长还没完成同意。' })
      if (device.status === 'denied') return json(res, 400, { error: 'access_denied', error_description: '家长拒绝了这次授权。' })
      device.used = true
      return json(res, 200, issue({ installationId: body.installation_id }))
    }

    // ————————————————— 3. POST /token/refresh —————————————————
    if (path === '/token/refresh' && method === 'POST') {
      const body = await readBody(req)
      const record = refreshTokens.get(body.refresh_token)
      if (!record || record.revoked) return json(res, 400, { error: 'invalid_grant', error_description: '刷新令牌无效。' })
      if (record.installationId !== body.installation_id) return json(res, 400, { error: 'invalid_grant', error_description: '安装实例不匹配。' })
      // 轮换：旧 refresh 立即作废
      for (const [key, value] of refreshTokens) if (value === record) refreshTokens.delete(key)
      return json(res, 200, issue({ installationId: record.installationId, personId: record.personId }))
    }

    // ————————————————— 4. POST /revoke —————————————————
    if (path === '/revoke' && method === 'POST') {
      const body = await readBody(req)
      const record = refreshTokens.get(body.token) ?? tokens.get(body.token)
      if (!record || record.installationId !== body.installation_id) {
        // 契约：不存在的令牌也返回 200，不枚举
        return json(res, 200, { success: true, data: { revoked: false } })
      }
      record.revoked = true
      return json(res, 200, { success: true, data: { revoked: true } })
    }

    // ————————————————— 5. POST /context/query —————————————————
    if (path === '/context/query' && method === 'POST') {
      const auth = authenticate(req)
      if (!auth.ok) return json(res, auth.status, auth.body)
      if (!auth.record.scopes.includes('personal_reality.read.own')) {
        return json(res, 403, { success: false, code: 'insufficient_scope', error: '这次授权没有包含个人现实范围。' })
      }
      const body = await readBody(req)
      if (!body.task || typeof body.task !== 'string') {
        return json(res, 400, { success: false, code: 'invalid_request', error: '缺少 task。' })
      }
      const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 20)
      const personalReality = MEMORIES.slice(0, limit)
      const visibleConversation = CONVERSATIONS.conv_own_1
      const conversations = [{
        conversation: visibleConversation.conversation,
        messages: visibleConversation.messages,
        truncated: false,
      }]
      return json(res, 200, {
        success: true,
        data: {
          generated_at: new Date().toISOString(),
          person_id: auth.record.personId,
          scopes: auth.record.scopes,
          conversations,
          personal_reality: personalReality,
          unknowns: [],
          counts: { conversations: conversations.length, personal_reality: personalReality.length, omitted_conversations: 0 },
          truncated: false,
        },
      })
    }

    // ————————————————— 6. GET /conversations/:id —————————————————
    const conversationMatch = /^\/conversations\/(.+)$/.exec(path)
    if (conversationMatch && method === 'GET') {
      const auth = authenticate(req)
      if (!auth.ok) return json(res, auth.status, auth.body)
      if (!auth.record.scopes.includes('conversation.read.own')) {
        return json(res, 403, { success: false, code: 'insufficient_scope', error: '这次授权没有包含对话范围。' })
      }
      const id = decodeURIComponent(conversationMatch[1])
      const found = CONVERSATIONS[id]
      // 不存在 / 别人的 / 已删除：完全同一个 404，不泄露存在性。
      if (!found || found.person_id !== auth.record.personId) {
        return json(res, 404, { success: false, code: 'conversation_not_found', error: '这个对话不存在，或你无权查看。' })
      }
      return json(res, 200, {
        success: true,
        data: { conversation: found.conversation, messages: found.messages, truncated: false },
      })
    }

    return json(res, 404, { success: false, code: 'not_found', error: 'not found' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port

  return {
    url: base + '/api/integrations/shengluo',
    origin: base,
    calls,
    approve: async () => { await fetch(base + '/__test/approve') },
    deny: async () => { await fetch(base + '/__test/deny') },
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

if (process.argv[1] && process.argv[1].endsWith('family-space-mock.mjs')) {
  const mock = await startMockFamilySpace({ interval: 2 })
  console.log('mock Family Space on ' + mock.url)
  console.log('POST ' + mock.origin + '/__test/approve  → 批准一次设备授权')
}
