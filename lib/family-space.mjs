/**
 * 生络 ⇄ Family Space 适配器（DSH 插件侧）—— 对齐线上 v1 契约。
 *
 * 线上：https://ymai.love/api/integrations/shengluo
 * 契约：Family Space 仓库 docs/integrations/SHENGLUO_CONNECTOR.md
 * 交接：artifacts/shengluo-integration-20261122/DSH_HANDOFF.md
 *
 * 端点（与线上一致，逐字照抄请求体，不自创字段）：
 *   POST /device            { installation_id, client_name, scopes? }        → {success, data:{device_code,user_code,...}}
 *   POST /token             { device_code, installation_id }                 → {success, access_token, refresh_token, ...}
 *   POST /token/refresh     { refresh_token, installation_id }               → 同上
 *   POST /revoke            { token, installation_id }                       → {success, data:{revoked}}
 *   POST /context/query     { task, time_range?, conversation_ids?, limit? }  → {success, data:{personal_reality, conversations, unknowns, counts}}
 *   GET  /conversations/:id                                                  → {success, data:{conversation, messages, truncated}}
 *
 * 数据请求必须同时带 Authorization: Bearer 与 X-Shengluo-Installation。
 *
 * 边界（写死在代码里）：
 * - 不碰 Family Space 登录 Cookie；这里只有集成 grant 的 bearer token。
 * - token 只落在 DSH 凭据库（$DSH_HOME/.credentials.yaml，0600），不进插件 JSON、不进日志。
 * - device_code 只在内存，不持久化、不回 UI。
 * - 只读：从不调用任何写/改/遗忘接口；只请求两个 .own scope。
 * - 未授权时返回 state:'unauthorized'，绝不伪造数据。
 */
import { nowIso, text } from './util.mjs'

const CLIENT_NAME = 'DeepSeek Harness'
const SCOPE_CONVERSATION = 'conversation.read.own'
const SCOPE_REALITY = 'personal_reality.read.own'
const GRANT_KEY = 'shengluo/family-space-grant' // CredentialKey: `<scope>/<id>`
const DEFAULT_BASE = 'https://ymai.love/api/integrations/shengluo'

/** 只认这两个 scope；其它一律不接受（防止被塞更宽的范围）。 */
const ALLOWED_SCOPES = new Set([SCOPE_CONVERSATION, SCOPE_REALITY])

class FsError extends Error {
  constructor(message, { code = 'fs_error', status = 0, terminal = false } = {}) {
    super(message)
    this.name = 'FamilySpaceError'
    this.code = code
    this.status = status
    this.terminal = terminal
  }
}

/** 服务端两种错误体：token 是 {error,error_description}；数据接口是 {success:false,code,error}。 */
function errorOf(payload) {
  if (!payload || typeof payload !== 'object') return { code: '', message: '' }
  const code = text(payload.code) || text(payload.error)
  const message = text(payload.error_description) || (text(payload.error) && text(payload.error) !== code ? text(payload.error) : '')
  return { code, message }
}

const ERROR_TEXT = {
  invalid_request: '请求不合法',
  invalid_scope: '请求的权限范围不被接受',
  invalid_grant: '设备码或刷新令牌已失效，请重新发起连接',
  invalid_token: '访问令牌已失效',
  authorization_pending: '家长还没完成同意',
  slow_down: '轮询太快',
  expired_token: '连接码已过期，请重新发起',
  access_denied: '家长拒绝，或授权已被撤回',
  insufficient_scope: '这次授权没有包含所需范围，请重新授权并勾选',
  rate_limited: '请求太频繁，稍后再试',
  server_error: '家庭空间暂时出错',
}

const humanError = (code, fallback) => ERROR_TEXT[code] || fallback || ('家庭空间返回了 ' + (code || '未知错误'))

/**
 * 把 Family Space 的 memory 投影成生络内部的「现实条目」。
 * 事实状态完全按服务端给的 status / summary_type / verbatim_quote 推，不自己拔高：
 *   - verbatim_quote=true 且 status=report/confirmed_report → 本人原话或已确认的陈述
 *   - status=inference 或 summary_type=ai_summary → 推断（服务端明说这是家明归纳的暂定理解）
 *   - 其余 → 有来源的陈述
 */
