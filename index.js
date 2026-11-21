/**
 * 生络 ShengLuo — DSH 原生插件（Host 半个）。
 *
 * 只做四件事，别的一律交给 DSH 原生能力：
 * 1. 个人现实：Family Space 授权 + 只读检索（唯一通道，不碰 PRK / 不碰 Cookie / 不写对方数据）；
 * 2. 产品层网络：把真实项目、原生会话、成果、知识、目标、待决定投影成少量语义节点与人话关系；
 * 3. 给主 Agent 的工具（与 UI 同一套实现）；
 * 4. 面板用的本机接口（/sl/api，仅本机回环 + DSH 自己的连接信任校验）。
 *
 * 执行不用自己造：会话创建/续接/事件/审批/文件预览全部是 DSH 原生的。
 * 插件不注册独立 TaskRunner，也不维护第二套会话系统。
 */
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

import { FamilySpace } from './lib/family-space.mjs'
import { buildNetwork } from './lib/network.mjs'
import { readProfileContext, shengluoDataDir } from './lib/paths.mjs'
import { RealityProjection } from './lib/reality.mjs'
import { readGoals, readKnowledge, readWorkspaces, scanArtifacts, summarizeToolCall } from './lib/sources.mjs'
import { Store } from './lib/store.mjs'
import { registerTools } from './lib/tools.mjs'
import { failure, nowIso, safeRelative, shortHash, text } from './lib/util.mjs'

export const inject = ['webServer', 'tools', 'credentials']

const PREFIX = '/sl/api'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MAX_BODY = 1024 * 1024

/** 从自己的 package.json 读版本：health 必须报真实装着的版本，不能写死（升级验收靠它）。 */
const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? '0.0.0' } catch { return '0.0.0' }
})()
const ARTIFACT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.pdf', 'application/pdf'],
])
const OPENABLE = new Set(ARTIFACT_TYPES.keys())

/** 会话事件 → 这次「正在做什么」的人话。只翻译真实发生的事，不播动画。 */
const PHASE_OF_TOOL = new Map([
  ['read', 'calling'], ['glob', 'calling'], ['grep', 'calling'], ['web_search', 'calling'], ['web_fetch', 'calling'],
  ['write', 'executing'], ['edit', 'executing'], ['pwsh', 'executing'], ['bash', 'executing'], ['subagent', 'executing'],
  ['present', 'verifying'], ['todo_write', 'understanding'],
])

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const readBody = (req, max = MAX_BODY) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return }
    chunks.push(chunk)
  })
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return resolve({})
    try { resolve(JSON.parse(raw)) } catch { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })) }
  })
  req.on('error', reject)
})

async function readConfig(ctx) {
  // 从 patch 行的 config 拿；环境变量只用于隔离测试（mock 服务器），不是产品路径。
  const seed = (ctx?.__shengluoConfig ?? {}) || {}
  // 默认直连线上集成接口（Family Space 已上线：https://ymai.love/api/integrations/shengluo）。
  const baseUrl = text(process.env.SL_FS_BASE_URL) || text(seed.familySpaceBaseUrl)
    || 'https://ymai.love/api/integrations/shengluo'
  const dataDir = text(process.env.SL_DATA_DIR) || shengluoDataDir()
  return {
    familySpaceBaseUrl: baseUrl,
    dataDir,
    knowledgeDir: text(process.env.SL_MKI_DIR) || text(seed.knowledgeDir) || '',
    maxVisibleNodes: Math.max(5, Math.min(Number(seed.maxVisibleNodes ?? 9) || 9, 9)),
    artifactRoots: Array.isArray(seed.artifactRoots) ? seed.artifactRoots.filter((p) => typeof p === 'string') : [],
  }
}

