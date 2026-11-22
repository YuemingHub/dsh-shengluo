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
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'

import { reduceSessionEvent } from './lib/events.mjs'
import { readProjectRegistry, matchProjects } from './lib/agent-space.mjs'
import { SHENGLUO_PRESET, probePreset, sessionApiCapability } from './lib/session.mjs'
import { describeRunWorkspace, resolveRunCwd } from './lib/workspace.mjs'
import { FamilySpace } from './lib/family-space.mjs'
import { knowledgeSummary, searchKnowledge } from './lib/knowledge.mjs'
import { buildNetwork } from './lib/network.mjs'
import { buildToday } from './lib/today.mjs'
import { compileUnderstanding, sourceRefsFromReality } from './lib/understanding.mjs'
import { gitState } from './lib/gitstate.mjs'
import { readProfileContext, shengluoDataDir } from './lib/paths.mjs'
import { RealityProjection } from './lib/reality.mjs'
import { readGoals, readWorkspaces, scanArtifacts, summarizeToolCall } from './lib/sources.mjs'
import { Store } from './lib/store.mjs'
import { registerTools } from './lib/tools.mjs'
import { buildCandidates, decideOutcome } from './lib/workloop.mjs'
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
  ['.scss', 'text/plain; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.jsx', 'text/plain; charset=utf-8'],
  ['.ts', 'text/plain; charset=utf-8'],
  ['.tsx', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.yml', 'text/plain; charset=utf-8'],
  ['.yaml', 'text/plain; charset=utf-8'],
  ['.toml', 'text/plain; charset=utf-8'],
  ['.xml', 'text/plain; charset=utf-8'],
  ['.sh', 'text/plain; charset=utf-8'],
  ['.ps1', 'text/plain; charset=utf-8'],
  ['.py', 'text/plain; charset=utf-8'],
  ['.go', 'text/plain; charset=utf-8'],
  ['.rs', 'text/plain; charset=utf-8'],
  ['.java', 'text/plain; charset=utf-8'],
  ['.kt', 'text/plain; charset=utf-8'],
  ['.sql', 'text/plain; charset=utf-8'],
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
    // V2.1：知识正式架构是 MKI 服务；本地 Markdown 只在显式开发模式下作为降级。
    mkiBaseUrl: text(process.env.MKI_BASE_URL) || text(seed.mkiBaseUrl) || '',
    mkiApiKey: text(process.env.MKI_API_KEY) || text(seed.mkiApiKey) || '',
    knowledgeLocalEnabled: String(process.env.SL_MKI_LOCAL ?? '') === '1' || seed.knowledgeLocalEnabled === true,
    // V2.1：Agent Space 项目登记（只读，项目定位与下一步路由入口）。
    agentSpaceRegistry: text(process.env.SL_AGENT_SPACE_REGISTRY) || text(seed.agentSpaceRegistry) || '',
    // 项目本地根目录（只用于把已登记仓库解析成本机路径；不写进持久化）。
    projectRoots: (() => {
      const raw = text(process.env.SL_PROJECT_ROOTS) || (Array.isArray(seed.projectRoots) ? seed.projectRoots.join(';') : text(seed.projectRoots))
      return raw.split(';').map((item) => item.trim()).filter(Boolean)
    })(),
    // 会话工作区：只允许显式根目录内，且没有选择时绝不回退到活动工作区。
    runWorkspaceRoots: (() => {
      const raw = text(process.env.SL_RUN_WORKSPACE_ROOTS) || (Array.isArray(seed.runWorkspaceRoots) ? seed.runWorkspaceRoots.join(';') : text(seed.runWorkspaceRoots))
      return raw.split(';').map((item) => item.trim()).filter(Boolean)
    })(),
    defaultRunCwd: text(process.env.SL_RUN_CWD) || text(seed.defaultRunCwd) || '',
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
    replies: new Map(), // runId -> { text, at }：最终答复只留内存，不落盘
    today: null, // Today 扫描结果只留内存，不落盘
    understandings: new Map(), // runId -> { block, at }：理解正文只留内存
    candidateText: new Map(), // candidateId -> { content, detail }：候选正文只留内存
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
    const disposeTools = registerTools(ctx, { reality: runtime.reality, network: runtime.network, config: cfg, logger: log, store: runtime.store })
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
    const knowledgeState = knowledgeSummary(runtime.config)
    const knowledge = knowledgeState.files
    // Agent Space 项目登记：只读，按当前任务匹配几个相关项目（不复制项目状态）。
    let registry = { state: 'not_configured', projects: [], routes: [] }
    try { registry = readProjectRegistry(runtime.config) } catch { /* 读不到就当未连接 */ }
    const registryProjects = registry.state === 'connected' ? matchProjects(registry, active?.goal ?? '', 2) : []
    // 成果：只在真实工作区目录里找，且只要这次开始之后动过的。
    // 没有正在推进的事时只看最近几个项目，别把整台机器扫一遍。
    const roots = new Set()
    if (activeCwd) roots.add(activeCwd)
    for (const workspace of workspaces.slice(0, activeCwd ? 1 : 3)) {
      if (workspace.active || !activeCwd) roots.add(workspace.path)
    }
    for (const extra of runtime.config?.artifactRoots ?? []) roots.add(extra)
    const since = active?.startedAt ? Date.parse(active.startedAt) : 0
    // V2.1：成果只属于「本次任务」——没有进行中的事，就不把工作区里的旧文件当成果。
    const scanArtifactsOn = Boolean(active?.startedAt)
    const artifacts = scanArtifactsOn ? scanArtifacts({ roots: [...roots], since, limit: 8, runId: active?.runId ?? null }) : []
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
      registryProjects,
      understandings: store.recentUnderstandings(5),
      corrections: store.corrections(),
      focusGoal: active?.goal ?? null,
      maxVisible: runtime.config?.maxVisibleNodes ?? 9,
    })

    const memoryUnderstanding = active ? runtime.understandings.get(active.runId) : null
    const activeView = active ? { ...active, understanding: memoryUnderstanding?.block ?? null } : null
    const memoryCandidates = (active?.candidates ?? []).map((candidate) => ({
      ...candidate,
      content: runtime.candidateText.get(candidate.id)?.content ?? null,
      detail: runtime.candidateText.get(candidate.id)?.detail ?? null,
    }))
    const visible = includeHidden ? network.nodes : network.nodes.filter((node) => network.visibleIds.includes(node.id))
    const memoryReply = active ? runtime.replies.get(active.runId) : null
    return {
      focus: active?.goal ?? null,
      // 最终答复只来自内存；进程重启后为 null，UI 会请本人回原生会话看。
      finalReply: memoryReply?.text ?? null,
      finalReplyAt: memoryReply?.at ?? null,
      focusStatus: active?.status ?? null,
      nodes: visible,
      edges: includeHidden ? network.edges : network.visibleEdges,
      hiddenCount: network.hiddenCount,
      realityState: realityStatus.state,
      understanding: runtime.reality.understanding(activeView, memoryUnderstanding?.block ?? null),
      understandingMeta: {
        source: active?.understandingSource ?? null,
        invalid: active?.understandingInvalid ?? null,
        missing: active?.understandingMissing === true,
        realityNote: runtime.reality.overview(),
      },
      knowledgeState: {
        state: knowledgeState.state,
        source: knowledgeState.source ?? null,
        dir: knowledgeState.dir,
        totalChunks: knowledgeState.totalChunks,
        indexedAt: knowledgeState.indexedAt ?? null,
      },
      registryState: {
        state: registry.state,
        total: Array.isArray(registry.projects) ? registry.projects.length : 0,
        at: registry.at ?? null,
      },
      steps: active?.steps ?? [],
      verifications: active?.verifications ?? [],
      candidates: memoryCandidates,
      corrections: runtime.store.corrections(),
      understandings: runtime.store.recentUnderstandings(5),
      action: active?.action ?? null,
      report: active?.report ?? null,
      endNote: active?.endNote ?? null,
      artifacts,
      workspaces,
      knowledge,
      runs,
      decisions,
      activity: runtime.activity.slice(-8),
    }
  }

  // ——————————————————— Today 主动发现（打开面板时扫描，只留内存） ———————————————————

  const TODAY_TASK = '最近发生的重要变化、还没处理的事情和决定'
  const TODAY_TTL = 60 * 1000

  const withTimeout = async (promise, ms, message) => {
    let timer = null
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const gitFacts = (cwd) => {
    try {
      const head = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim()
      const last = execFileSync('git', ['-C', cwd, 'log', '-1', '--format=%cI|%s'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim()
      const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim()
      const changed = status ? status.split(/\r?\n/).filter(Boolean).slice(0, 12) : []
      const [lastAt, ...subject] = last.split('|')
      return { head, lastAt: lastAt || null, lastSubject: subject.join('|') || '', dirty: changed.length > 0, changed }
    } catch { return null }
  }

  const scanToday = async ({ force = false } = {}) => {
    if (!runtime.ready || !runtime.store) {
      return { at: nowIso(), state: 'empty', items: [], note: '生络还没有准备好。', errors: [], realityState: 'unknown' }
    }
    const cached = runtime.today
    if (!force && cached?.at && Date.now() - Date.parse(cached.at) < TODAY_TTL) return cached
    const errors = []
    const store = runtime.store
    const active = store.activeRun()
    let activeCwd = active?.cwd ?? null
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (!activeCwd && active?.sessionId && agents?.get) {
      try { activeCwd = text(agents.get(active.sessionId)?.session?.header?.cwd) || null } catch { activeCwd = null }
    }

    let realityStatus = { state: 'unknown' }
    try { realityStatus = await runtime.reality.status() } catch { /* 读不到按未知处理 */ }
    let reality = { state: realityStatus.state, results: [], error: null }
    if (realityStatus.state === 'authorized') {
      try {
        const outcome = await withTimeout(
          runtime.familySpace.queryReality({ task: TODAY_TASK, limit: 8 }),
          8000,
          '个人现实查询超时',
        )
        if (outcome.ok) {
          reality = { state: outcome.state ?? 'authorized', results: outcome.results ?? [], error: null }
        } else {
          reality = { state: outcome.state ?? 'error', results: [], error: outcome.detail ?? '个人现实没有读到' }
          if (outcome.state === 'error') errors.push(reality.error)
        }
      } catch (error) {
        errors.push('个人现实这次没读成：' + error.message)
      }
    }

    const workspaces = readWorkspaces(ctx, activeCwd)
    const projects = workspaces.slice(0, 3).map((workspace) => ({
      path: workspace.path,
      title: workspace.title,
      git: gitFacts(workspace.path),
    }))
    const runs = store.recentRuns(10)
      .filter((run) => ['running', 'waiting-for-you', 'verifying'].includes(run.status))
      .map((run) => ({ runId: run.runId, sessionId: run.sessionId, goal: run.goal, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt ?? null }))
    const decisions = (runtime.decisions.size > 0 ? [...runtime.decisions.values()] : (active?.decisions ?? []))
      .filter((decision) => !decision.resolved)
      .map((decision) => ({ id: decision.id, title: decision.title, detail: decision.detail, at: decision.at, runId: decision.runId ?? active?.runId ?? null, sessionId: decision.sessionId ?? active?.sessionId ?? null }))
    const knowledge = knowledgeSummary(runtime.config)
    const today = buildToday({
      now: nowIso(),
      reality,
      activeGoal: active?.goal ?? null,
      runs,
      decisions,
      projects,
      knowledge: { state: knowledge.state, files: knowledge.files ?? [] },
      errors,
    })
    runtime.today = today
    broadcast('today/changed', { today })
    return today
  }

  // ——————————————————— 原生会话事件（真实执行） ———————————————————

  const toSha256 = (absolutePath) => {
    try {
      const body = readFileSync(absolutePath)
      if (body.length > 32 * 1024 * 1024) return null
      return createHash('sha256').update(body).digest('hex')
    } catch { return null }
  }

  /** turn/end 之后才是终态：先扫真实成果，再按验收规则判定（不用会话结束冒充完成）。 */
  const finishRun = async (runId, sessionId, turnReason) => {
    const run = runtime.store.get().runs[runId]
    if (!run) return
    let cwd = text(run.cwd)
    if (!cwd) {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      try { cwd = text(agents?.get?.(sessionId)?.session?.header?.cwd) } catch { cwd = '' }
    }
    const since = run.startedAt ? Date.parse(run.startedAt) : 0
    const roots = new Set()
    if (cwd) roots.add(cwd)
    for (const extra of runtime.config?.artifactRoots ?? []) roots.add(extra)
    let scanned = []
    // 只有这次真的动过手（写/编辑/命令）才扫成果；纯答复任务不该把工作区旧文件当成果。
    // 没有 startedAt 也不扫：历史文件不能被误当成「这次做出来的」。
    const steps = Array.isArray(run.steps) ? run.steps : []
    const didWrite = steps.some((step) => ['write', 'edit', 'bash', 'pwsh'].includes(step.name))
    try { if (since > 0 && didWrite) scanned = scanArtifacts({ roots: [...roots], since, limit: 12, runId }) } catch { scanned = [] }
    const artifacts = scanned.map((artifact) => ({
      path: artifact.path,
      absolutePath: artifact.absolutePath,
      root: artifact.root,
      exists: true,
      size: artifact.size,
      modifiedAt: artifact.modifiedAt,
      duringRun: since ? Date.parse(artifact.modifiedAt) >= since : true,
      sha256: toSha256(artifact.absolutePath),
    }))
    const memoryUnderstanding = runtime.understandings.get(runId)?.block ?? null
    const runForOutcome = { ...run, understanding: memoryUnderstanding }
    const TEST_COMMAND = /(?:npm (?:run )?test|yarn test|pnpm test|pytest|go test|cargo test|vitest|jest|node tests\/)/i
    const tests = steps
      .filter((step) => (step.name === 'pwsh' || step.name === 'bash') && TEST_COMMAND.test(String(step.target ?? '')))
      .map((step) => ({
        command: step.target,
        name: step.name,
        ok: step.status === 'ok' && !/\b(fail(?:ed)?|error|not ok)\b/i.test(String(step.resultSummary ?? '')),
        at: step.endedAt ?? null,
      }))
    const changes = { git: { before: run.workspaceBaseline ?? null, after: gitState(cwd) }, tests }
    const outcome = decideOutcome({ run: runForOutcome, turnReason, artifacts, changes })
    const candidates = buildCandidates({ ...runForOutcome, runId, artifacts })
    for (const candidate of candidates) {
      runtime.candidateText.set(candidate.id, { content: candidate.content ?? null, detail: candidate.detail ?? null })
    }
    const candidateMeta = candidates.map(({ content, detail, ...rest }) => rest)
    const report = outcome.report
      ? (() => { const { understanding, next, ...rest } = outcome.report; return rest })()
      : null
    const indexEntry = compileUnderstanding({
      runId,
      at: nowIso(),
      block: memoryUnderstanding,
      sources: sourceRefsFromReality(runtime.reality.last),
    })
    if (indexEntry) await runtime.store.upsertUnderstanding(indexEntry)
    runtime.store.patchRun(runId, {
      status: outcome.status,
      phase: outcome.phase,
      action: outcome.action,
      endedAt: nowIso(),
      endReason: outcome.endReason,
      endNote: outcome.endNote || null,
      verifications: outcome.verifications,
      report,
      workspaceChanges: outcome.changeVerification ?? null,
      artifacts: artifacts.map((item) => ({ path: item.path, size: item.size, sha256: item.sha256, modifiedAt: item.modifiedAt })),
      candidates: candidateMeta,
    })
    broadcast('run/end', { runId, sessionId, status: outcome.status, reason: outcome.endReason, note: outcome.endNote || null })
    if (outcome.verifications.length > 0) broadcast('run/verified', { runId, verifications: outcome.verifications })
  }

  const onSessionEvent = (session, event) => {
    if (!runtime.ready || !runtime.store) return
    const sessionId = text(session?.id)
    if (!sessionId) return
    const runId = runtime.runs.get(sessionId)
    if (!runId) return
    const run = runtime.store.get().runs[runId]
    if (!run) return

    try {
      const reduced = reduceSessionEvent(run, event, { summarizeCall: summarizeToolCall })
      if (reduced.patch && Object.keys(reduced.patch).length > 0) {
        // 最终答复只留内存：面板要能显示，但正文绝不写进 product-state.json。
        const { finalReply, finalReplyAt, understanding, ...persisted } = reduced.patch
        if (finalReply !== undefined) {
          runtime.replies.set(runId, { text: finalReply, at: finalReplyAt ?? nowIso() })
        }
        if (understanding !== undefined) {
          runtime.understandings.set(runId, { block: understanding, at: reduced.patch.understandingSource?.at ?? finalReplyAt ?? nowIso() })
        }
        if (Object.keys(persisted).length > 0) runtime.store.patchRun(runId, persisted)
      }

      if (event.type === 'tool/call') {
        const data = event.data ?? {}
        const activity = summarizeToolCall(text(data.name), text(data.arguments))
        runtime.activity.push({ at: nowIso(), sessionId, ...activity })
        if (runtime.activity.length > 40) runtime.activity = runtime.activity.slice(-40)
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
        broadcast('run/decision', { runId, sessionId, decision })
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
      }

      for (const item of reduced.broadcasts) broadcast(item.type, item.payload)

      if (reduced.finalize) finishRun(runId, sessionId, reduced.finalize.reason).catch((error) => log.warn('finishRun failed: ' + error.message))
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
      // 会话接口与 preset 要按“实际可用”报告，而不是按“服务目录里存在”报告。
      const sessionController = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
      // Host 侧只需要 create；retain 是 Client 侧接口，不在 Host 上要求。
      const session = sessionApiCapability(sessionController, { requireRetain: false })
      const preset = await probePreset(typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined, SHENGLUO_PRESET)
      return json(res, 200, {
        ok: true,
        plugin: '@shengluo/dsh-plugin',
        version: PLUGIN_VERSION,
        startedAt: runtime.startedAt,
        profile: runtime.profile,
        dataDir: runtime.config.dataDir,
        familySpaceBaseUrl: runtime.config.familySpaceBaseUrl,
        session,
        preset,
        runWorkspace: describeRunWorkspace({ defaultCwd: runtime.config.defaultRunCwd, roots: runtime.config.runWorkspaceRoots }),
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
        today: runtime.today,
        runWorkspace: describeRunWorkspace({ defaultCwd: runtime.config.defaultRunCwd, roots: runtime.config.runWorkspaceRoots }),
        corrections: runtime.store.corrections(),
        understandings: runtime.store.recentUnderstandings(5),
        recentRuns: runtime.store.recentRuns(8),
        profile: runtime.profile,
        dataDir: runtime.config.dataDir,
      })
    }

    if (path === PREFIX + '/today' && method === 'GET') {
      const today = await scanToday({ force: url.searchParams.get('refresh') === '1' })
      return json(res, 200, { ok: true, today })
    }
    if (path === PREFIX + '/today/scan' && method === 'POST') {
      const today = await scanToday({ force: true })
      return json(res, 200, { ok: true, today })
    }

    if (path === PREFIX + '/understanding/correct' && method === 'POST') {
      const body = await readBody(req)
      const runId = text(body.runId) || runtime.store.activeRun()?.runId || null
      const value = text(body.text).slice(0, 500)
      if (!value) return json(res, 400, { ok: false, error: 'text is required' })
      const entry = runId ? runtime.store.recentUnderstandings(50).find((item) => item.runId === runId) : null
      const correction = await runtime.store.addCorrection({ text: value, runId, sourceRefs: entry?.sources ?? [] })
      if (!correction) return json(res, 400, { ok: false, error: 'correction not saved' })
      broadcast('understanding/corrected', { correction })
      return json(res, 200, { ok: true, correction, corrections: runtime.store.corrections() })
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
      // 工作区必须显式解析：越界/缺失/未选择都拒绝，禁止静默回退。
      const workspace = resolveRunCwd({
        requested: text(body.cwd) || null,
        defaultCwd: runtime.config.defaultRunCwd,
        roots: runtime.config.runWorkspaceRoots,
      })
      if (!workspace.ok) return json(res, 400, { ok: false, code: workspace.code, error: workspace.detail })
      const runCwd = workspace.cwd
      const runId = await runtime.store.startRun({ sessionId, goal, cwd: runCwd, workspaceBaseline: gitState(runCwd) })
      runtime.runs.set(sessionId, runId)
      broadcast('run/start', { runId, sessionId, goal })
      return json(res, 200, { ok: true, runId })
    }
    if (path === PREFIX + '/run/status' && method === 'POST') {
      const body = await readBody(req)
      const run = runtime.store.activeRun()
      if (!run) return json(res, 404, { ok: false, error: 'no active run' })
      const patch = {}
      // completed / answered 只能由验收（finishRun）写；这条接口只留给「本人停下」。
      const ownerSettable = new Set(['failed', 'stopped-by-owner'])
      if (body.status) {
        const wanted = text(body.status)
        if (!ownerSettable.has(wanted)) {
          return json(res, 400, { ok: false, error: 'status completed/answered is decided by verification, not by this route' })
        }
        patch.status = wanted
      }
      if (body.phase) patch.phase = text(body.phase)
      if (body.endReason) patch.endReason = text(body.endReason)
      const next = await runtime.store.patchRun(run.runId, patch)
      broadcast('run/end', { runId: run.runId, sessionId: run.sessionId, status: next?.status ?? null, reason: text(body.endReason) || null })
      return json(res, 200, { ok: true, run: next })
    }

    // —— 工作记录与验收（真实 run 记录；「已完成」只来自验收）——
    if (path === PREFIX + '/runs' && method === 'GET') {
      return json(res, 200, { ok: true, runs: runtime.store.recentRuns(20) })
    }
    if (path === PREFIX + '/run/detail' && method === 'GET') {
      const runId = text(url.searchParams.get('id'))
      const run = runId ? runtime.store.get().runs[runId] : null
      if (!run) return json(res, 404, { ok: false, error: 'run not found' })
      return json(res, 200, { ok: true, run })
    }

    // —— 知识（MKI 只读检索）——
    if (path === PREFIX + '/knowledge' && method === 'GET') {
      return json(res, 200, { ok: true, ...knowledgeSummary(runtime.config) })
    }
    if (path === PREFIX + '/knowledge/search' && method === 'POST') {
      const body = await readBody(req)
      const result = await searchKnowledge(runtime.config, text(body.query), { limit: body.limit })
      return json(res, 200, result)
    }

    // —— 回流候选：本人确认后才写入工作区内的一处新文件；不覆盖已有文件 ——
    if (path === PREFIX + '/candidates/confirm' && method === 'POST') {
      const body = await readBody(req)
      const runId = text(body.runId)
      const candidateId = text(body.candidateId)
      const targetPath = safeRelative(text(body.targetPath))
      if (!runId || !candidateId) return json(res, 400, { ok: false, error: 'runId and candidateId are required' })
      if (!targetPath) return json(res, 400, { ok: false, error: 'targetPath must be a workspace-relative path' })
      const run = runtime.store.get().runs[runId]
      const candidate = Array.isArray(run?.candidates) ? run.candidates.find((item) => item.id === candidateId) : null
      if (!run || !candidate) return json(res, 404, { ok: false, error: 'candidate not found' })
      if (candidate.status === 'written') return json(res, 409, { ok: false, error: 'already written' })
      if (candidate.target?.kind === 'mki') return json(res, 409, { ok: false, error: 'MKI 还没有连接；知识候选只能保持草稿，不能写入' })
      const memory = runtime.candidateText.get(candidateId)
      if (!memory?.content) return json(res, 409, { ok: false, error: '候选正文只在原生会话里；重启后不能直接写入，请重新生成候选' })
      const root = text(run.cwd) || text(runtime.config?.artifactRoots?.[0])
      if (!root) return json(res, 409, { ok: false, error: 'no workspace root for this run' })
      const absolute = join(root, targetPath)
      const rel = relative(root, absolute)
      if (rel.startsWith('..') || rel.includes(':')) return json(res, 400, { ok: false, error: 'path escapes workspace' })
      if (existsSync(absolute)) return json(res, 409, { ok: false, error: 'target already exists; choose another path' })
      const detail = memory.detail ?? {}
      const lines = [
        '# ' + memory.content,
        '',
        '> 由生络在 ' + nowIso() + ' 按本人确认写入。来源：run ' + runId + '。',
        '',
      ]
      if (Array.isArray(detail.known) && detail.known.length) lines.push('## 依据', ...detail.known.map((item) => '- ' + item), '')
      if (Array.isArray(detail.inference) && detail.inference.length) lines.push('## 推断（不是事实）', ...detail.inference.map((item) => '- ' + item), '')
      if (Array.isArray(detail.unknown) && detail.unknown.length) lines.push('## 还不知道', ...detail.unknown.map((item) => '- ' + item), '')
      if (detail.next) lines.push('## 下一步', '- ' + detail.next, '')
      try {
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, lines.join('\n'), 'utf8')
      } catch (error) {
        return json(res, 500, { ok: false, error: 'write failed: ' + text(error && error.message) })
      }
      const candidates = run.candidates.map((item) => item.id === candidateId
        ? { ...item, status: 'written', target: { kind: 'project-file', path: targetPath }, writtenAt: nowIso() }
        : item)
      runtime.store.patchRun(runId, { candidates })
      broadcast('run/candidate-written', { runId, candidateId, path: targetPath })
      return json(res, 200, { ok: true, path: targetPath })
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