function factStatusOf(memory) {
  const status = text(memory?.status)
  const summaryType = text(memory?.summary_type)
  if (status === 'inference' || summaryType === 'ai_summary') return 'inference'
  if (memory?.verbatim_quote === true && (status === 'report' || status === 'confirmed_report' || status === '')) return 'owner_said'
  if (status === 'confirmed_report') return 'fact'
  if (status === 'needs_check') return 'inference'
  if (status === 'report' || status === 'reported_by_parent') return 'owner_said'
  return 'fact'
}

function normalizeMemory(memory) {
  const sources = Array.isArray(memory?.sources) ? memory.sources : []
  const messageSource = sources.find((source) => text(source?.type) === 'message' && text(source?.conversation_id))
  return {
    id: text(memory?.memory_id),
    statement: text(memory?.summary),
    factStatus: factStatusOf(memory),
    statusLabel: text(memory?.status_label) || null,
    status: text(memory?.status) || null,
    summaryType: text(memory?.summary_type) || null,
    verbatimQuote: memory?.verbatim_quote === true,
    basis: text(memory?.basis) || null,
    speaker: text(memory?.speaker) || null,
    confidence: typeof memory?.confidence === 'number' ? memory.confidence : null,
    assertedBy: text(memory?.attribution) === 'self' ? 'owner' : 'unknown',
    about: 'self',
    source: {
      type: text(memory?.sources?.[0]?.type) || 'memory',
      conversationId: text(messageSource?.conversation_id) || null,
      label: text(memory?.source_label) || '家庭空间 · 个人现实',
    },
    time: {
      eventTime: text(memory?.event_time) || null,
      observedAt: text(memory?.observed_at) || null,
      precision: 'minute',
    },
    evidence: sources
      .filter((source) => text(source?.message_id))
      .map((source) => ({
        evidenceId: text(source?.message_id),
        conversationId: text(source?.conversation_id) || null,
        messageId: text(source?.message_id),
        quote: '',
      })),
    limits: memory?.limits ?? null,
    status2: 'active',
    supersededBy: null,
  }
}

function normalizeMessage(message) {
  const role = text(message?.role)
  return {
    id: text(message?.message_id),
    at: text(message?.created_at) || null,
    // 服务端约定：user = 家长本人；assistant = 家明（AI）。不把它写成"孩子"。
    speakerRef: role === 'user' ? 'self' : role === 'assistant' ? 'ai' : 'unknown',
    role: role || null,
    text: text(message?.content),
    position: Number.isFinite(message?.position) ? message.position : null,
  }
}

export class FamilySpace {
  constructor({ ctx, store, config, logger }) {
    this.ctx = ctx
    this.store = store
    this.logger = logger
    this.baseUrl = (text(config?.baseUrl) || DEFAULT_BASE).replace(/\/+$/, '')
    this.installationId = null
    this.pending = null // 设备授权只在内存：{ deviceCode, userCode, ..., interval }
  }

  // ——————————————————————————— 基建 ———————————————————————————