export function apply(ctx, config = {}) {
  ctx.__shengluoConfig = config
  const log = {
    info: (message) => ctx.logger?.info?.('shengluo: ' + message),
    warn: (message) => ctx.logger?.warn?.('shengluo: ' + message),
    debug: (message) => ctx.logger?.debug?.('shengluo: ' + message),
  }

  let cfg = null
  const hub = new EventEmitter()
  hub.setMaxListeners(64)

  const runtime = {
    ready: false,
    store: null,
    familySpace: null,
    reality: null,
    network: null,
    profile: null,
    config: null,
    runs: new Map(), // sessionId -> runId
    decisions: new Map(), // approvalId -> decision
    activity: [], // 最近真实工具调用
    startedAt: nowIso(),
  }

  const broadcast = (type, payload) => {
    try { hub.emit('event', { type, at: nowIso(), ...payload }) } catch { /* 一个断开的流不能影响执行 */ }
  }

  // ——————————————————— 启动 ———————————————————

  const boot = async () => {
    cfg = await readConfig(ctx)
    runtime.config = cfg
    runtime.store = new Store(cfg.dataDir)
    runtime.profile = readProfileContext(ctx)
    runtime.familySpace = new FamilySpace({ ctx, store: runtime.store, config: { baseUrl: cfg.familySpaceBaseUrl }, logger: log })
    runtime.reality = new RealityProjection({ familySpace: runtime.familySpace, store: runtime.store })
    runtime.network = {
      snapshot: async ({ includeHidden = false } = {}) => networkSnapshot({ includeHidden }),
    }
    runtime.ready = true
    log.info('host half ready (data dir: ' + cfg.dataDir + ')')

    // 工具注册：和 UI 走同一套实现。
    const disposeTools = registerTools(ctx, { reality: runtime.reality, network: runtime.network, logger: log })
    ctx.effect(() => disposeTools, 'shengluo: agent tools')
  }

  // ——————————————————— 网络投影 ———————————————————

  const activeSessionId = () => {
    const run = runtime.store?.activeRun()
    return run?.sessionId ?? null
  }

  const networkSnapshot = async ({ includeHidden = false } = {}) => {
    const store = runtime.store
    const realityNode = await runtime.reality.node()
    const realityStatus = await runtime.reality.status()
    const active = store.activeRun()
    const sessionId = active?.sessionId ?? null

    // 会话 cwd：优先原生 session header，其次 run 记录的 cwd。
    let activeCwd = active?.cwd ?? null
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (!activeCwd && sessionId && agents?.get) {
      try { activeCwd = text(agents.get(sessionId)?.session?.header?.cwd) || null } catch { activeCwd = null }
    }

    const workspaces = readWorkspaces(ctx, activeCwd)
    const goals = readGoals(ctx)
    const knowledge = readKnowledge({ knowledgeDir: runtime.config?.knowledgeDir })
    // 成果：只在真实工作区目录里找，且只要这次开始之后动过的。
    // 没有正在推进的事时只看最近几个项目，别把整台机器扫一遍。
    const roots = new Set()
    if (activeCwd) roots.add(activeCwd)
    for (const workspace of workspaces.slice(0, activeCwd ? 1 : 3)) {
      if (workspace.active || !activeCwd) roots.add(workspace.path)
    }
    for (const extra of runtime.config?.artifactRoots ?? []) roots.add(extra)
    const since = active?.startedAt ? Date.parse(active.startedAt) : 0
    const artifacts = scanArtifacts({ roots: [...roots], since, limit: active ? 8 : 3, runId: active?.runId ?? null })
      .filter((artifact) => !artifact.path.startsWith('.'))
      .map((artifact) => ({ ...artifact, fromRun: Boolean(active) }))

    const runs = store.recentRuns(6).map((run) => ({
      ...run,
      toolCalls: run.toolCalls ?? 0,
    }))

    const decisions = runtime.decisions.size > 0
      ? [...runtime.decisions.values()].slice(-6)
      : (active?.decisions ?? []).slice(-6)

    const network = buildNetwork({
      realityNode,
      realityAuthorized: realityStatus.state === 'authorized',
      realityFacts: realityStatus.state === 'authorized' ? runtime.reality.factNodes(4) : [],
      workspaces,
      goals,
      runs,
      knowledge,
      artifacts,
      decisions,
      curated: store.get().relations,
      focusGoal: active?.goal ?? null,
      maxVisible: runtime.config?.maxVisibleNodes ?? 9,
    })

    const visible = includeHidden ? network.nodes : network.nodes.filter((node) => network.visibleIds.includes(node.id))
    return {
      focus: active?.goal ?? null,
      focusStatus: active?.status ?? null,
      nodes: visible,
      edges: includeHidden ? network.edges : network.visibleEdges,
      hiddenCount: network.hiddenCount,
      realityState: realityStatus.state,
      understanding: runtime.reality.understanding(),
      artifacts,
      workspaces,
      knowledge,
      runs,
      decisions,
      activity: runtime.activity.slice(-8),
    }
  }

  // ——————————————————— 原生会话事件（真实执行） ———————————————————

  const onSessionEvent = (session, event) => {
    if (!runtime.ready || !runtime.store) return
    const sessionId = text(session?.id)
    if (!sessionId) return
    const runId = runtime.runs.get(sessionId)
    if (!runId) return
    const run = runtime.store.get().runs[runId]
    if (!run) return

    try {
      if (event.type === 'tool/call') {
        const data = event.data ?? {}
        const activity = summarizeToolCall(text(data.name), text(data.arguments))
        runtime.activity.push({ at: nowIso(), sessionId, ...activity })
        if (runtime.activity.length > 40) runtime.activity = runtime.activity.slice(-40)
        const phase = PHASE_OF_TOOL.get(text(data.name)) ?? 'executing'
        runtime.store.patchRun(runId, { phase, toolCalls: (run.toolCalls ?? 0) + 1, lastActivity: activity })
        broadcast('run/activity', { runId, sessionId, activity, phase })
        return
      }
      if (event.type === 'tool/result') {
        const data = event.data ?? {}
        const failed = Boolean(data.error)
        broadcast('run/tool-result', {
          runId, sessionId,
          isError: failed,
          error: failed ? text(data.error?.message) || text(data.error?.code) : null,
        })
        return
      }
      if (event.type === 'approval/asked') {
        const data = event.data ?? {}
        const decision = {
          id: text(data.id) || 'approval-' + shortHash(sessionId + String(event.seq)),
          title: '需要你决定：' + (text(data.toolName) || '一个动作'),
          detail: text(data.reason) || '这一步要你点了才会往下走。',
          at: nowIso(),
          sessionId,
          approvalId: text(data.id) || null,
        }
        runtime.decisions.set(decision.id, decision)
        runtime.store.addDecision(runId, decision)
        runtime.store.patchRun(runId, { phase: 'waiting-for-you' })
        broadcast('run/decision', { runId, sessionId, decision })
        return
      }
      if (event.type === 'approval/decided') {
        const data = event.data ?? {}
        const id = text(data.id)
        const outcome = text(data.outcome)
        if (id && runtime.decisions.has(id)) runtime.decisions.delete(id)
        runtime.store.addDecision(runId, {
          id: id || 'decided-' + shortHash(String(event.seq)),
          title: '你的决定：' + (outcome === 'allowed-once' ? '允许一次' : outcome === 'rejected' ? '拒绝' : outcome || '已结束'),
          detail: outcome === 'rejected' ? '我按你的拒绝停下了，没有继续。' : '',
          at: nowIso(),
          sessionId,
          resolved: true,
        })
        runtime.store.patchRun(runId, { phase: outcome === 'rejected' ? 'stopped-by-owner' : 'executing' })
        if (outcome === 'rejected') {
          // 被拒绝这件事必须留在这次运行的记录里：一轮对话可能仍然「正常结束」，
          // 但这件事对本人来说是「我拒绝了，所以它没做成」，不能算完成。
          runtime.store.patchRun(runId, { approvalRejected: true, lastDecision: 'rejected', note: '你拒绝了这一步，我没有继续做。' })
        }
        broadcast('run/approval-decided', { runId, sessionId, outcome })
        return
      }
      if (event.type === 'turn/end') {
        const data = event.data ?? {}
        const reason = text(data.reason?.kind) || 'completed'
        const run = runtime.store.get().runs[runId]
        const rejected = Boolean(run?.approvalRejected)
        // 只有真正 completed、并且没有被本人拒绝过，才算完成。
        // 报错 / 被掐断 / 卡住 / 本人拒绝，一律如实记成失败，不能因为「一轮结束了」就宣称做完了。
        const status = reason === 'completed' && !rejected ? 'completed' : 'failed'
        const note = rejected
          ? '你拒绝了这一步，所以这件事没有做成——这是你的决定，我按它停下了。'
          : reason === 'error'
            ? (text(data.reason?.error?.message) || '模型请求失败')
            : reason
        runtime.store.patchRun(runId, {
          status,
          phase: status === 'completed' ? 'completed' : 'stopped',
          endedAt: nowIso(),
          endReason: rejected ? 'approval-rejected' : reason,
          endNote: note || null,
        })
        broadcast('run/end', { runId, sessionId, status, reason: rejected ? 'approval-rejected' : reason, note: note || null })
      }
    } catch (error) {
      log.warn('session event handling failed: ' + text(error && error.message))
    }
  }

  // ——————————————————— 信任校验 ———————————————————

  const rejectUntrusted = (req, res) => {
    if (!LOOPBACK.has(text(req.socket?.remoteAddress))) {
      json(res, 403, { ok: false, error: 'loopback only' })
      return true
    }
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (!connection || typeof connection.requestRejection !== 'function') {
      json(res, 503, { ok: false, error: 'host connection trust unavailable' })
      return true
    }
    let rejection
    try {
      rejection = connection.requestRejection({ headers: req.headers })
    } catch (error) {
      json(res, 403, { ok: false, error: 'trust check failed: ' + text(error && error.message) })
      return true
    }
    if (rejection !== undefined && rejection !== null) {
      json(res, rejection, { ok: false, error: rejection === 401 ? 'authentication required' : 'forbidden' })
      return true
    }
    return false
  }

  // ——————————————————— HTTP 面板接口 ———————————————————

  const serveArtifact = async (req, res, url) => {
    const wanted = safeRelative(url.searchParams.get('path') ?? '')
    if (!wanted) return json(res, 400, { ok: false, error: 'path is required' })
    if (!OPENABLE.has(extname(wanted).toLowerCase())) return json(res, 415, { ok: false, error: 'not a previewable file type' })

    const snapshot = await networkSnapshot({ includeHidden: true })
    const allowedRoots = new Set([
      ...snapshot.artifacts.map((artifact) => artifact.root),
      ...(snapshot.workspaces.map((workspace) => workspace.path)),
      ...((runtime.config?.artifactRoots) ?? []),
    ])
    for (const root of allowedRoots) {
      const absolute = join(root, wanted)
      const rel = relative(root, absolute)
      if (rel.startsWith('..') || rel.includes(':')) continue
      if (!existsSync(absolute)) continue
      try {
        const info = statSync(absolute)
        if (!info.isFile() || info.size > 32 * 1024 * 1024) continue
        const body = await readFile(absolute)
        res.writeHead(200, {
          'content-type': ARTIFACT_TYPES.get(extname(absolute).toLowerCase()) ?? 'application/octet-stream',
          'content-length': body.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        res.end(body)
        return undefined
      } catch { continue }
    }
    return json(res, 404, { ok: false, error: 'artifact not found in any known workspace' })
  }

  const handle = async (req, res) => {
    if (rejectUntrusted(req, res)) return undefined
    if (!runtime.ready) return json(res, 503, { ok: false, error: 'shengluo host half is still starting' })

    const url = new URL(req.url ?? '/', 'http://host.local')
    const path = url.pathname.replace(/\/+$/, '')
    const method = req.method ?? 'GET'

    if (path === PREFIX + '/health') {
      return json(res, 200, {
        ok: true,
        plugin: '@shengluo/dsh-plugin',
        version: PLUGIN_VERSION,
        startedAt: runtime.startedAt,
        profile: runtime.profile,
        dataDir: runtime.config.dataDir,
        familySpaceBaseUrl: runtime.config.familySpaceBaseUrl,
      })
    }

    if (path === PREFIX + '/state' && method === 'GET') {
      const [realityStatus, network] = await Promise.all([
        runtime.reality.status(),
        networkSnapshot({ includeHidden: url.searchParams.get('hidden') === '1' }),
      ])
      return json(res, 200, {
        ok: true,
        at: nowIso(),
        reality: realityStatus,
        network,
        prefs: runtime.store.get().prefs,
        activeRun: runtime.store.activeRun(),
        recentRuns: runtime.store.recentRuns(8),
        profile: runtime.profile,
        dataDir: runtime.config.dataDir,
      })
    }

    if (path === PREFIX + '/stream' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write(': connected\n\n')
      const listener = (event) => { try { res.write('data: ' + JSON.stringify(event) + '\n\n') } catch { /* client gone */ } }
      hub.on('event', listener)
      const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n') } catch { /* client gone */ } }, 15000)
      req.on('close', () => { clearInterval(heartbeat); hub.off('event', listener) })
      return undefined
    }

    // —— 授权（用户动作，只从面板发起；不注册成工具）——
    if (path === PREFIX + '/reality/connect' && method === 'POST') {
      const started = await runtime.familySpace.beginDeviceAuth()
      broadcast('reality/pending', { userCode: started.userCode })
      return json(res, 200, { ok: true, ...started })
    }
    if (path === PREFIX + '/reality/poll' && method === 'POST') {
      const result = await runtime.familySpace.pollDeviceAuth()
      if (result.state === 'linked') broadcast('reality/linked', { scopes: result.scopes })
      return json(res, 200, { ok: true, ...result })
    }
    if (path === PREFIX + '/reality/cancel' && method === 'POST') {
      runtime.familySpace.cancelDeviceAuth()
      return json(res, 200, { ok: true })
    }
    if (path === PREFIX + '/reality/revoke' && method === 'POST') {
      const result = await runtime.reality.revoke()
      broadcast('reality/revoked', {})
      return json(res, 200, result)
    }
    if (path === PREFIX + '/reality/query' && method === 'POST') {
      const body = await readBody(req)
      const result = await runtime.reality.query({
        task: body.task,
        limit: body.limit,
        timeRange: body.timeRange ?? null,
        conversationIds: Array.isArray(body.conversationIds) ? body.conversationIds : null,
      })
      return json(res, 200, result)
    }
    if (path === PREFIX + '/reality/conversation' && method === 'POST') {
      const body = await readBody(req)
      const result = await runtime.reality.readConversation(body.conversationId)
      return json(res, 200, result)
    }

    // —— 网络策展（用户动作）——
    if (path === PREFIX + '/network/relation' && method === 'POST') {
      const body = await readBody(req)
      const from = text(body.from)
      const to = text(body.to)
      const relation = text(body.relation).slice(0, 64)
      if (!from || !to || !relation) return json(res, 400, { ok: false, error: 'from, to, relation are required' })
      await runtime.store.addRelation({ from, to, relation, note: text(body.note).slice(0, 500) })
      broadcast('network/changed', {})
      return json(res, 200, { ok: true })
    }
    if (path === PREFIX + '/network/refresh' && method === 'POST') {
      broadcast('network/changed', {})
      return json(res, 200, { ok: true, network: await networkSnapshot() })
    }
    if (path === PREFIX + '/prefs' && method === 'POST') {
      const body = await readBody(req)
      await runtime.store.setPrefs(body)
      return json(res, 200, { ok: true, prefs: runtime.store.get().prefs })
    }

    // —— 正在推进的事：只登记真实原生会话的 id，不自己跑执行 ——
    if (path === PREFIX + '/run/start' && method === 'POST') {
      const body = await readBody(req)
      const sessionId = text(body.sessionId)
      const goal = text(body.goal).slice(0, 2000)
      if (!sessionId) return json(res, 400, { ok: false, error: 'sessionId is required' })
      if (!goal) return json(res, 400, { ok: false, error: 'goal is required' })
      const runId = await runtime.store.startRun({ sessionId, goal, cwd: text(body.cwd) || null })
      runtime.runs.set(sessionId, runId)
      broadcast('run/start', { runId, sessionId, goal })
      return json(res, 200, { ok: true, runId })
    }
    if (path === PREFIX + '/run/status' && method === 'POST') {
      const body = await readBody(req)
      const run = runtime.store.activeRun()
      if (!run) return json(res, 404, { ok: false, error: 'no active run' })
      const patch = {}
      if (body.status) patch.status = text(body.status)
      if (body.phase) patch.phase = text(body.phase)
      if (body.endReason) patch.endReason = text(body.endReason)
      const next = await runtime.store.patchRun(run.runId, patch)
      broadcast('run/end', { runId: run.runId, sessionId: run.sessionId, status: next?.status ?? null, reason: text(body.endReason) || null })
      return json(res, 200, { ok: true, run: next })
    }

    // —— 成果：真机文件，只读白名单里的目录 ——
    if (path === PREFIX + '/artifact' && method === 'GET') return serveArtifact(req, res, url)

    return json(res, 404, { ok: false, error: 'unknown route ' + path })
  }

  // ——————————————————— 安装 ———————————————————

  ctx.effect(() => {
    const disposeOn = ctx.on('session/event', onSessionEvent)
    return () => { try { disposeOn() } catch { /* already disposed */ } }
  }, 'shengluo: native session events')

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      handle(req, res).catch((error) => {
        log.warn('api ' + text(req.url) + ' failed: ' + text(error && error.stack ? error.stack : error))
        try { json(res, Number(error && error.status) || 500, { ok: false, error: text(error && error.message) || 'internal error' }) } catch { /* headers already sent */ }
      })
    },
  })
  ctx.effect(() => disposeRoute, 'shengluo: local panel api')

  boot().catch((error) => {
    log.warn('boot failed: ' + text(error && error.stack ? error.stack : error))
    broadcast('plugin/error', failure(error))
  })

  log.info('plugin activated')
}
