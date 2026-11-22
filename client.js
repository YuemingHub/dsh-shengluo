/* 生络 DSH plugin client — original code; no embedded runtime or graph canvas vendor. */
/**
 * 生络 — DSH 原生插件（Client 半个，V2）。
 *
 * 一个入口（侧栏「生络」）→ 一块主面板：
 *   左侧导航：今天 / 目标 / 项目 / 成果 / 知识 / 连接
 *   中间：一个生络智能核心 + 围绕它的真实语义节点（默认 5–9 个）
 *   右侧：三页签 —— 当前工作 / 理解与依据 / 轨迹
 *   底部：一句自然语言输入
 *
 * 执行不在这里：会话、工具、审批、文件预览全是 DSH 原生的。
 * 面板只做三件事：把真实状态说清楚、把真实事件画出来、把本人送到原生界面去决定。
 * 光流只跟随真实事件（tool/call、tool/result、审批、验收）；没有活动时保持安静。
 */
window.__ModuleLoader__.load({
  id: '@shengluo/dsh-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'shengluo'
    const PANEL_ID = 'shengluo'
    const API = '/sl/api'
    const PULSE_TTL = 1400

    const KIND = {
      reality: { label: '我的现实', tone: 'amber', slot: -150 },
      goal: { label: '目标', tone: 'blue', slot: -90 },
      knowledge: { label: '知识', tone: 'slate', slot: -30 },
      project: { label: '项目', tone: 'teal', slot: 150 },
      task: { label: '执行', tone: 'violet', slot: 90 },
      step: { label: '步骤', tone: 'violet', slot: 90 },
      artifact: { label: '成果', tone: 'rose', slot: 30 },
      verification: { label: '验证', tone: 'teal', slot: 30 },
      decision: { label: '待你决定', tone: 'amber', slot: 0 },
      candidate: { label: '可沉淀', tone: 'slate', slot: 60 },
      registry: { label: '项目登记', tone: 'slate', slot: 205 },
      understanding: { label: '理解', tone: 'blue', slot: -60 },
      correction: { label: '纠正', tone: 'amber', slot: -110 },
    }

    const NAV = [
      { id: 'today', label: '今天' },
      { id: 'goals', label: '目标' },
      { id: 'projects', label: '项目' },
      { id: 'artifacts', label: '成果' },
      { id: 'knowledge', label: '知识' },
      { id: 'connect', label: '连接' },
    ]

    const PHASE_TEXT = {
      preparing: ['准备中', '正在为这件事做准备。'],
      understanding: ['理解问题', '正在读你说的这件事，先判断它是什么。'],
      gathering: ['寻找依据', '正在按需要查个人现实、知识和项目文件。'],
      judging: ['形成判断', '正在把依据收拢成一个判断，并标出还不确定的地方。'],
      executing: ['执行中', '正在用 DSH 原生工具做事；需要你定的地方会停下来。'],
      'waiting-for-you': ['等你决定', '有一步需要你点头，回到原生会话里处理。'],
      verifying: ['验收结果', '正在按真实文件检查这次到底做成了什么。'],
      completed: ['完成', '这件事已经做完，结果和依据都在右边。'],
      failed: ['如实停下', '这次没有做成；停在哪儿、为什么，都写在右边。'],
      'stopped-by-owner': ['按你的决定停下', '你拒绝了这一步，我按你的决定停下了。'],
    }

    const STATUS_TEXT = {
      running: '正在做',
      completed: '已完成（验收通过）',
      answered: '已答复',
      failed: '如实停下',
      'stopped-by-owner': '按你的决定停下',
    }

    // ————————————————————————— 很小的 store（面板切换会卸载，状态要活在外面） —————————————————————————

    function createTinyStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
          for (const listener of listeners) { try { listener() } catch { /* 单个订阅者出错不影响别人 */ } }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const store = createTinyStore({
      loaded: false,
      loading: false,
      error: null,
      data: null,
      view: 'today',
      rightTab: 'work',
      selectedId: null,
      goal: '',
      busy: false,
      sessionId: null,
      runId: null,
      pulses: [],
      toast: null,
      device: null,
      conversation: null,
      knowledge: { query: '', result: null, busy: false },
      candidateTarget: '',
      correctionText: '',
      today: null,
      todayBusy: false,
      reducedMotion: false,
    })

    let ctxRef = null
    let attached = false
    let eventSource = null
    let pollTimer = null
    let deviceTimer = null

    function useStore() {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => store.subscribe(force), [])
      return store.get()
    }

    async function api(path, options) {
      const response = await fetch(API + path, {
        method: options?.method ?? 'GET',
        headers: options?.body ? { 'content-type': 'application/json' } : undefined,
        body: options?.body ? JSON.stringify(options.body) : undefined,
        credentials: 'same-origin',
      })
      let payload = null
      try { payload = await response.json() } catch { payload = null }
      if (!response.ok) {
        const message = payload?.error ?? ('本机接口返回 ' + response.status)
        const error = new Error(message)
        error.status = response.status
        error.payload = payload
        throw error
      }
      return payload
    }

    function toast(message) {
      store.set({ toast: message })
      setTimeout(() => { if (store.get().toast === message) store.set({ toast: null }) }, 4200)
    }

    function pushPulse(kind, step) {
      const id = 'pulse-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      store.set((state) => ({ pulses: [...state.pulses, { id, kind, step: step ?? null, at: Date.now() }].slice(-10) }))
      setTimeout(() => store.set((state) => ({ pulses: state.pulses.filter((pulse) => pulse.id !== id) })), PULSE_TTL)
    }

    async function loadState({ silent = false } = {}) {
      if (!silent) store.set({ loading: true })
      try {
        const data = await api('/state')
        const active = data.activeRun
        const patch = { data, loading: false, error: null, loaded: true }
        if (active) {
          patch.sessionId = active.sessionId
          patch.runId = active.runId
        }
        if (data.today) patch.today = data.today
        store.set(patch)
        return data
      } catch (error) {
        store.set({ loading: false, error: error.message })
        return null
      }
    }

    async function scanToday() {
      store.set({ todayBusy: true })
      try {
        const result = await api('/today/scan', { method: 'POST' })
        store.set({ todayBusy: false, today: result.today ?? null })
      } catch (error) {
        store.set({
          todayBusy: false,
          today: { at: null, state: 'error', items: [], note: '今天没能读完来源。', errors: [error.message], realityState: 'unknown' },
        })
      }
    }

    function attach() {
      if (attached || !ctxRef) return
      attached = true
      try { store.set({ reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches }) } catch { /* 不支持就按动效处理 */ }
      loadState()
      scanToday()
      try {
        eventSource = new EventSource(API + '/stream')
        eventSource.onmessage = (event) => {
          let payload = null
          try { payload = JSON.parse(event.data) } catch { return }
          if (!payload || !payload.type) return
          if (payload.type === 'run/step-start') pushPulse('moving', payload.step)
          if (payload.type === 'run/step-end') pushPulse(payload.step?.status === 'failed' ? 'failed' : 'ok', payload.step)
          if (payload.type === 'run/verified') pushPulse('verified', null)
          const refresh = [
            'run/step-start', 'run/step-end', 'run/understanding', 'run/understanding-invalid',
            'run/decision', 'run/approval-decided', 'run/end', 'run/verified',
            'run/candidate-written', 'network/changed', 'reality/linked', 'reality/revoked', 'understanding/corrected',
          ]
          if (payload.type === 'today/changed' && payload.today) store.set({ today: payload.today })
          if (refresh.includes(payload.type)) loadState({ silent: true })
          if (payload.type === 'run/end') {
            if (payload.status === 'failed') toast('这次如实停下了' + (payload.note ? '：' + payload.note : '，没有假装完成。'))
            if (payload.status === 'completed') toast('这件事完成了，验收结果在右边。')
            if (payload.status === 'stopped-by-owner') toast('已按你的决定停下。')
          }
        }
        eventSource.onerror = () => { /* EventSource 自己重连 */ }
      } catch {
        pollTimer = setInterval(() => loadState({ silent: true }), 4000)
      }
      return () => {
        if (eventSource) { try { eventSource.close() } catch { /* 已经关了 */ } eventSource = null }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        attached = false
      }
    }

    // ————————————————————————— 原生会话 —————————————————————————

    function currentCwd(data) {
      // 优先用生络显式配置的运行工作区；没有配置时才提交活动工作区，
      // 由 Host 按允许根目录校验——越界会明确报错，不会静默落到别的工作区。
      const configured = data?.runWorkspace?.defaultCwd
      if (configured) return configured
      const project = (data?.network?.workspaces ?? []).find((workspace) => workspace.active) ?? null
      return project?.path ?? null
    }

    /** 启动时就检查会话接口：缺 create/retain 时明确报错，不静默降级、不假装已开始。 */
    function sessionApiState() {
      const api = ctxRef && ctxRef.sessions
      const available = Boolean(api) && typeof api === 'object'
      const canCreate = available && typeof api.create === 'function'
      const canRetain = available && typeof api.retain === 'function'
      return { available, canCreate, canRetain, ok: available && canCreate && canRetain }
    }

    async function beginWork() {
      const state = store.get()
      const goal = state.goal.trim()
      if (!goal || state.busy) return
      const data = state.data
      const sessionApi = sessionApiState()
      if (!sessionApi.ok) {
        const missing = !sessionApi.available ? 'sessions' : [!sessionApi.canCreate ? 'create' : null, !sessionApi.canRetain ? 'retain' : null].filter(Boolean).join(' / ')
        toast('当前 DSH 版本缺少会话接口（' + missing + '），这次没有开始；请升级 DSH 或把版本号发给开发者。')
        return
      }
      store.set({ busy: true })
      let sessionId = null
      try {
        sessionId = await ctxRef.sessions.create({ agentPreset: 'shengluo', cwd: currentCwd(data) ?? undefined })
        // 先登记 run，再投递 prompt：否则最早几个事件（tool/call 等）会因为 run 还没登记而被丢掉。
        const started = await api('/run/start', { method: 'POST', body: { sessionId, goal, cwd: currentCwd(data) } })
        store.set({ sessionId, runId: started.runId, rightTab: 'work' })
        const reference = ctxRef.sessions.retain(sessionId, { source: 'mainView' })
        const binding = await reference.ready
        // 面板只发原话时，模型会把「这个」当成刚安装的插件（2026-11-22 S1 尝试 1 的失败证据）。
        // 最小必要上下文：说明来自生络面板、个人现实已授权只读；不注入历史、不扩大权限。
        const panelPrompt = `（这条消息来自生络面板；用户正看着生络。你可以只读使用他已授权的个人现实，仅限他本人可访问部分。）

${goal}`
        const result = await binding.session.prompt([{ type: 'text', text: panelPrompt }], 'queue')
        if (result && result.ok === false) throw new Error(result.error?.message ?? '原生会话没接受这条请求')
        store.set({ busy: false, goal: '' })
        await loadState({ silent: true })
      } catch (error) {
        store.set({ busy: false })
        // 已经登记过 run 的，如实标成失败——不留一个永远「进行中」的影子。
        if (sessionId) {
          try { await api('/run/status', { method: 'POST', body: { status: 'failed', endReason: 'prompt-not-accepted' } }) } catch { /* 尽力而为 */ }
        }
        toast('没能开始：' + error.message)
      }
    }

    async function stopWork() {
      const { sessionId } = store.get()
      if (!sessionId) return
      try {
        const reference = ctxRef.sessions.retain(sessionId, { source: 'mainView' })
        const binding = await reference.ready
        await binding.session.cancel()
        await api('/run/status', { method: 'POST', body: { status: 'stopped-by-owner', phase: 'stopped-by-owner', endReason: 'cancelled-by-owner' } })
        toast('已停下。')
        await loadState({ silent: true })
      } catch (error) {
        toast('停下失败：' + error.message)
      }
    }

    function openNativeSession(sessionId) {
      if (!sessionId) return
      try {
        // 去原生会话就是真的去：审批卡片、工具结果、文件预览都在那里。
        // 不立刻把面板抢回来——那会让用户看不到审批，等于把「回原生界面决定」做废。
        ctxRef.uiWorkspace.openSession(sessionId)
      } catch (error) {
        toast('打开原生会话失败：' + error.message)
      }
    }

    function openNativePlugins() {
      try { ctxRef.layout.selectPanel('plugins') } catch (error) { toast('打开原生插件管理失败：' + error.message) }
    }

    // ————————————————————————— Family Space 授权（用户动作） —————————————————————————

    async function connectReality() {
      try {
        const started = await api('/reality/connect', { method: 'POST' })
        store.set({ device: { userCode: started.userCode, verificationUri: started.verificationUri ?? started.verificationUriComplete ?? null, startedAt: Date.now() } })
        startDevicePolling()
      } catch (error) {
        toast('发起授权失败：' + error.message)
      }
    }

    function startDevicePolling() {
      stopDevicePolling()
      deviceTimer = setInterval(async () => {
        try {
          const result = await api('/reality/poll', { method: 'POST' })
          if (result.state === 'linked') {
            stopDevicePolling()
            store.set({ device: null })
            toast('家庭空间已连接。')
            await loadState({ silent: true })
          } else if (result.state === 'expired' || result.state === 'denied') {
            stopDevicePolling()
            store.set({ device: null })
            toast(result.state === 'expired' ? '授权码过期了，请重新连接。' : '授权被拒绝了。')
          }
        } catch { /* 轮询失败继续等下一次 */ }
      }, 5000)
    }

    function stopDevicePolling() {
      if (deviceTimer) { clearInterval(deviceTimer); deviceTimer = null }
    }

    async function revokeReality() {
      try {
        await api('/reality/revoke', { method: 'POST' })
        toast('已撤销。旧令牌已失效。')
        await loadState({ silent: true })
      } catch (error) {
        toast('撤销失败：' + error.message)
      }
    }

    async function openConversation(conversationId) {
      try {
        const result = await api('/reality/conversation', { method: 'POST', body: { conversationId } })
        store.set({ conversation: result.ok ? result.conversation : null })
        if (!result.ok) toast(result.detail ?? '这段对话读不到。')
      } catch (error) {
        toast('读对话失败：' + error.message)
      }
    }

    async function confirmCandidate(runId, candidateId) {
      const target = store.get().candidateTarget.trim()
      if (!target) { toast('先写一个要放到项目里的相对路径。'); return }
      try {
        await api('/candidates/confirm', { method: 'POST', body: { runId, candidateId, targetPath: target } })
        store.set({ candidateTarget: '' })
        toast('已按你的确认写入：' + target)
        await loadState({ silent: true })
      } catch (error) {
        toast('没写入：' + error.message)
      }
    }

    async function searchKnowledgeNow() {
      const query = store.get().knowledge.query.trim()
      if (!query) return
      store.set((state) => ({ knowledge: { ...state.knowledge, busy: true } }))
      try {
        const result = await api('/knowledge/search', { method: 'POST', body: { query } })
        store.set((state) => ({ knowledge: { ...state.knowledge, result, busy: false } }))
      } catch (error) {
        store.set((state) => ({ knowledge: { ...state.knowledge, result: { ok: false, detail: error.message }, busy: false } }))
      }
    }

    // ————————————————————————— 小组件 —————————————————————————

    function PanelIcon({ size }) {
      const s = size ?? 16
      return h('svg', {
        width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false',
      }, [
        h('circle', { key: 'r', cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeDasharray: '2 2.6', opacity: 0.85 }),
        h('circle', { key: 'c', cx: 8, cy: 8, r: 3.4, fill: 'currentColor', opacity: 0.9 }),
      ])
    }

    function phaseOf(data) {
      const run = data?.activeRun
      if (!run) {
        return { id: 'idle', title: '空闲', line: '我已准备好。说一句你现在想解决的事，或继续以前的事情。' }
      }
      const key = run.phase === 'completed' && run.status === 'answered' ? 'completed' : (run.phase ?? 'preparing')
      const mapped = PHASE_TEXT[key] ?? ['进行中', '正在按真实事件推进。']
      return { id: key, title: mapped[0], line: mapped[1] }
    }

    function toneOf(node) {
      return (KIND[node?.kind] ?? { tone: 'slate' }).tone
    }

    // ————————————————————————— 网络 —————————————————————————

    function layoutNodes(nodes) {
      const groups = new Map()
      for (const node of nodes) {
        const slot = (KIND[node.kind] ?? { slot: 0 }).slot
        if (!groups.has(slot)) groups.set(slot, [])
        groups.get(slot).push(node)
      }
      const placed = []
      for (const [slot, list] of groups) {
        const inSlot = Math.min(list.length, 4)
        for (let i = 0; i < inSlot; i += 1) {
          const spread = 34
          const angle = slot + (inSlot === 1 ? 0 : (i - (inSlot - 1) / 2) * (spread / Math.max(1, inSlot - 1)))
          const rad = (angle * Math.PI) / 180
          const ring = list[i].kind === 'step' || list[i].kind === 'candidate' || list[i].kind === 'registry' ? 0.44 : 0.32
          placed.push({
            node: list[i],
            x: 50 + Math.cos(rad) * ring * 100,
            y: 50 + Math.sin(rad) * ring * 100,
          })
        }
      }
      return placed
    }

    function NetworkMap({ data, selectedId, onSelect, pulses, reducedMotion }) {
      const nodes = (data?.network?.nodes ?? []).slice(0, 9)
      const edges = data?.network?.edges ?? []
      const placed = layoutNodes(nodes)
      const byId = new Map(placed.map((item) => [item.node.id, item]))
      const pulseStepIds = new Set((pulses ?? []).map((pulse) => pulse.step?.callId ? 'step:' + pulse.step.callId : null).filter(Boolean))
      const activePulse = (pulses ?? []).length > 0

      const lines = []
      lines.push(h('circle', { key: 'orbit', className: 'sl-orbit', cx: 50, cy: 50, r: 32, fill: 'none' }))
      for (const item of placed) {
        lines.push(h('line', {
          key: 'core-' + item.node.id,
          className: 'sl-core-line',
          x1: 50, y1: 50, x2: item.x, y2: item.y,
        }))
      }
      for (const edge of edges) {
        const from = byId.get(edge.from)
        const to = byId.get(edge.to)
        if (!from || !to) continue
        lines.push(h('line', {
          key: 'e-' + edge.id,
          className: 'sl-edge' + (edge.relation === 'reality_unknown' ? ' sl-edge-dashed' : ''),
          x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        }))
      }

      return h('div', { className: 'sl-map' }, [
        h('svg', { key: 'svg', className: 'sl-map-svg', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, lines),
        h('div', {
          key: 'core',
          className: 'sl-core' + (activePulse && !reducedMotion ? ' sl-core-live' : '') +
            (pulses?.some((pulse) => pulse.kind === 'failed') ? ' sl-core-fail' : ''),
        }, [
          h(PanelIcon, { key: 'i', size: 22 }),
          h('span', { key: 't', className: 'sl-core-title' }, '生络'),
        ]),
        ...placed.map((item) => {
          const selected = selectedId === item.node.id
          const live = pulseStepIds.has(item.node.id)
          return h('button', {
            key: item.node.id,
            type: 'button',
            className: 'sl-node tone-' + toneOf(item.node)
              + (selected ? ' sl-node-selected' : '')
              + (live ? ' sl-node-live' : '')
              + (item.node.status === 'failed' ? ' sl-node-failed' : ''),
            style: { left: item.x + '%', top: item.y + '%' },
            title: item.node.subtitle ?? item.node.title,
            onClick: () => onSelect(item.node),
            onFocus: () => onSelect(item.node),
          }, [
            h('span', { key: 'd', className: 'sl-node-dot', 'aria-hidden': 'true' }),
            h('span', { key: 'l', className: 'sl-node-label' }, item.node.title),
            h('span', { key: 'k', className: 'sl-node-kind' }, (KIND[item.node.kind] ?? { label: item.node.kind }).label),
          ])
        }),
      ])
    }

    // ————————————————————————— 右面板三页签 —————————————————————————

    function rightTabs() {
      const ui = useStore()
      const tabs = [
        { id: 'work', label: '当前工作' },
        { id: 'understand', label: '理解与依据' },
        { id: 'trace', label: '轨迹' },
        { id: 'connect', label: '连接' },
      ]
      return h('div', { className: 'sl-tabs', role: 'tablist' }, tabs.map((tab) => h('button', {
        key: tab.id,
        type: 'button',
        role: 'tab',
        'aria-selected': ui.rightTab === tab.id,
        className: 'sl-tab' + (ui.rightTab === tab.id ? ' sl-tab-active' : ''),
        onClick: () => store.set({ rightTab: tab.id }),
      }, tab.label)))
    }

    function WorkTab({ data }) {
      const ui = useStore()
      const run = data?.activeRun
      const understanding = data?.network?.understanding
      const decisions = (data?.network?.decisions ?? []).filter((decision) => !decision.resolved)
      const candidates = (run?.candidates ?? []).filter((candidate) => candidate.status === 'draft' || candidate.status === 'blocked')
      const verifications = run?.verifications ?? []
      const phase = phaseOf(data)

      const blocks = []
      blocks.push(h('section', { key: 'focus', className: 'sl-block' }, [
        h('h3', { key: 'h', className: 'sl-h3' }, '这件事'),
        h('p', { key: 'g', className: 'sl-focus' }, run?.goal ?? (phase.id === 'idle' ? '还没有开始一件事' : '—')),
        h('p', { key: 'p', className: 'sl-muted' }, phase.title + ' · ' + phase.line),
      ]))

      blocks.push(h('section', { key: 'u', className: 'sl-block' }, [
        h('h3', { key: 'h', className: 'sl-h3' }, '我目前的理解'),
        understanding?.headline
          ? h('p', { key: 'm', className: 'sl-strong' }, understanding.headline)
          : h('p', { key: 'm', className: 'sl-muted' }, data?.understandingMeta?.invalid
              ? '这次的结构化理解没有解析成功：' + data.understandingMeta.invalid
              : '这件事还没有形成结构化理解。没有就不写，我不拿模板顶上。'),
        understanding?.next ? h('p', { key: 'n', className: 'sl-muted' }, '下一步：' + understanding.next) : null,
        understanding?.at ? h('p', { key: 'at', className: 'sl-muted' }, '来自 ' + String(understanding.at).slice(0, 16).replace('T', ' ')) : null,
      ]))

      // 真实最终答复（来自原生会话最后一条 assistant 消息；只存在内存里，不落盘）
      if (data?.network?.finalReply) {
        blocks.push(h('section', { key: 'reply', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '生络的答复'),
          h('p', { key: 'p', className: 'sl-reply' }, data.network.finalReply),
          data.network.finalReplyAt
            ? h('p', { key: 'at', className: 'sl-muted' }, '来自这次原生会话 · ' + String(data.network.finalReplyAt).slice(0, 16).replace('T', ' '))
            : null,
        ]))
      }

      if (verifications.length > 0) {
        blocks.push(h('section', { key: 'v', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '验收结果'),
          h('ul', { key: 'ul', className: 'sl-bullets' }, verifications.map((item) => h('li', { key: item.path }, [
            h('span', { key: 'p' }, item.path + ' · ' + (item.ok ? '通过' : '没通过：' + item.reason)),
          ]))),
        ]))
      }

      if (run?.endNote) {
        blocks.push(h('section', { key: 'note', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '结束说明'),
          h('p', { key: 'p', className: 'sl-muted' }, run.endNote),
        ]))
      }

      blocks.push(h('section', { key: 'd', className: 'sl-block' }, [
        h('h3', { key: 'h', className: 'sl-h3' }, '待你决定'),
        decisions.length === 0
          ? h('p', { key: 'n', className: 'sl-muted' }, '现在没有要你拍板的事。')
          : h('ul', { key: 'ul', className: 'sl-decisions' }, decisions.slice(0, 4).map((decision) => h('li', { key: decision.id }, [
              h('strong', { key: 't' }, decision.title),
              decision.detail ? h('span', { key: 'd', className: 'sl-muted' }, decision.detail) : null,
              decision.sessionId ? h('button', { key: 'o', type: 'button', className: 'sl-quiet sl-small', onClick: () => openNativeSession(decision.sessionId) }, '去原生会话决定') : null,
            ]))),
      ]))

      if (candidates.length > 0) {
        blocks.push(h('section', { key: 'c', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '可以沉淀的'),
          ...candidates.slice(0, 2).map((candidate) => h('div', { key: candidate.id, className: 'sl-card' }, [
            h('span', { key: 't', className: 'sl-card-title' }, candidate.content || '候选正文只在原生会话里（没有复制到产品状态）。'),
            h('p', { key: 'n', className: 'sl-muted' }, '用途：' + (candidate.use === 'knowledge-to-mki' ? '回 MKI 知识' : candidate.use === 'project-experience' ? '回项目经验' : '本人确认的洞见') + ' · 目标：' + (candidate.target?.label ?? '你确认后指定')),
            h('p', { key: 'n2', className: 'sl-muted' }, candidate.content
              ? (candidate.target?.kind === 'mki' ? 'MKI 还没有连接，这条只能保持草稿，不会写入。' : '现在只是草稿，还没有写进任何地方。确认后才会写入你指定的项目文件。')
              : '重启后正文没有复制过来；回到原生会话查看，或重新生成候选。'),
            candidate.status === 'draft' && candidate.content && !candidate.target ? h('input', {
              key: 'i', className: 'sl-input', placeholder: '项目内相对路径，例如 notes/这次的经验.md',
              value: ui.candidateTarget, onChange: (event) => store.set({ candidateTarget: event.target.value }),
            }) : null,
            candidate.status === 'draft' && candidate.content && !candidate.target ? h('button', { key: 'b', type: 'button', className: 'sl-primary', onClick: () => confirmCandidate(run.runId, candidate.id) }, '确认写入这个文件') : null,
          ])),
        ]))
      }

      if (!run) {
        blocks.push(h('section', { key: 'empty', className: 'sl-block' }, [
          h('p', { key: 'p', className: 'sl-muted' }, '说一句话，我就会在原生会话里开始做；需要动手前会先让你确认。'),
        ]))
      }

      return h('div', { className: 'sl-right-inner' }, blocks)
    }

    async function saveCorrection(runId) {
      const value = store.get().correctionText.trim()
      if (!value) return
      try {
        await api('/understanding/correct', { method: 'POST', body: { runId, text: value } })
        store.set({ correctionText: '' })
        toast('已记住你的纠正。')
        await loadState({ silent: true })
      } catch (error) {
        toast('纠正没保存：' + error.message)
      }
    }

    function UnderstandTab({ data }) {
      const understanding = data?.network?.understanding
      const source = data?.understandingMeta?.source
      const corrections = data?.corrections ?? []
      const runId = data?.activeRun?.runId ?? null
      const groups = [
        { key: 'known', label: '我知道的（有依据）', items: understanding?.known ?? [] },
        { key: 'inference', label: '我的判断（推断，不是事实）', items: understanding?.inference ?? [] },
        { key: 'unknown', label: '我还不知道的', items: understanding?.unknown ?? [] },
      ]
      return h('div', { className: 'sl-right-inner' }, [
        h('section', { key: 'head', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '理解'),
          h('p', { key: 'p', className: 'sl-strong' }, understanding?.headline ?? '还没有形成结构化理解。'),
          source?.at ? h('p', { key: 's', className: 'sl-muted' }, '来自模型在这次会话里的输出 · ' + String(source.at).slice(0, 16).replace('T', ' ')) : null,
        ]),
        ...groups.map((group) => h('section', { key: group.key, className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, group.label),
          group.items.length === 0
            ? h('p', { key: 'e', className: 'sl-muted' }, group.key === 'unknown' ? '没有明确写出的未知——这本身也可能是个缺口。' : '这一栏是空的。')
            : h('ul', { key: 'ul', className: 'sl-bullets' }, group.items.map((item, index) => h('li', { key: index }, item))),
        ])),
        data?.understandingMeta?.realityNote
          ? h('section', { key: 'note', className: 'sl-block' }, [
              h('h3', { key: 'h', className: 'sl-h3' }, '现实来源状态'),
              h('p', { key: 'p', className: 'sl-muted' }, data.understandingMeta.realityNote.headline),
            ])
          : null,
        h('section', { key: 'corrections', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '我记住的纠正'),
          corrections.length === 0
            ? h('p', { key: 'e', className: 'sl-muted' }, '还没有纠正过。你说「你理解错了」时，我会把纠正记在这里，后续任务优先使用。')
            : h('ul', { key: 'ul', className: 'sl-bullets' }, corrections.slice(-4).map((item) => h('li', { key: item.id }, [
                String(item.at ?? '').slice(0, 16).replace('T', ' ') + ' · ' + item.text,
              ]))),
          runId
            ? h('div', { key: 'form', className: 'sl-row' }, [
                h('input', {
                  key: 'i', className: 'sl-input', placeholder: '哪里理解错了？用一句话纠正',
                  value: ui.correctionText,
                  onChange: (event) => store.set({ correctionText: event.target.value }),
                }),
                h('button', { key: 'b', type: 'button', className: 'sl-primary', onClick: () => saveCorrection(runId) }, '记住纠正'),
              ])
            : null,
          h('p', { key: 'n', className: 'sl-muted sl-small' }, '只改我的理解，不改 Family Space 的原始事实。'),
        ]),
      ])
    }

    function TraceTab({ data }) {
      const run = data?.activeRun
      const steps = run?.steps ?? []
      return h('div', { className: 'sl-right-inner' }, [
        h('section', { key: 'head', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '轨迹'),
          h('p', { key: 'p', className: 'sl-muted' }, steps.length === 0
            ? '这件事还没有真实的工具调用。'
            : '共 ' + steps.length + ' 步；成功 ' + steps.filter((step) => step.status === 'ok').length + '，失败 ' + steps.filter((step) => step.status === 'failed').length + '。'),
        ]),
        run?.workspaceChanges
          ? h('section', { key: 'chg', className: 'sl-block' }, [
              h('h3', { key: 'h', className: 'sl-h3' }, '项目改动'),
              h('p', { key: 'g', className: 'sl-muted' }, (run.workspaceChanges.git?.anyChange ? 'git 检测到改动' : 'git 没有检测到改动') + ' · 测试 ' + (run.workspaceChanges.tests?.length ?? 0) + ' 条' + ((run.workspaceChanges.tests ?? []).some((test) => !test.ok) ? '（有失败）' : '')),
              (run.workspaceChanges.git?.changedFiles ?? []).length
                ? h('ul', { key: 'ul', className: 'sl-bullets' }, run.workspaceChanges.git.changedFiles.slice(0, 8).map((file, index) => h('li', { key: index }, file)))
                : null,
            ])
          : null,
        h('section', { key: 'list', className: 'sl-block' }, steps.length === 0 ? null : h('ul', { className: 'sl-steps' }, steps.slice().reverse().map((step) => h('li', { key: step.callId, className: 'sl-step sl-step-' + step.status }, [
          h('span', { key: 't', className: 'sl-step-time' }, step.startedAt ? String(step.startedAt).slice(11, 19) : '—'),
          h('span', { key: 'v', className: 'sl-step-verb' }, step.verb),
          h('span', { key: 'g', className: 'sl-step-target' }, step.target),
          h('span', { key: 's', className: 'sl-step-status' }, step.status === 'running' ? '进行中' : step.status === 'ok' ? '成功' : '失败'),
          step.error ? h('span', { key: 'e', className: 'sl-error-note' }, step.error) : null,
          step.resultSummary ? h('span', { key: 'r', className: 'sl-muted' }, step.resultSummary) : null,
        ])))),
        (run?.artifacts ?? []).length > 0
          ? h('section', { key: 'a', className: 'sl-block' }, [
              h('h3', { key: 'h', className: 'sl-h3' }, '这次留下的文件'),
              h('ul', { key: 'ul', className: 'sl-bullets' }, run.artifacts.map((artifact) => h('li', { key: artifact.path }, [
                h('a', { key: 'l', className: 'sl-link-btn', href: API + '/artifact?path=' + encodeURIComponent(artifact.path), target: '_blank', rel: 'noreferrer noopener' }, artifact.path),
                artifact.sha256 ? h('span', { key: 's', className: 'sl-muted' }, ' · ' + artifact.sha256.slice(0, 12)) : null,
              ]))),
            ])
          : null,
      ])
    }

    function NodeDetail({ node, onClose = null }) {
      if (!node) return null
      return h('div', { className: 'sl-node-detail' }, [
        h('div', { key: 'h', className: 'sl-row' }, [
          h('strong', { key: 't' }, node.title),
          h('button', { key: 'x', type: 'button', className: 'sl-quiet sl-small', onClick: onClose ?? (() => store.set({ selectedId: null })) }, '收起'),
        ]),
        h('p', { key: 'k', className: 'sl-muted' }, (KIND[node.kind] ?? { label: node.kind }).label + (node.subtitle ? ' · ' + node.subtitle : '')),
        node.sourceRef ? h('p', { key: 'src', className: 'sl-muted' }, '来源：' + node.sourceRef.label + (node.time?.label ? ' · ' + node.time.label : '')) : null,
        node.factStatus ? h('p', { key: 'fs', className: 'sl-muted' }, '性质：' + ({ owner_said: '你亲口说的', fact: '有依据的事实', inference: '推断（未确认）', unknown: '未知' }[node.factStatus] ?? node.factStatus)) : null,
        node.lane ? h('p', { key: 'lane', className: 'sl-muted' }, '时间位置：' + ({ past: '来路', present: '当前路', future: '未来路' }[node.lane] ?? node.lane)) : null,
        node.kind === 'understanding' && node.sourceCount ? h('p', { key: 'sc', className: 'sl-muted' }, '来源：' + node.sourceCount + ' 个指针（正文没有复制到产品状态）') : null,
        node.openable?.kind === 'session' ? h('button', { key: 'o', type: 'button', className: 'sl-quiet sl-small', onClick: () => openNativeSession(node.openable.target) }, '打开原生会话') : null,
        node.openable?.kind === 'conversation' ? h('button', { key: 'c', type: 'button', className: 'sl-quiet sl-small', onClick: () => openConversation(node.openable.target) }, '看原始对话证据') : null,
        node.openable?.kind === 'artifact' ? h('a', { key: 'a', className: 'sl-link-btn', href: API + '/artifact?path=' + encodeURIComponent(node.openable.target), target: '_blank', rel: 'noreferrer noopener' }, '打开成果') : null,
        node.openable?.kind === 'connect' ? h('button', { key: 'k', type: 'button', className: 'sl-primary', onClick: () => { store.set({ rightTab: 'connect' }); void connectReality() } }, '连接 Family Space') : null,
      ])
    }

    // ————————————————————————— 底部输入 —————————————————————————

    function Composer({ data }) {
      const ui = useStore()
      const run = data?.activeRun
      const running = run?.status === 'running'
      return h('div', { className: 'sl-composer' }, [
        h('div', { key: 'row', className: 'sl-input-row' }, [
          h('input', {
            key: 'i',
            className: 'sl-input',
            placeholder: '告诉我你想解决什么，或者继续说一件正在做的事…',
            value: ui.goal,
            disabled: ui.busy,
            onChange: (event) => store.set({ goal: event.target.value }),
            onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) beginWork() },
          }),
          h('button', { key: 'b', type: 'button', className: 'sl-primary', disabled: ui.busy || !ui.goal.trim(), onClick: () => beginWork() }, ui.busy ? '正在交给原生会话…' : '开始'),
        ]),
        running ? h('div', { key: 'live', className: 'sl-row' }, [
          h('span', { key: 's', className: 'sl-muted' }, '这件事在原生会话里跑；进度以真实事件为准。'),
          h('button', { key: 'c', type: 'button', className: 'sl-quiet sl-small', onClick: () => stopWork() }, '停下'),
        ]) : null,
        h('p', { key: 'hint', className: 'sl-hint' }, '执行、审批、文件预览都在 DSH 原生界面；这里只显示真实发生的事。'),
      ])
    }

    // ————————————————————————— 视图 —————————————————————————

    const TODAY_KIND = { decision: '待你决定', run: '没做完的事', reality: '你的现实', project: '项目', knowledge: '知识' }

    function onTodayAction(action) {
      if (!action) return
      if (action.kind === 'open-session') { openNativeSession(action.ref); return }
      if (action.kind === 'open-conversation') { openConversation(action.ref); return }
      if (action.kind === 'view') { store.set({ view: action.ref }); return }
    }

    function TodayPanel({ today, busy, onAction }) {
      if (!today && !busy) return null
      const items = today?.items ?? []
      const body = (!today && busy)
        ? h('p', { key: 'loading', className: 'sl-muted' }, '正在看有没有值得关注的事…')
        : items.length === 0
          ? h('p', { key: 'empty', className: 'sl-muted' }, today?.note || '目前没有值得打扰你的事。')
          : h('div', { key: 'list', className: 'sl-today-list' }, items.map((item) => h('article', { key: item.id, className: 'sl-card sl-today-card' }, [
              h('div', { key: 'top', className: 'sl-row' }, [
                h('span', { key: 'k', className: 'sl-small sl-muted' }, TODAY_KIND[item.kind] ?? '值得关注'),
                item.at ? h('span', { key: 't', className: 'sl-small sl-muted' }, String(item.at).slice(0, 16).replace('T', ' ')) : null,
              ]),
              h('strong', { key: 'title', className: 'sl-card-title' }, item.title),
              h('p', { key: 'why', className: 'sl-muted' }, item.why),
              item.evidence?.length
                ? h('ul', { key: 'ev', className: 'sl-today-evidence' }, item.evidence.map((ev, index) => h('li', { key: index }, [
                    ev.label || ev.type,
                    ev.speaker ? ' · ' + ev.speaker : '',
                    ev.at ? ' · ' + String(ev.at).slice(0, 10) : '',
                    Array.isArray(ev.changed) && ev.changed.length ? ' · ' + ev.changed.length + ' 处改动' : '',
                  ].filter(Boolean).join(''))))
                : null,
              item.unknown ? h('p', { key: 'unknown', className: 'sl-muted' }, '还不确定：' + item.unknown) : null,
              item.next ? h('p', { key: 'next', className: 'sl-strong' }, '下一步：' + item.next) : null,
              item.action
                ? h('button', {
                    key: 'action', type: 'button', className: 'sl-quiet sl-small',
                    onClick: () => onAction(item.action),
                  }, item.action.kind === 'open-session' ? '回原生会话' : item.action.kind === 'open-conversation' ? '查看对话' : '去知识页')
                : null,
            ])))
      return h('section', { className: 'sl-today-panel' }, [
        h('div', { key: 'head', className: 'sl-row' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '值得关注'),
          busy ? h('span', { key: 'b', className: 'sl-small sl-muted' }, '正在看…') : null,
        ]),
        body,
        today?.errors?.length ? h('p', { key: 'err', className: 'sl-small sl-muted' }, '这次没读全：' + today.errors.join('；')) : null,
      ])
    }

    function TodayView({ data }) {
      const ui = useStore()
      const nodes = data?.network?.nodes ?? []
      const selected = nodes.find((node) => node.id === ui.selectedId) ?? null
      const phase = phaseOf(data)
      const realityState = data?.network?.realityState ?? data?.reality?.state ?? 'unauthorized'
      const knowledgeState = data?.knowledgeState?.state ?? 'not_configured'

      const registryState = data?.registryState?.state ?? 'not_configured'
      const today = ui.today ?? data?.today ?? null
      const laneCounts = { past: 0, present: 0, future: 0 }
      for (const node of nodes) laneCounts[node.lane ?? 'present'] = (laneCounts[node.lane ?? 'present'] ?? 0) + 1
      const chips = h('div', { key: 'chips', className: 'sl-chips' }, [
        h('button', {
          key: 'r', type: 'button',
          className: 'sl-chip sl-chip-btn' + (realityState === 'authorized' ? ' sl-chip-ok' : ''),
          title: '查看连接与授权',
          onClick: () => store.set({ rightTab: 'connect' }),
        }, 'Family Space ' + (realityState === 'authorized' ? '已连接' : realityState === 'expired' ? '授权已过期，现在是未知' : '尚未授权')),
        h('button', {
          key: 'k', type: 'button',
          className: 'sl-chip sl-chip-btn' + (knowledgeState === 'connected' ? ' sl-chip-ok' : ''),
          title: '查看知识服务状态',
          onClick: () => store.set({ rightTab: 'connect' }),
        }, '知识 ' + (knowledgeState === 'connected' ? '已连接' : knowledgeState === 'empty' ? '已连接（暂无内容）' : knowledgeState === 'error' ? '目录读不到' : '未配置')),
        h('button', {
          key: 'g', type: 'button',
          className: 'sl-chip sl-chip-btn' + (registryState === 'connected' ? ' sl-chip-ok' : ''),
          title: '查看项目登记',
          onClick: () => store.set({ rightTab: 'connect' }),
        }, '项目登记 ' + (registryState === 'connected' ? '已连接' : '未连接')),
      ])
      const header = h('div', { key: 'head', className: 'sl-today-head' }, [
        h('div', { key: 't', className: 'sl-row' }, [
          h('h2', { key: 'h', className: 'sl-h2' }, '我的现实与工作网络'),
          chips,
        ]),
      ])

      if (nodes.length === 0 && !data?.loading) {
        return h('div', { className: 'sl-stage' }, [
          header,
          h(TodayPanel, { key: 'today', today, busy: ui.todayBusy, onAction: onTodayAction }),
          h('div', { key: 'empty', className: 'sl-empty' }, [
            h('h3', { key: 'h', className: 'sl-h2' }, '生络，你的个人智能伙伴。'),
            h('p', { key: 'p', className: 'sl-muted' }, '了解你的现实，连接你的资源，陪你把重要的事情做好。'),
            h('div', { key: 's', className: 'sl-empty-states' }, [
              h('button', { key: 'r', type: 'button', className: 'sl-quiet', onClick: () => store.set({ rightTab: 'connect' }) }, realityState === 'authorized' ? '个人现实：已授权' : '个人现实：尚未授权 → 去连接'),
              h('span', { key: 'k', className: 'sl-quiet sl-static' }, knowledgeState === 'connected' ? '知识：已连接' : '知识：未配置'),
              h('span', { key: 'w', className: 'sl-quiet sl-static' }, '工作：还没有进行中的事'),
            ]),
          ]),
          h(Composer, { key: 'c', data }),
        ])
      }

      return h('div', { className: 'sl-stage' }, [
        header,
        h(TodayPanel, { key: 'today', today, busy: ui.todayBusy, onAction: onTodayAction }),
        h('div', { key: 'lanes', className: 'sl-lanes sl-small sl-muted' }, [
          '来路 ' + laneCounts.past,
          ' · 当前 ' + laneCounts.present,
          ' · 未来 ' + laneCounts.future,
        ]),
        h('div', { key: 'map-wrap', className: 'sl-center' }, [
          h(NetworkMap, { key: 'm', data, selectedId: ui.selectedId, onSelect: (node) => store.set({ selectedId: node.id, rightTab: 'work' }), pulses: ui.pulses, reducedMotion: ui.reducedMotion }),
          h('div', { key: 'phase', className: 'sl-phase sl-phase-' + phase.id }, phase.title + ' · ' + phase.line),
          h(NodeDetail, { key: 'detail', node: selected }),
          ui.conversation ? h('div', { key: 'conv', className: 'sl-node-detail' }, [
            h('div', { key: 'h', className: 'sl-row' }, [
              h('strong', { key: 't' }, ui.conversation.title || '对话原文'),
              h('button', { key: 'x', type: 'button', className: 'sl-quiet sl-small', onClick: () => store.set({ conversation: null }) }, '收起'),
            ]),
            h('p', { key: 'm', className: 'sl-muted' }, '逐字原文，未改写；只包含你有权访问的对话。'),
            h('ul', { key: 'l', className: 'sl-messages' }, (ui.conversation.messages ?? []).slice(0, 20).map((message) => h('li', { key: message.id }, [
              h('span', { key: 'w', className: 'sl-who' }, message.speakerRef === 'self' ? '本人' : message.speakerRef === 'ai' ? '家明' : '未知'),
              h('span', { key: 't', className: 'sl-msg-text' }, message.text),
            ]))),
          ]) : null,
        ]),
        h(Composer, { key: 'composer', data }),
      ])
    }

    function ConnectView({ data }) {
      const ui = useStore()
      const reality = data?.reality ?? {}
      const network = data?.network ?? {}
      const state = reality.state ?? 'unauthorized'
      const stateText = {
        authorized: '已授权',
        unauthorized: '尚未授权（个人现实现在是未知，不是空的）',
        pending: '等待你在网页里确认',
        expired: '授权已过期，需要重新连接',
        revoked: '已撤销',
        error: '连接失败',
      }[state] ?? state
      return h('div', { className: 'sl-right-inner' }, [
        h('h3', { key: 'h', className: 'sl-h3' }, '连接与授权'),
        h('div', { key: 'card', className: 'sl-card' }, [
          h('span', { key: 't', className: 'sl-card-title' }, 'Family Space'),
          h('p', { key: 's', className: 'sl-muted' }, '状态：' + stateText),
          reality.subject?.displayName ? h('p', { key: 'n', className: 'sl-muted' }, '账号：' + reality.subject.displayName) : null,
          (reality.scopes ?? []).length > 0
            ? h('ul', { key: 'sc', className: 'sl-scopes' }, reality.scopes.map((scope) => h('li', { key: scope }, scope === 'conversation.read.own' ? '读取你自己和家明的对话' : scope === 'personal_reality.read.own' ? '使用你自己的个人现实' : scope)))
            : null,
          reality.expiresAt ? h('p', { key: 'e', className: 'sl-muted' }, '到期：' + String(reality.expiresAt).slice(0, 16).replace('T', ' ')) : null,
          ui.device
            ? h('div', { key: 'd', className: 'sl-card' }, [
                h('span', { key: 'c', className: 'sl-code' }, ui.device.userCode),
                h('p', { key: 'm', className: 'sl-muted' }, '在打开的授权页里登录并确认；完成后这里会自动变成已连接。'),
                ui.device.verificationUri ? h('a', { key: 'l', className: 'sl-link-btn', href: ui.device.verificationUri, target: '_blank', rel: 'noreferrer noopener' }, '打开授权页') : null,
              ])
            : null,
          state === 'authorized'
            ? h('button', { key: 'r', type: 'button', className: 'sl-quiet', onClick: () => revokeReality() }, '撤销授权')
            : h('button', { key: 'c', type: 'button', className: 'sl-primary', onClick: () => connectReality() }, '连接 Family Space'),
        ]),
        h('div', { key: 'knowledge', className: 'sl-card' }, [
          h('span', { key: 't', className: 'sl-card-title' }, '知识（MKI）'),
          h('p', { key: 's', className: 'sl-muted' }, data?.knowledgeState?.state === 'connected'
            ? '已连接：' + (data.knowledgeState.source === 'mki-service' ? 'MKI 知识服务' : '本地知识目录（开发模式）') + '。'
            : data?.knowledgeState?.state === 'empty' ? '目录已配置，但还没有内容。'
              : data?.knowledgeState?.state === 'error' ? '读不到知识目录。'
                : '未连接（MKI_BASE_URL / MKI_API_KEY 未配置）。知识服务不可用时我不会编知识。'),
        ]),
        h('div', { key: 'registry', className: 'sl-card' }, [
          h('span', { key: 't', className: 'sl-card-title' }, '项目登记（Agent Space）'),
          h('p', { key: 's', className: 'sl-muted' }, data?.registryState?.state === 'connected'
            ? '已连接：共 ' + (data.registryState.total ?? 0) + ' 个项目。只做定位；每个项目现在到哪了，要回它自己的仓库核实。'
            : '未连接（找不到项目登记文件）。'),
        ]),
        h('div', { key: 'work', className: 'sl-card' }, [
          h('span', { key: 't', className: 'sl-card-title' }, '项目与文件'),
          h('p', { key: 's', className: 'sl-muted' }, (network.workspaces ?? []).length > 0
            ? '当前工作区：' + ((network.workspaces.find((workspace) => workspace.active) ?? network.workspaces[0]).path)
            : 'DSH 里还没有打开的项目工作区。'),
        ]),
      ])
    }

    function RightPanel({ data }) {
      const ui = useStore()
      return h('aside', { className: 'sl-right' }, [
        h('div', { key: 'tabs', className: 'sl-right-tabs' }, rightTabs()),
        ui.rightTab === 'work'
          ? h(WorkTab, { key: 'w', data })
          : ui.rightTab === 'understand'
            ? h(UnderstandTab, { key: 'u', data })
            : ui.rightTab === 'connect'
              ? h(ConnectView, { key: 'c', data })
              : h(TraceTab, { key: 't', data }),
      ])
    }

    // ————————————————————————— V2.2 A 方案界面 —————————————————————————

    const V22_KIND = { decision: '等你决定', run: '没做完的事', reality: '你的现实', project: '项目', knowledge: '知识' }
    const V22_LANES = [{ id: 'past', label: '来路' }, { id: 'present', label: '现在' }, { id: 'future', label: '未来' }]
    const v22RunStatus = (status) => status === 'running' ? '进行中' : status === 'waiting-for-you' ? '等你确认' : status === 'verifying' ? '验收中' : '进行中'
    const v22Date = () => new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    const v22At = (at) => at ? String(at).slice(0, 16).replace('T', ' ') : ''

    function V22Card({ item, onRelation, onAction, onDismiss }) {
      const actionLabel = item.action?.kind === 'open-session' ? '回原生会话' : item.action?.kind === 'open-conversation' ? '查看对话' : '去知识页'
      return h('article', { className: 'sl-v22-card' }, [
        h('div', { key: 'top', className: 'sl-v22-card-top' }, [
          h('span', { key: 'k', className: 'sl-v22-tag' }, V22_KIND[item.kind] ?? '值得关注'),
          item.at ? h('time', { key: 't', className: 'sl-v22-time' }, v22At(item.at)) : null,
        ]),
        h('h3', { key: 'title' }, item.title),
        h('p', { key: 'why', className: 'sl-v22-why' }, item.why),
        item.evidence?.length ? h('div', { key: 'ev', className: 'sl-v22-evidence' }, [
          h('strong', { key: 'l' }, '依据'),
          ...item.evidence.map((ev, index) => h('span', { key: index }, [
            ev.label || ev.type,
            ev.speaker ? ' · ' + ev.speaker : '',
            ev.at ? ' · ' + String(ev.at).slice(0, 10) : '',
            Array.isArray(ev.changed) && ev.changed.length ? ' · ' + ev.changed.length + ' 处改动' : '',
          ].filter(Boolean).join(''))),
        ]) : null,
        item.unknown ? h('p', { key: 'unknown', className: 'sl-v22-unknown' }, '还不确定：' + item.unknown) : null,
        item.next ? h('p', { key: 'next', className: 'sl-v22-next' }, '下一步：' + item.next) : null,
        h('div', { key: 'actions', className: 'sl-v22-actions' }, [
          h('button', { key: 'rel', type: 'button', className: 'sl-v22-primary', onClick: onRelation }, '了解这件事'),
          item.action ? h('button', { key: 'act', type: 'button', className: 'sl-v22-ghost', onClick: () => onAction(item.action) }, actionLabel) : null,
          h('button', { key: 'dismiss', type: 'button', className: 'sl-v22-ghost', onClick: () => onDismiss(item.id) }, '先放一放'),
        ]),
      ])
    }

    function V22Composer({ ui }) {
      return h('div', { className: 'sl-v22-composer' }, [
        h('label', { key: 'l', htmlFor: 'sl-v22-goal' }, '你也可以直接告诉我'),
        h('div', { key: 'row', className: 'sl-v22-input-row' }, [
          h('input', {
            key: 'i', id: 'sl-v22-goal', className: 'sl-v22-input',
            placeholder: '继续一件事，或者说说你现在遇到的问题…',
            value: ui.goal, disabled: ui.busy,
            onChange: (event) => store.set({ goal: event.target.value }),
            onKeyDown: (event) => { if (event.key === 'Enter' && !event.nativeEvent?.isComposing) beginWork() },
          }),
          h('button', { key: 'b', type: 'button', className: 'sl-v22-send', disabled: ui.busy || !ui.goal.trim(), onClick: () => beginWork() }, ui.busy ? '正在交给原生会话…' : '开始'),
        ]),
        h('p', { key: 'hint', className: 'sl-v22-hint' }, '说一句话，我会在 DSH 原生会话里做；需要动手前会先让你确认。'),
      ])
    }

    function V22Today({ data, today, busy, dismissed, onRelation, onAction, onDismiss, onConnect, onWork, onScan, onOpenSession, ui }) {
      const items = (today?.items ?? []).filter((item) => !dismissed[item.id])
      const active = data?.activeRun
      const activeLive = active && ['running', 'waiting-for-you', 'verifying'].includes(active.status)
      const realityState = data?.reality?.state ?? data?.network?.realityState ?? 'unauthorized'
      const knowledgeState = data?.knowledgeState?.state ?? 'not_configured'
      const registryState = data?.registryState?.state ?? 'not_configured'
      const errors = today?.errors ?? []
      let body
      if (busy && !today) {
        body = h('p', { key: 'loading', className: 'sl-v22-note' }, '正在核对真实来源…')
      } else if (errors.length > 0) {
        body = h('div', { key: 'err', className: 'sl-v22-error' }, [
          h('strong', { key: 't' }, '今天检查没读全'),
          h('p', { key: 'p' }, '这不是“没有值得关注的事”，是这次没读全。'),
          h('details', { key: 'd' }, [h('summary', { key: 's' }, '诊断详情'), h('p', { key: 'm' }, errors.join('；'))]),
          h('button', { key: 'r', type: 'button', className: 'sl-v22-ghost', onClick: onScan }, '重试'),
        ])
      } else if (items.length === 0) {
        body = h('p', { key: 'empty', className: 'sl-v22-note' }, today?.note || '目前没有值得打扰你的事。')
      } else {
        body = h('div', { key: 'list' }, items.map((item) => h(V22Card, { key: item.id, item, onRelation, onAction, onDismiss })))
      }
      return h('div', { className: 'sl-v22-screen' }, [
        h('div', { key: 'scroll', className: 'sl-v22-scroll' }, [
          h('div', { key: 'top', className: 'sl-v22-top' }, [
            h('span', { key: 'd', className: 'sl-v22-date' }, v22Date()),
            h('div', { key: 'links', className: 'sl-v22-links' }, [
              h('button', { key: 'rel', type: 'button', className: 'sl-v22-link', onClick: onRelation }, '关系网络'),
              h('button', { key: 'work', type: 'button', className: 'sl-v22-link', onClick: onWork }, '工作'),
              h('button', { key: 'conn', type: 'button', className: 'sl-v22-link', onClick: onConnect }, '连接'),
            ]),
          ]),
          h('h1', { key: 'h1', className: 'sl-v22-heading' }, '今天'),
          h('p', { key: 'lead', className: 'sl-v22-lead' }, '我正在了解你的现实、目标和正在发生的事情。'),
          realityState !== 'authorized' ? h('div', { key: 'unauth', className: 'sl-v22-error' }, [
            h('strong', { key: 't' }, '个人现实尚未连接'),
            h('p', { key: 'p' }, '这不代表没有相关经历，只是我现在看不到。'),
            h('button', { key: 'c', type: 'button', className: 'sl-v22-ghost', onClick: onConnect }, '去连接'),
          ]) : null,
          h('section', { key: 'today', className: 'sl-v22-section' }, [
            h('div', { key: 'head', className: 'sl-v22-section-head' }, [
              h('h2', { key: 'h' }, '今天值得关注'),
              h('span', { key: 'c', className: 'sl-v22-count' }, (items.length || 0) + ' 件'),
            ]),
            body,
          ]),
          activeLive ? h('div', { key: 'active', className: 'sl-v22-active' }, [
            h('span', { key: 'dot', className: 'sl-v22-tag' }, '●'),
            h('span', { key: 't' }, ['你正在做：', h('strong', { key: 'g' }, active.goal ?? '—'), ' · ' + v22RunStatus(active.status)]),
            active.sessionId ? h('button', { key: 'o', type: 'button', className: 'sl-v22-link', onClick: () => onOpenSession(active.sessionId) }, '打开') : null,
          ]) : null,
          h('div', { key: 'status', className: 'sl-v22-status' }, [
            h('span', { key: 'r' }, 'Family Space ' + (realityState === 'authorized' ? '已连接' : realityState === 'expired' ? '授权已过期' : '未授权')),
            h('span', { key: 'k' }, '知识 ' + (knowledgeState === 'connected' ? '已连接' : knowledgeState === 'empty' ? '已连接（暂无内容）' : knowledgeState === 'error' ? '目录读不到' : '未配置')),
            h('span', { key: 'g' }, '项目登记 ' + (registryState === 'connected' ? '已连接' : '未连接')),
            h('button', { key: 'c', type: 'button', className: 'sl-v22-link', onClick: onConnect }, '设置'),
          ]),
        ]),
        h(V22Composer, { key: 'composer', ui }),
      ])
    }

    function V22Correction({ runId, ui }) {
      if (!runId) return null
      return h('div', { className: 'sl-v22-correct' }, [
        h('p', { key: 'l' }, '哪里理解错了？'),
        h('textarea', {
          key: 't', value: ui.correctionText,
          placeholder: '用自己的话，不要粘贴家庭原文',
          onChange: (event) => store.set({ correctionText: event.target.value }),
        }),
        h('button', { key: 'b', type: 'button', className: 'sl-v22-ghost', onClick: () => saveCorrection(runId) }, '记住纠正'),
      ])
    }

    function V22Relation({ data, selectedNodeId, onSelect, onBack, onConnect }) {
      const ui = useStore()
      const seen = new Set()
      const all = (data?.network?.nodes ?? []).filter((node) => node && node.title).filter((node) => {
        const key = node.kind + '|' + node.title
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, 9)
      const selected = all.find((node) => node.id === selectedNodeId) ?? null
      return h('div', { className: 'sl-v22-relation' }, [
        h('div', { key: 'scroll', className: 'sl-v22-relation-scroll' }, [
          h('button', { key: 'back', type: 'button', className: 'sl-v22-back', onClick: onBack }, '← 回到今天'),
          h('h1', { key: 'h1', className: 'sl-v22-relation-title' }, '这件事和什么有关'),
          h('p', { key: 'sub', className: 'sl-v22-relation-sub' }, data?.activeRun?.goal ?? '从今天的一件事展开'),
          h('p', { key: 'note', className: 'sl-v22-relation-note' }, '只看与这件事有关的 ' + all.length + ' 个节点；不是全部。'),
          all.length === 0
            ? h('p', { key: 'empty', className: 'sl-v22-empty' }, '现在还没有可展开的关系。等有真实事件或来源后，这里才会出现节点。')
            : h('div', { key: 'body', className: 'sl-v22-relation-body' + (selected ? '' : ' no-inspector') }, [
                h('div', { key: 'lanes', className: 'sl-v22-lanes' }, V22_LANES.map((lane) => {
                  const laneNodes = all.filter((node) => (node.lane ?? 'present') === lane.id)
                  return h('section', { key: lane.id, className: 'sl-v22-lane' }, [
                    h('div', { key: 'label', className: 'sl-v22-lane-title' }, lane.label),
                    h('div', { key: 'list', className: 'sl-v22-lane-list' }, laneNodes.length === 0
                      ? h('p', { key: 'empty', className: 'sl-v22-empty' }, '暂无')
                      : laneNodes.map((node) => h('button', {
                          key: node.id, type: 'button',
                          className: 'sl-v22-node ' + (node.lane ?? 'present') + (selectedNodeId === node.id ? ' selected' : ''),
                          onClick: () => onSelect(node.id),
                        }, [
                          h('span', { key: 'k', className: 'sl-v22-node-tag' }, (KIND[node.kind] ?? { label: node.kind }).label),
                          h('span', { key: 't', className: 'sl-v22-node-title' }, node.title),
                          node.subtitle ? h('span', { key: 'm', className: 'sl-v22-node-meta' }, node.subtitle) : null,
                        ]))),
                  ])
                })),
                selected ? h('aside', { key: 'ins', className: 'sl-v22-inspector' }, [
                  h('div', { key: 'head', className: 'sl-v22-inspector-head' }, [
                    h('span', { key: 'k' }, '你选中的是'),
                    h('button', { key: 'x', type: 'button', className: 'sl-v22-link', onClick: () => onSelect(null) }, '收起'),
                  ]),
                  h(NodeDetail, { key: 'detail', node: selected, onClose: () => onSelect(null) }),
                  h(V22Correction, { key: 'corr', runId: data?.activeRun?.runId ?? null, ui }),
                ]) : null,
              ]),
          h('div', { key: 'connect', className: 'sl-v22-status' }, [
            h('button', { key: 'c', type: 'button', className: 'sl-v22-link', onClick: onConnect }, '连接与授权'),
          ]),
        ]),
      ])
    }

    function V22Drawer({ data, tab, onClose }) {
      if (!tab) return null
      return h('div', { className: 'sl-v22-drawer-layer' }, [
        h('div', { key: 'backdrop', className: 'sl-v22-backdrop', onClick: onClose }),
        h('aside', { key: 'drawer', className: 'sl-v22-drawer', onClick: (event) => event.stopPropagation() }, [
          h('div', { key: 'head', className: 'sl-v22-drawer-head' }, [
            h('strong', { key: 't' }, tab === 'connect' ? '连接与授权' : tab === 'understand' ? '理解与依据' : tab === 'trace' ? '轨迹' : '工作记录'),
            h('button', { key: 'x', type: 'button', className: 'sl-v22-link', onClick: onClose }, '收起'),
          ]),
          h(RightPanel, { key: 'panel', data }),
        ]),
      ])
    }

    const V22_CSS = `
.sl-v22{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.sl-v22-main{flex:1;min-height:0;display:flex;flex-direction:column}
.sl-v22-screen{height:100%;min-height:0;display:flex;flex-direction:column}
.sl-v22-scroll{flex:1;min-height:0;overflow-y:auto;width:100%;max-width:820px;margin:0 auto;padding:24px 32px 14px;scrollbar-width:thin}
.sl-v22-top{display:flex;align-items:center;justify-content:space-between;gap:16px}
.sl-v22-date{color:var(--dsw-alias-label-secondary);font-size:12px;letter-spacing:.03em;font-variant-numeric:tabular-nums}
.sl-v22-links{display:flex;gap:14px;align-items:center}
.sl-v22-link{background:none;border:0;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 0;cursor:pointer;min-height:24px}
.sl-v22-link:hover{color:var(--dsw-alias-label-primary)}
.sl-v22-heading{font-family:"Songti SC","Noto Serif SC",Georgia,serif;font-size:32px;line-height:1.2;font-weight:500;letter-spacing:.02em;margin:14px 0 0}
.sl-v22-lead{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1.7;margin:8px 0 0;max-width:560px}
.sl-v22-section{margin-top:24px}
.sl-v22-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding-bottom:9px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sl-v22-section-head h2{font-size:18px;line-height:1.4;font-weight:600;margin:0}
.sl-v22-count{color:var(--dsw-alias-label-secondary);font-size:12px}
.sl-v22-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:15px 20px;margin-top:12px;box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.sl-v22-card-top{display:flex;justify-content:space-between;gap:12px;align-items:center}
.sl-v22-tag{color:var(--dsw-alias-brand-primary);font-size:12px}
.sl-v22-time{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}
.sl-v22-card h3{font-size:18px;line-height:1.5;font-weight:600;margin:7px 0 6px;letter-spacing:.01em}
.sl-v22-why{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1.7;margin:0}
.sl-v22-evidence{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:11px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}
.sl-v22-evidence strong{color:var(--dsw-alias-label-primary);font-weight:500}
.sl-v22-unknown{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;margin:8px 0 0}
.sl-v22-next{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;margin:6px 0 0}
.sl-v22-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.sl-v22-primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-brand-primary);border-radius:9px;padding:7px 14px;font-size:13px;cursor:pointer}
.sl-v22-primary:hover{opacity:.9}
.sl-v22-ghost{background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:7px 12px;font-size:13px;cursor:pointer}
.sl-v22-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.sl-v22-active{display:flex;align-items:center;gap:8px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px}
.sl-v22-active strong{color:var(--dsw-alias-label-primary);font-weight:500}
.sl-v22-active .sl-v22-link{margin-left:auto}
.sl-v22-status{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:12px 0;color:var(--dsw-alias-label-secondary);font-size:11px}
.sl-v22-status .sl-v22-link{margin-left:auto}
.sl-v22-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7;margin:12px 0 0}
.sl-v22-error{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;margin-top:12px}
.sl-v22-error strong{display:block;font-size:14px}
.sl-v22-error p{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;margin:5px 0 0}
.sl-v22-error details{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:8px}
.sl-v22-error summary{cursor:pointer}
.sl-v22-composer{width:100%;max-width:820px;margin:0 auto;padding:12px 32px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.sl-v22-composer label{display:block;color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:8px}
.sl-v22-input-row{display:flex;gap:8px}
.sl-v22-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:9px 12px}
.sl-v22-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.sl-v22-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.sl-v22-send{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;color:var(--dsw-alias-label-primary);font-size:13px;padding:8px 14px;cursor:pointer}
.sl-v22-send:hover{border-color:var(--dsw-alias-brand-primary)}
.sl-v22-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6;margin:7px 0 0}
.sl-v22-relation{height:100%;min-height:0;display:flex;flex-direction:column}
.sl-v22-relation-scroll{flex:1;min-height:0;overflow:auto;width:100%;max-width:1120px;margin:0 auto;padding:22px 32px 32px}
.sl-v22-back{background:none;border:0;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 0;cursor:pointer;min-height:24px}
.sl-v22-back:hover{color:var(--dsw-alias-label-primary)}
.sl-v22-relation-title{font-family:"Songti SC","Noto Serif SC",Georgia,serif;font-size:28px;line-height:1.3;font-weight:500;margin:8px 0 0}
.sl-v22-relation-sub{color:var(--dsw-alias-label-secondary);font-size:13px;margin:7px 0 0}
.sl-v22-relation-note{color:var(--dsw-alias-label-secondary);font-size:11px;margin:5px 0 0}
.sl-v22-relation-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:22px;align-items:start;margin-top:22px}
.sl-v22-relation-body.no-inspector{grid-template-columns:1fr}
.sl-v22-lanes{display:grid;grid-template-columns:1fr 1.08fr 1fr;gap:16px;min-width:0}
.sl-v22-lane{min-width:0}
.sl-v22-lane-title{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px;letter-spacing:.06em;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sl-v22-lane-list{display:flex;flex-direction:column;gap:9px;padding-top:10px}
.sl-v22-node{width:100%;text-align:left;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:11px;padding:11px 12px;cursor:pointer}
.sl-v22-node:hover{border-color:var(--dsw-alias-border-l2)}
.sl-v22-node.selected{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.sl-v22-node-tag{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;margin-bottom:4px}
.sl-v22-node-title{display:block;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.sl-v22-node-meta{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;margin-top:3px}
.sl-v22-node.present .sl-v22-node-title{font-size:15px}
.sl-v22-inspector{position:sticky;top:20px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;padding:16px}
.sl-v22-inspector .sl-node-detail{padding:0;border:0;background:transparent}
.sl-v22-inspector-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sl-v22-inspector-head span{color:var(--dsw-alias-label-secondary);font-size:11px}
.sl-v22-correct{border-top:1px solid var(--dsw-alias-border-l1);margin-top:12px;padding-top:12px}
.sl-v22-correct p{color:var(--dsw-alias-label-secondary);font-size:11px;margin:0 0 6px}
.sl-v22-correct textarea{width:100%;min-height:60px;resize:vertical;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:8px;line-height:1.5}
.sl-v22-correct button{margin-top:7px}
.sl-v22-empty{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.7;padding:14px 0}
.sl-v22-boundary{padding:24px;color:var(--dsw-alias-label-primary)}
.sl-v22-boundary strong{display:block;font-size:15px;margin-bottom:8px}
.sl-v22-boundary p{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;margin:0 0 6px}
.sl-v22-drawer-layer{position:fixed;inset:0;z-index:60}
.sl-v22-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-overlay);opacity:.55}
.sl-v22-drawer{position:absolute;top:0;right:0;bottom:0;width:min(380px,92vw);background:var(--dsw-alias-bg-base);border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;overflow:auto}
.sl-v22-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sl-v22-drawer-head strong{font-size:14px}
.sl-v22-drawer .sl-right{width:100%;flex:1;border-left:0;background:transparent}
@media (max-width:900px){.sl-v22-scroll,.sl-v22-composer,.sl-v22-relation-scroll{padding-left:20px;padding-right:20px}.sl-v22-relation-body{grid-template-columns:1fr}.sl-v22-inspector{position:static}.sl-v22-lanes{grid-template-columns:1fr}.sl-v22-node{width:100%}}
`

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error }
      }
      componentDidCatch(error, info) {
        try { console.error('[shengluo] panel error', error, info) } catch { /* console may be unavailable */ }
      }
      render() {
        if (this.state.error) {
          return h('div', { className: 'sl-v22-boundary' }, [
            h('strong', { key: 't' }, '生络面板出错了'),
            h('p', { key: 'm' }, String(this.state.error?.message || this.state.error)),
            h('p', { key: 'h' }, '这不是你的操作问题；把这段文字发给开发者即可。'),
          ])
        }
        return this.props.children
      }
    }

    function ShengluoPanelRoot() {
      return h(PanelBoundary, null, h(ShengluoPanel))
    }

    function ShengluoPanel() {
      const ui = useStore()
      const [mode, setMode] = React.useState('today')
      const [selectedNodeId, setSelectedNodeId] = React.useState(null)
      const [drawerTab, setDrawerTab] = React.useState(null)
      const [dismissed, setDismissed] = React.useState({})

      React.useEffect(() => { attach(); return undefined }, [])

      const openDrawer = (tab) => {
        store.set({ rightTab: tab })
        setDrawerTab(tab)
      }
      const openRelation = () => { setMode('relation'); setSelectedNodeId(null) }
      const closeRelation = () => { setMode('today'); setSelectedNodeId(null) }

      let view
      if (ui.loading && !ui.loaded) {
        view = h('div', { className: 'sl-v22-screen' }, h('div', { className: 'sl-v22-scroll' }, h('p', { className: 'sl-v22-note' }, '正在读取真实状态…')))
      } else if (ui.error) {
        view = h('div', { className: 'sl-v22-screen' }, h('div', { className: 'sl-v22-scroll' }, h('div', { className: 'sl-v22-error' }, [
          h('strong', { key: 't' }, '面板读不到状态'),
          h('p', { key: 'm' }, ui.error),
          h('button', { key: 'r', type: 'button', className: 'sl-v22-ghost', onClick: () => loadState() }, '重试'),
        ])))
      } else if (mode === 'relation') {
        view = h(V22Relation, { data: ui.data, selectedNodeId, onSelect: setSelectedNodeId, onBack: closeRelation, onConnect: () => openDrawer('connect') })
      } else {
        view = h(V22Today, {
          data: ui.data,
          today: ui.today ?? ui.data?.today,
          busy: ui.todayBusy,
          dismissed,
          onRelation: openRelation,
          onAction: onTodayAction,
          onDismiss: (id) => setDismissed((prev) => ({ ...prev, [id]: true })),
          onConnect: () => openDrawer('connect'),
          onWork: () => openDrawer('work'),
          onScan: () => scanToday({ force: true }),
          onOpenSession: openNativeSession,
          ui,
        })
      }

      return h('div', { className: 'sl-root sl-v22' }, [
        h('style', { key: 'css' }, CSS + V22_CSS),
        h('main', { key: 'main', className: 'sl-v22-main' }, view),
        h(V22Drawer, { key: 'drawer', data: ui.data, tab: drawerTab, onClose: () => setDrawerTab(null) }),
        ui.toast ? h('div', { key: 'toast', className: 'sl-toast', role: 'status' }, ui.toast) : null,
      ])
    }

    // ————————————————————————— 样式（只用宿主主题变量） —————————————————————————

    const CSS = `
.sl-shell{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);position:relative}
.sl-shell-nav{width:132px;flex:0 0 132px;border-right:1px solid var(--dsw-alias-border-l1);padding:14px 10px;display:flex;flex-direction:column;gap:8px}
.sl-brand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;padding:2px 6px 10px;color:var(--dsw-alias-label-primary)}
.sl-nav{display:flex;flex-direction:column;gap:2px}
.sl-nav-item{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;text-align:left;padding:7px 10px;border-radius:8px;cursor:pointer}
.sl-nav-item:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.sl-nav-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.sl-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:auto}
.sl-stage{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;padding:16px 18px;overflow:auto}
.sl-stage-list{padding:18px 22px;gap:12px}
.sl-today-head{display:flex;flex-direction:column;gap:4px}
.sl-lanes{display:flex;gap:8px;margin:0 0 6px 0}
.sl-today-panel{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.sl-today-list{display:flex;flex-direction:column;gap:2px}
.sl-today-card{margin-top:0}
.sl-today-evidence{margin:2px 0 0;padding-left:18px;font-size:12px}
.sl-h2{font-size:15px;font-weight:600;margin:0}
.sl-h3{font-size:12px;font-weight:600;margin:0 0 4px;color:var(--dsw-alias-label-secondary);letter-spacing:.02em}
.sl-chips{display:flex;gap:6px;flex-wrap:wrap}
.sl-chip{font-size:10.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.sl-chip-btn{appearance:none;background:transparent;font:inherit;font-size:10.5px;cursor:pointer}
.sl-chip-btn:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.sl-reply{margin:0;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.sl-chip-ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.sl-center{flex:1;min-height:300px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;position:relative}
.sl-empty{display:flex;flex-direction:column;gap:10px;align-items:flex-start;max-width:560px;margin:24px auto}
.sl-empty-states{display:flex;flex-wrap:wrap;gap:8px}
.sl-static{cursor:default;opacity:.75}
.sl-phase{font-size:11.5px;color:var(--dsw-alias-label-secondary);text-align:center;max-width:620px}
.sl-phase-waiting-for-you{color:var(--dsw-alias-state-warn-primary)}
.sl-phase-failed,.sl-phase-stopped-by-owner{color:var(--dsw-alias-state-error-primary)}
.sl-phase-completed{color:var(--dsw-alias-state-success-primary)}
.sl-map{position:relative;width:min(560px,100%);aspect-ratio:1/1;max-height:min(48vh,520px);margin:0 auto}
.sl-map-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.sl-orbit{stroke:var(--dsw-alias-border-l1);stroke-width:.4;stroke-dasharray:1.5 2}
.sl-core-line{stroke:var(--dsw-alias-border-l1);stroke-width:.35;opacity:.7}
.sl-edge{stroke:var(--dsw-alias-brand-primary);stroke-width:.45;opacity:.55}
.sl-edge-dashed{stroke-dasharray:1.2 1.6;opacity:.35}
.sl-core{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:4px;padding:16px;border-radius:50%;border:1px solid var(--dsw-alias-brand-primary);background:radial-gradient(circle at 50% 40%,color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent),transparent 70%);box-shadow:0 0 22px color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.sl-core-live{animation:sl-core-breathe 1.1s ease-in-out infinite}
.sl-core-fail{border-color:var(--dsw-alias-state-error-primary);box-shadow:0 0 22px color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent)}
.sl-core-title{font-size:11px;font-weight:600}
@keyframes sl-core-breathe{0%,100%{box-shadow:0 0 14px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}50%{box-shadow:0 0 30px color-mix(in srgb,var(--dsw-alias-brand-primary) 44%,transparent)}}
.sl-node{position:absolute;transform:translate(-50%,-50%);appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;padding:6px 10px;border-radius:10px;display:flex;flex-direction:column;gap:1px;align-items:flex-start;cursor:pointer;max-width:132px;box-shadow:0 1px 6px rgba(0,0,0,.08)}
.sl-node:hover{border-color:var(--dsw-alias-brand-primary)}
.sl-node-selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.sl-node-live{animation:sl-node-pulse .9s ease-in-out infinite}
.sl-node-failed{border-color:var(--dsw-alias-state-error-primary)}
@keyframes sl-node-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-brand-primary) 0%,transparent)}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}}
.sl-node-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.sl-node.tone-blue .sl-node-dot{background:var(--dsw-alias-brand-primary)}
.sl-node.tone-teal .sl-node-dot{background:var(--dsw-alias-state-success-primary)}
.sl-node.tone-amber .sl-node-dot{background:var(--dsw-alias-state-warn-primary)}
.sl-node.tone-rose .sl-node-dot{background:var(--dsw-alias-state-error-primary)}
.sl-node.tone-violet .sl-node-dot{background:var(--dsw-alias-brand-primary);opacity:.7}
.sl-node-label{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:118px;font-size:11.5px}
.sl-node-kind{font-size:9.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.03em}
.sl-node-detail{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);max-width:520px;width:100%;display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.sl-row{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%}
.sl-hint{font-size:10.5px;color:var(--dsw-alias-state-idle-primary);text-align:center;margin:2px 0 0}
.sl-composer{padding:8px 0 2px;display:flex;flex-direction:column;gap:8px;max-width:760px;width:100%;margin:0 auto}
.sl-input-row{display:flex;gap:8px;align-items:center;width:100%}
.sl-input{flex:1;min-width:0;appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:9px 12px;border-radius:10px}
.sl-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.sl-input:disabled{opacity:.6}
.sl-primary{appearance:none;border:1px solid transparent;background:var(--dsw-alias-brand-primary);color:#0d1316;font:inherit;font-size:12.5px;font-weight:600;padding:8px 16px;border-radius:9px;cursor:pointer;white-space:nowrap}
.sl-primary:hover{filter:brightness(1.06)}
.sl-primary:disabled{opacity:.5;cursor:not-allowed}
.sl-quiet{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;padding:7px 12px;border-radius:9px;cursor:pointer;white-space:nowrap}
.sl-quiet:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.sl-small{font-size:11px;padding:4px 9px}
.sl-link-btn{color:var(--dsw-alias-brand-primary);font-size:12px;text-decoration:none;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);align-self:flex-start}
.sl-link-btn:hover{text-decoration:none;border-bottom-color:var(--dsw-alias-brand-primary)}
.sl-right{width:340px;flex:0 0 340px;border-left:1px solid var(--dsw-alias-border-l1);overflow:auto;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column}
.sl-right-tabs{display:flex;gap:2px;padding:10px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sl-tabs{display:flex;gap:2px}
.sl-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:6px 10px;border-radius:8px 8px 0 0;cursor:pointer;border-bottom:2px solid transparent}
.sl-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.sl-right-inner{display:flex;flex-direction:column;gap:0;padding:12px 16px 24px;overflow:auto}
.sl-block{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sl-block:last-child{border-bottom:0}
.sl-focus{margin:0 0 4px;font-size:13.5px;font-weight:600}
.sl-strong{font-weight:600;margin:0 0 4px;font-size:12.5px}
.sl-muted{color:var(--dsw-alias-label-secondary);margin:2px 0;font-size:12px;line-height:1.5}
.sl-bullets,.sl-sources,.sl-decisions{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:5px;font-size:12px}
.sl-bullets li,.sl-sources li,.sl-decisions li{color:var(--dsw-alias-label-secondary);position:relative;padding-left:11px}
.sl-bullets li::before,.sl-sources li::before,.sl-decisions li::before{content:'';position:absolute;left:0;top:7px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.sl-decisions li strong{display:block;color:var(--dsw-alias-label-primary)}
.sl-decisions li button{margin-top:4px}
.sl-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 11px;margin-top:10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:7px;align-items:flex-start;width:100%}
.sl-card .sl-input{width:100%}
.sl-card-title{font-weight:600;font-size:12.5px}
.sl-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;letter-spacing:.14em;padding:5px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sl-scopes{list-style:none;margin:2px 0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.sl-scopes li{position:relative;padding-left:12px}
.sl-scopes li::before{content:'';position:absolute;left:0;top:6px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.sl-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.sl-step{display:grid;grid-template-columns:52px 1fr;gap:2px 8px;font-size:11.5px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.sl-step-time{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.sl-step-verb{font-weight:600}
.sl-step-target{color:var(--dsw-alias-label-secondary);grid-column:1/3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sl-step-status{grid-column:1/3;font-size:10.5px}
.sl-step-ok .sl-step-status{color:var(--dsw-alias-state-success-primary)}
.sl-step-failed .sl-step-status{color:var(--dsw-alias-state-error-primary)}
.sl-step-running .sl-step-status{color:var(--dsw-alias-brand-primary)}
.sl-error-note{font-size:11px;color:var(--dsw-alias-state-error-primary);margin:0;grid-column:1/3}
.sl-conversation{margin-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px;display:flex;flex-direction:column;gap:4px;width:100%}
.sl-messages{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}
.sl-messages li{display:flex;gap:6px;font-size:11.5px;line-height:1.5}
.sl-who{flex:0 0 30px;color:var(--dsw-alias-label-secondary)}
.sl-msg-text{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.sl-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.sl-list-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:3px;background:var(--dsw-alias-bg-layer-1)}
.sl-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.sl-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 14px;font-size:12px;box-shadow:0 6px 22px rgba(0,0,0,.18);z-index:5;max-width:70%}
@media (prefers-reduced-motion: reduce){.sl-core-live,.sl-node-live{animation:none}}
@media (max-width: 960px){.sl-right{display:none}.sl-shell-nav{width:96px;flex-basis:96px}}
@media (max-width: 720px){.sl-shell{flex-direction:column}.sl-shell-nav{width:auto;flex:0 0 auto;flex-direction:row;align-items:center;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto}.sl-nav{flex-direction:row}.sl-brand{padding:0 8px 0 2px}.sl-main{min-height:0}}
`

    // ————————————————————————— 注册 —————————————————————————

    function apply(ctx) {
      ctxRef = ctx

      ctx.effect(() => ctx.locale.register(NS, {
        zh: { panel: '生络', today: '今天', goals: '目标', projects: '项目', artifacts: '成果', knowledge: '知识', connect: '连接' },
        en: { panel: 'ShengLuo', today: 'Today', goals: 'Goals', projects: 'Projects', artifacts: 'Deliverables', knowledge: 'Knowledge', connect: 'Connections' },
      }), 'shengluo: locale')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: -100,
        label: () => '生络',
        locale: NS,
      }, PanelIcon)), 'shengluo: sidebar entry')

      ctx.effect(() => ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, ShengluoPanelRoot)
      }), 'shengluo: main panel')

      ctx.effect(() => () => {
        if (eventSource) { try { eventSource.close() } catch { /* 已经关了 */ } eventSource = null }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        attached = false
        stopDevicePolling()
      }, 'shengluo: client resources')
    }

    return { inject: ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace'], apply }
  },
})