  async #installation() {
    if (this.installationId) return this.installationId
    this.installationId = this.store.get().installationId
    return this.installationId
  }

  async #request(path, { method = 'GET', body, token, timeoutMs = 20000, retries = 0 } = {}) {
    const headers = {
      accept: 'application/json',
      'user-agent': 'shengluo-dsh/1.0.0',
      'x-shengluo-installation': await this.#installation(),
    }
    if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8'
    if (token) headers.authorization = 'Bearer ' + token

    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(this.baseUrl + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const raw = await response.text()
        let payload = null
        try { payload = raw ? JSON.parse(raw) : null } catch { payload = null }
        return { status: response.status, payload, raw }
      } catch (error) {
        lastError = error
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
      }
    }
    throw new FsError('连不上家庭空间：' + (text(lastError && lastError.message) || 'network error'), {
      code: 'network_error', terminal: false,
    })
  }

  async #readGrant() {
    try {
      const record = await this.ctx.credentials.readRecord(GRANT_KEY)
      const payload = record && typeof record === 'object' ? record.payload : null
      if (!payload || typeof payload.accessToken !== 'string') return null
      return payload
    } catch { return null }
  }

  async #writeGrant(payload) {
    await this.ctx.credentials.modifyRecord(GRANT_KEY, async () => ({ payload }))
  }

  async #clearGrant() {
    try { await this.ctx.credentials.deleteRecord(GRANT_KEY) } catch { /* 已经没了 */ }
  }

  /** 拿一个可用 token：快过期就刷新；刷新不了就如实标成过期。 */
  async #accessToken() {
    const grant = await this.#readGrant()
    if (!grant) {
      if (this.store.realityMeta().state === 'authorized') await this.store.markRealityState('unauthorized', null)
      return null
    }
    const expiresAt = Date.parse(grant.expiresAt ?? '')
    // 15 分钟寿命，留 60 秒余量提前换。
    if (Number.isFinite(expiresAt) && expiresAt - 60_000 > Date.now()) return grant.accessToken
    if (!grant.refreshToken) {
      await this.store.markRealityState('expired', '访问令牌已过期，需要重新连接')
      return null
    }
    const refreshed = await this.#refresh(grant)
    return refreshed ? refreshed.accessToken : null
  }

  async #refresh(grant) {
    const result = await this.#request('/token/refresh', {
      method: 'POST',
      body: { refresh_token: grant.refreshToken, installation_id: await this.#installation() },
    })
    const payload = result.payload ?? {}
    if (result.status === 200 && text(payload.access_token)) {
      const next = {
        ...grant,
        accessToken: text(payload.access_token),
        refreshToken: text(payload.refresh_token) || grant.refreshToken,
        expiresAt: new Date(Date.now() + Number(payload.expires_in ?? 900) * 1000).toISOString(),
        refreshExpiresAt: payload.refresh_expires_in
          ? new Date(Date.now() + Number(payload.refresh_expires_in) * 1000).toISOString()
          : grant.refreshExpiresAt ?? null,
        scope: text(payload.scope) || grant.scope,
        scopes: Array.isArray(payload.scopes) ? payload.scopes : grant.scopes,
      }
      await this.#writeGrant(next)
      await this.store.markAuthorized({
        subject: next.subject ?? grant.subject ?? null,
        scopes: next.scopes ?? [],
        authorizedAt: grant.authorizedAt,
        expiresAt: next.expiresAt,
      })
      return next
    }
    const { code, message } = errorOf(payload)
    await this.#clearGrant()
    await this.store.markRealityState('expired', humanError(code, message) + '（需要重新连接家庭空间）')
    return null
  }

  // ——————————————————————————— 状态 ———————————————————————————

  async status() {
    const grant = await this.#readGrant()
    const pending = this.#pendingView()
    if (!grant) {
      return {
        state: 'unauthorized',
        detail: '未连接家庭空间。个人现实现在是未知。',
        subject: null, scopes: [], pending,
      }
    }
    const scopes = Array.isArray(grant.scopes) ? grant.scopes : text(grant.scope).split(' ').filter(Boolean)
    const expired = Date.parse(grant.expiresAt ?? '') < Date.now() && !grant.refreshToken
    const state = expired ? 'expired' : 'authorized'
    if (this.store.realityMeta().state !== state) {
      await this.store.markAuthorized({
        subject: grant.subject ?? null, scopes,
        authorizedAt: grant.authorizedAt, expiresAt: grant.expiresAt ?? null,
      })
    }
    return {
      state,
      detail: state === 'authorized' ? '已连接家庭空间，可读取你有权访问的个人现实。' : '授权已过期，需要重新连接。',
      subject: grant.subject ?? null,
      scopes,
      authorizedAt: grant.authorizedAt ?? null,
      expiresAt: grant.expiresAt ?? null,
      canReadReality: scopes.includes(SCOPE_REALITY),
      canReadConversations: scopes.includes(SCOPE_CONVERSATION),
      pending,
    }
  }

  #pendingView() {
    if (!this.pending) return null
    const remaining = this.pending.expiresAt - Date.now()
    if (remaining <= 0) { this.pending = null; return null }
    return {
      userCode: this.pending.userCode,
      verificationUri: this.pending.verificationUri,
      verificationUriComplete: this.pending.verificationUriComplete,
      interval: Math.round(this.pending.interval / 1000),
      expiresIn: Math.round(remaining / 1000),
      requestedScopeLabels: this.pending.requestedScopeLabels,
    }
  }

  // ——————————————————————————— 设备授权 ———————————————————————————

  async beginDeviceAuth() {
    const result = await this.#request('/device', {
      method: 'POST',
      body: {
        installation_id: await this.#installation(),
        client_name: CLIENT_NAME,
        scopes: [SCOPE_CONVERSATION, SCOPE_REALITY],
      },
      retries: 2,
    })
    const payload = result.payload ?? {}
    const data = payload.data ?? payload
    if (result.status !== 200 || !text(data.device_code) || !text(data.user_code)) {
      const { code, message } = errorOf(payload)
      throw new FsError(humanError(code, message || ('开启授权失败（HTTP ' + result.status + '）')), {
        code: code || 'device_start_failed', status: result.status, terminal: true,
      })
    }
    const requestedScopes = Array.isArray(data.requested_scopes)
      ? data.requested_scopes.filter((scope) => ALLOWED_SCOPES.has(scope))
      : [SCOPE_CONVERSATION, SCOPE_REALITY]
    this.pending = {
      deviceCode: text(data.device_code),
      userCode: text(data.user_code),
      verificationUri: text(data.verification_uri) || 'https://ymai.love/connect/shengluo',
      verificationUriComplete: text(data.verification_uri_complete)
        || 'https://ymai.love/connect/shengluo?user_code=' + encodeURIComponent(text(data.user_code)),
      expiresAt: Date.now() + Number(data.expires_in ?? 600) * 1000,
      interval: Math.max(1000, Number(data.interval ?? 5) * 1000),
      requestedScopeLabels: Array.isArray(data.requested_scope_labels) ? data.requested_scope_labels : [],
      scopes: requestedScopes,
    }
    return { ok: true, ...this.#pendingView() }
  }

  async pollDeviceAuth() {
    if (!this.pending) return { state: 'error', code: 'no_pending', detail: '没有正在进行的授权，请重新开始。' }
    if (Date.now() > this.pending.expiresAt) {
      this.pending = null
      return { state: 'expired', code: 'expired_token', detail: '连接码已过期，请重新连接。' }
    }
    const result = await this.#request('/token', {
      method: 'POST',
      body: { device_code: this.pending.deviceCode, installation_id: await this.#installation() },
    })
    const payload = result.payload ?? {}

    if (result.status === 200 && text(payload.access_token)) {
      if (text(payload.token_type).toLowerCase() !== 'bearer') {
        this.pending = null
        return { state: 'error', code: 'E_TOKEN_TYPE', detail: '家庭空间返回了不支持的令牌类型。' }
      }
      const scopes = Array.isArray(payload.scopes) ? payload.scopes : text(payload.scope).split(' ').filter(Boolean)
      const unexpected = scopes.filter((scope) => !ALLOWED_SCOPES.has(scope))
      if (unexpected.length > 0) {
        // 服务端给了我们没申请的范围：不接收，直接丢掉这枚令牌并如实报错。
        this.pending = null
        return { state: 'error', code: 'E_SCOPE', detail: '家庭空间返回了未申请的权限范围：' + unexpected.join(', ') }
      }
      const grant = {
        accessToken: text(payload.access_token),
        refreshToken: text(payload.refresh_token) || null,
        expiresAt: new Date(Date.now() + Number(payload.expires_in ?? 900) * 1000).toISOString(),
        refreshExpiresAt: payload.refresh_expires_in
          ? new Date(Date.now() + Number(payload.refresh_expires_in) * 1000).toISOString()
          : null,
        scope: text(payload.scope) || scopes.join(' '),
        scopes,
        // token 响应里没有 subject；本人身份在第一次查询时由服务端的 person_id 给出。
        subject: null,
        installationId: await this.#installation(),
        authorizedAt: nowIso(),
      }
      await this.#writeGrant(grant)
      await this.store.markAuthorized({ subject: null, scopes, authorizedAt: grant.authorizedAt, expiresAt: grant.expiresAt })
      this.pending = null
      return { state: 'linked', scopes }
    }

    const { code, message } = errorOf(payload)
    if (code === 'authorization_pending' || result.status === 202) return { state: 'pending', code }
    if (code === 'slow_down') {
      const suggested = Number(payload.interval)
      this.pending.interval = Math.min(Number.isFinite(suggested) && suggested > 0 ? suggested * 1000 : this.pending.interval + 5000, 60000)
      return { state: 'pending', code, interval: Math.round(this.pending.interval / 1000) }
    }
    if (result.status === 429) return { state: 'pending', code: 'rate_limited' }
    if (result.status >= 500) return { state: 'pending', code: code || 'server_error' }

    this.pending = null
    if (code === 'access_denied') return { state: 'denied', code, detail: '家长在家庭空间里拒绝了这次授权，或授权已被撤回。' }
    if (code === 'expired_token') return { state: 'expired', code, detail: '连接码已过期，请重新连接。' }
    return { state: 'error', code: code || 'token_failed', detail: humanError(code, message || ('授权失败（HTTP ' + result.status + '）')) }
  }

  cancelDeviceAuth() { this.pending = null }

  /** 主动撤回：服务端撤回 + 本地立刻删凭据。 */
  async revoke() {
    const grant = await this.#readGrant()
    let server = { attempted: false, ok: false, detail: '本地没有授权记录' }
    if (grant) {
      try {
        const result = await this.#request('/revoke', {
          method: 'POST',
          body: { token: grant.refreshToken || grant.accessToken, installation_id: await this.#installation() },
          retries: 1,
        })
        const data = result.payload?.data ?? {}
        server = { attempted: true, ok: result.status === 200 && data.revoked !== false, status: result.status, revoked: data.revoked ?? null }
      } catch (error) {
        server = { attempted: true, ok: false, detail: text(error && error.message) }
      }
    }
    this.pending = null
    await this.#clearGrant()
    await this.store.markRealityState('unauthorized', null)
    return { ok: true, server, state: 'unauthorized' }
  }

  // ——————————————————————————— 只读查询 ———————————————————————————

  /** 记住服务端给的 person_id 作为"当前账号"，只用于界面显示，不做鉴权判断。 */
  async #rememberPerson(personId) {
    const id = text(personId)
    if (!id) return
    const meta = this.store.realityMeta()
    if (meta.subject?.principalId === id) return
    const grant = await this.#readGrant()
    if (grant) await this.#writeGrant({ ...grant, subject: { principalId: id } })
    await this.store.markAuthorized({
      subject: { principalId: id },
      scopes: meta.scopes, authorizedAt: meta.authorizedAt, expiresAt: meta.expiresAt,
    })
  }

  async queryReality({ task, limit = 10, timeRange = null, conversationIds = null } = {}) {
    const token = await this.#accessToken()
    if (!token) {
      return {
        ok: false,
        state: (await this.status()).state,
        code: 'not_authorized',
        detail: '家庭空间尚未授权，个人现实是未知，不是空的。',
        results: [], conversations: [],
      }
    }
    const body = { task: text(task).slice(0, 2000) || '了解我现在的处境', limit: Math.min(Math.max(Number(limit) || 10, 1), 20) }
    if (timeRange && timeRange.from && timeRange.to) body.time_range = { from: text(timeRange.from), to: text(timeRange.to) }
    if (Array.isArray(conversationIds) && conversationIds.length > 0) body.conversation_ids = conversationIds.slice(0, 20)

    let result
    try {
      result = await this.#request('/context/query', { method: 'POST', body, token })
      if (result.status === 401) {
        const grant = await this.#readGrant()
        const refreshed = grant?.refreshToken ? await this.#refresh(grant) : null
        if (refreshed) result = await this.#request('/context/query', { method: 'POST', body, token: refreshed.accessToken })
      }
    } catch (error) {
      return { ok: false, state: 'error', code: text(error && error.code), detail: text(error && error.message), results: [], conversations: [] }
    }

    const payload = result.payload ?? {}
    const { code, message } = errorOf(payload)
    if (result.status === 200 && (payload.success === true || payload.data)) {
      const data = payload.data ?? payload
      await this.store.markQueried()
      await this.#rememberPerson(data.person_id)
      const results = Array.isArray(data.personal_reality) ? data.personal_reality.map(normalizeMemory) : []
      const unknowns = Array.isArray(data.unknowns) ? data.unknowns : []
      return {
        ok: true,
        state: 'authorized',
        generatedAt: text(data.generated_at) || null,
        personId: text(data.person_id) || null,
        scopes: Array.isArray(data.scopes) ? data.scopes : [],
        results,
        conversations: Array.isArray(data.conversations)
          ? data.conversations.map((item) => ({
              id: text(item?.conversation?.id),
              title: text(item?.conversation?.title) || null,
              messageCount: Number(item?.conversation?.message_count) || 0,
              updatedAt: text(item?.conversation?.updated_at) || null,
              truncated: item?.truncated === true,
              messages: Array.isArray(item?.messages) ? item.messages.map(normalizeMessage) : [],
            }))
          : [],
        unknowns,
        counts: data.counts ?? null,
        emptyReason: results.length === 0 && Array.isArray(data.conversations) && data.conversations.length === 0 ? 'no_match' : null,
        // 正文只在这次响应里，不落盘。
        ephemeral: true,
      }
    }
    if (result.status === 401 || code === 'invalid_token') {
      await this.#clearGrant()
      await this.store.markRealityState('expired', '访问令牌失效，需要重新连接')
      return { ok: false, state: 'expired', code: 'invalid_token', detail: '授权已失效，需要重新连接家庭空间。', results: [], conversations: [] }
    }
    if (result.status === 403 || code === 'insufficient_scope') {
      return { ok: false, state: 'authorized', code: 'insufficient_scope', detail: humanError('insufficient_scope'), results: [], conversations: [] }
    }
    return {
      ok: false, state: 'error',
      code: code || 'query_failed',
      detail: humanError(code, message || ('读取个人现实失败（HTTP ' + result.status + '）')),
      results: [], conversations: [],
    }
  }

  /** 读一段对话的逐字原文。不可见/跨家庭一律 404，插件不追问、不推断。 */
  async readConversation(conversationId) {
    const token = await this.#accessToken()
    if (!token) {
      return { ok: false, state: (await this.status()).state, code: 'not_authorized', detail: '家庭空间尚未授权。' }
    }
    const id = text(conversationId)
    if (!id) return { ok: false, code: 'invalid_request', detail: '缺少对话 id。' }

    let result
    try {
      result = await this.#request('/conversations/' + encodeURIComponent(id), { token })
    } catch (error) {
      return { ok: false, code: text(error && error.code), detail: text(error && error.message) }
    }
    const payload = result.payload ?? {}
    const { code, message } = errorOf(payload)
    if (result.status === 200 && (payload.success === true || payload.data)) {
      const data = payload.data ?? payload
      const conversation = data.conversation ?? {}
      return {
        ok: true,
        conversation: {
          id: text(conversation.id) || id,
          title: text(conversation.title) || null,
          status: text(conversation.status) || null,
          startedAt: text(conversation.created_at) || null,
          endedAt: text(conversation.updated_at) || null,
          messageCount: Number(conversation.message_count) || 0,
          truncated: data.truncated === true,
          messages: Array.isArray(data.messages) ? data.messages.map(normalizeMessage) : [],
        },
        ephemeral: true,
      }
    }
    if (result.status === 404) return { ok: false, code: 'not_found', detail: '这段对话打不开（不存在，或不在你的授权范围内）。' }
    if (result.status === 401 || code === 'invalid_token') {
      await this.#clearGrant()
      await this.store.markRealityState('expired', '访问令牌失效')
      return { ok: false, code: 'invalid_token', detail: '授权已失效，需要重新连接。' }
    }
    if (result.status === 403 || code === 'insufficient_scope') {
      return { ok: false, code: 'insufficient_scope', detail: humanError('insufficient_scope') }
    }
    return { ok: false, code: code || 'conversation_failed', detail: humanError(code, message || ('读取对话失败（HTTP ' + result.status + '）')) }
  }
}

export const FAMILY_SPACE_SCOPES = { SCOPE_CONVERSATION, SCOPE_REALITY, ALLOWED_SCOPES }
