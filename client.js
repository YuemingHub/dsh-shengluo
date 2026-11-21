/* 生络 DSH plugin client — original code; no embedded runtime or graph canvas vendor. */
/**
 * 生络 ShengLuo — DSH 原生插件（Client 半个）。
 *
 * 一个入口（侧栏「生络」）→ 一块主面板：
 *   左侧导航：今天 / 项目 / 成果 / 知识 / 插件
 *   中间：一个生络智能核心 + 围绕它的真实语义节点（默认 5–9 个）
 *   右侧：当前正在处理的事情 / 生络目前的理解 / 用了哪些现实和资料 / 下一步 / 待你决定
 *   底部：一句自然语言 ——「今天你想推进什么？」
 *
 * 执行不在这里：会话、工具、审批、文件预览全是 DSH 原生的。
 * 面板只做两件事：把真实状态说清楚，把本人送到原生界面去决定。
 */
window.__ModuleLoader__.load({
  id: '@shengluo/dsh-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'shengluo'
    const PANEL_ID = 'shengluo'
    const API = '/sl/api'

    const KIND = {
      reality: { label: '我的现实', tone: 'amber' },
      goal: { label: '目标', tone: 'blue' },
      project: { label: '项目', tone: 'teal' },
      task: { label: '执行', tone: 'violet' },
      artifact: { label: '成果', tone: 'rose' },
      decision: { label: '待你决定', tone: 'amber' },
      knowledge: { label: '知识', tone: 'slate' },
    }

    const STATUS_LABEL = {
      running: '正在做',
      completed: '已完成',
      failed: '已如实停下',
      stopped: '已停下',
    }

    const NAV = [
      { id: 'today', label: '今天' },
      { id: 'projects', label: '项目' },
      { id: 'artifacts', label: '成果' },
      { id: 'knowledge', label: '知识' },
      { id: 'plugins', label: '插件' },
    ]

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
      view: 'today',
      goal: '',
      phase: 'idle', // idle | confirm | working
      data: null,
      loading: true,
      error: null,
      toast: null,
      pendingDevice: null,
      pollTimer: null,
      sessionId: null,
      runId: null,
      devicePolling: false,
      busy: false,
      realityBusy: false,
      lastQuery: null,
      conversation: null,
    })

    let ctxRef = null
    let attached = false
    let eventSource = null
    let pollTimer = null

    const useStore = () => React.useSyncExternalStore(store.subscribe, store.get, store.get)

    // ————————————————————————— 本机接口 —————————————————————————

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

    async function loadState({ silent = false } = {}) {
      if (!silent) store.set({ loading: true })
      try {
        const data = await api('/state')
        const active = data.activeRun
        const patch = { data, loading: false, error: null }
        // 后台推进/完成后，把面板状态和真实运行状态对齐，不自己编状态。
        if (active) {
          patch.sessionId = active.sessionId
          patch.runId = active.runId
          if (active.status === 'running') patch.phase = 'working'
        }
        store.set(patch)
        return data
      } catch (error) {
        store.set({ loading: false, error: error.message })
        return null
      }
    }

    function attach() {
      if (attached || !ctxRef) return
      attached = true
      loadState()
      try {
        eventSource = new EventSource(API + '/stream')
        eventSource.onmessage = (event) => {
          let payload = null
          try { payload = JSON.parse(event.data) } catch { return }
          if (!payload || !payload.type) return
          if (payload.type === 'run/activity' || payload.type === 'run/end' || payload.type === 'run/decision'
            || payload.type === 'run/approval-decided' || payload.type === 'network/changed'
            || payload.type === 'reality/linked' || payload.type === 'reality/revoked') {
            loadState({ silent: true })
          }
          if (payload.type === 'run/end') {
            const status = payload.status
            if (status === 'failed') {
              toast('这次如实停下了' + (payload.note ? '：' + payload.note : '，没有假装完成。'))
            }
            if (status === 'completed') toast('这件事完成了，成果在右边。')
          }
        }
        eventSource.onerror = () => { /* EventSource 自己重连 */ }
      } catch {
        // 没有 SSE 就退回慢轮询，功能不丢。
        pollTimer = setInterval(() => loadState({ silent: true }), 4000)
      }
      return () => {
        if (eventSource) { try { eventSource.close() } catch {} eventSource = null }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        attached = false
      }
    }

    // ————————————————————————— 原生会话 —————————————————————————

    function currentCwd(data) {
      const project = (data?.network?.workspaces ?? []).find((workspace) => workspace.active) ?? null
      return project?.path ?? null
    }

    async function beginWork() {
      const state = store.get()
      const goal = state.goal.trim()
      if (!goal || state.busy) return
      const data = state.data
      store.set({ busy: true })
      try {
        // 1) 真实原生会话：agentPreset = 生络伙伴（本插件注册的 preset）。
        const sessionId = await ctxRef.sessions.create({ agentPreset: 'shengluo', cwd: currentCwd(data) ?? undefined })
        // 2) 保留引用后投递这条目标 —— 走的是 DSH 原生提示通道，不是自己的任务系统。
        const reference = ctxRef.sessions.retain(sessionId, { source: 'mainView' })
        const binding = await reference.ready
        const contract = contractLines(data)
        const prompt = [
          goal,
          '',
          '（来自生络面板。先确认再动手：）',
          '我会用到：' + contract.uses.join('；'),
          '我会交付：' + contract.delivers.join('；'),
          '需要你定：' + contract.decisions.join('；'),
        ].join('\n')
        const result = await binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
        if (result && result.ok === false) throw new Error(result.error?.message ?? '原生会话没接受这条请求')
        // 3) 登记到产品层（只登记 id，不接管执行）。
        const started = await api('/run/start', { method: 'POST', body: { sessionId, goal, cwd: currentCwd(data) } })
        store.set({ phase: 'working', sessionId, runId: started.runId, busy: false })
        await loadState({ silent: true })
      } catch (error) {
        store.set({ busy: false })
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
        await api('/run/status', { method: 'POST', body: { status: 'failed', phase: 'stopped', endReason: 'cancelled-by-owner' } })
        toast('已停下。')
        await loadState({ silent: true })
      } catch (error) {
        toast('停下失败：' + error.message)
      }
    }

    function openNativeSession(sessionId) {
      if (!sessionId) return
      try {
        // 去原生会话就是真的去：openSession 会把主区切到那个 Conversation，
        // 审批卡片、工具结果、文件预览都在那里。不要立刻把面板抢回来 ——
        // 那会让用户看不到审批，等于把"回原生界面决定"这件事做废。
        // 想回生络，点左侧栏的「生络」即可（layout.selectPanel 由侧栏负责）。
        ctxRef.uiWorkspace.openSession(sessionId)
      } catch (error) {
        toast('打开原生会话失败：' + error.message)
      }
    }

    function openNativePlugins() {
      try { ctxRef.layout.selectPanel('plugins') } catch (error) { toast('打开原生插件管理失败：' + error.message) }
    }

    // ————————————————————————— 三条契约（完全由真实状态推出，不是假计划） —————————————————————————

    function contractLines(data) {
      const network = data?.network ?? {}
      const reality = data?.reality ?? {}
      const workspaces = network.workspaces ?? []
      const knowledge = network.knowledge ?? []
      const artifacts = network.artifacts ?? []
      const uses = []
      const activeProject = workspaces.find((workspace) => workspace.active) ?? workspaces[0] ?? null
      uses.push(activeProject ? '项目「' + activeProject.title + '」里的真实文件' : '当前 DSH 工作区的真实文件')
      if (knowledge.length > 0) uses.push(knowledge.length + ' 条知识（' + knowledge[0].label + '）')
      if (reality.state === 'authorized') uses.push('你的个人现实（已授权，只读，仅本人可访问部分）')
      const delivers = []
      delivers.push('写在' + (activeProject ? '「' + activeProject.title + '」目录' : '工作区目录') + '里、能直接打开的文件')
      if (artifacts.length > 0) delivers.push('会在现有 ' + artifacts.length + ' 个文件上继续')
      const decisions = []
      if (reality.state !== 'authorized') decisions.push('本次只用工作区资料；个人现实尚未授权，所以我不猜你的生活')
      else decisions.push('会读你的个人现实，范围仅限你本人有权访问的对话与现实')
      decisions.push('高影响动作（发出去、删东西、花钱、替别人做承诺）我会停下来问你')
      return { uses, delivers, decisions }
    }

    // ————————————————————————— 授权 —————————————————————————

    async function connectReality() {
      store.set({ busy: true })
      try {
        const started = await api('/reality/connect', { method: 'POST', body: { locale: 'zh-CN' } })
        store.set({ pendingDevice: started, busy: false })
        if (started.verificationUriComplete) {
          try { window.open(started.verificationUriComplete, '_blank', 'noopener,noreferrer') } catch { /* 浏览器拦了就让用户点链接 */ }
        }
        startDevicePolling()
      } catch (error) {
        store.set({ busy: false })
        toast('开启授权失败：' + error.message)
      }
    }

    function startDevicePolling() {
      stopDevicePolling()
      const timer = setInterval(async () => {
        const state = store.get()
        if (!state.pendingDevice || state.devicePolling) return
        store.set({ devicePolling: true })
        try {
          const result = await api('/reality/poll', { method: 'POST' })
          if (result.state === 'pending') {
            if (result.interval) store.set({ pendingDevice: { ...store.get().pendingDevice, interval: result.interval } })
          } else if (result.state === 'linked') {
            stopDevicePolling()
            store.set({ pendingDevice: null, devicePolling: false })
            toast('个人现实已连接。')
            await loadState({ silent: true })
            return
          } else {
            stopDevicePolling()
            store.set({ pendingDevice: null })
            toast(result.detail ?? '授权没有完成。')
            await loadState({ silent: true })
            return
          }
        } catch (error) {
          toast('授权轮询失败：' + error.message)
        } finally {
          store.set({ devicePolling: false })
        }
      }, 5000)
      store.set({ pollTimer: timer })
    }

    function stopDevicePolling() {
      const timer = store.get().pollTimer
      if (timer) clearInterval(timer)
      store.set({ pollTimer: null })
    }

    async function revokeReality() {
      if (!window.confirm('撤销后生络立刻停止读取你的个人现实。确定吗？')) return
      try {
        const result = await api('/reality/revoke', { method: 'POST' })
        const detail = result?.server?.ok ? '已经在家庭空间撤销，并删掉了本机凭据。' : '本机凭据已删除。家庭空间那边可能仍需你确认撤销。'
        toast(detail)
        await loadState({ silent: true })
      } catch (error) {
        toast('撤销失败：' + error.message)
      }
    }

    /**
     * 授权之后的下一个动作：按当前这件事问一次个人现实。
     * 不自动查（不在启动时全量同步），本人点一下才查；查到的结果进网络。
     */
    async function queryRealityFromPanel() {
      const state = store.get()
      const task = (state.goal || '').trim() || (state.data?.network?.focus ?? '') || '了解我现在的处境'
      if (state.realityBusy) return
      store.set({ realityBusy: true })
      try {
        const result = await api('/reality/query', { method: 'POST', body: { task, limit: 10 } })
        if (!result?.ok) {
          store.set({ realityBusy: false })
          toast('这次没读到：' + (result?.detail ?? '未知原因'))
          return
        }
        const facts = result.results?.length ?? 0
        const conversations = result.conversations?.length ?? 0
        const summary = facts === 0
          ? (result.unknowns?.[0]?.message || '这次范围内没有匹配到相关现实——是没有匹配，不是不存在。')
          : '读到 ' + facts + ' 条个人现实' + (conversations > 0 ? '、' + conversations + ' 段可回溯的对话' : '') + '，已经放到网络上。'
        store.set({ realityBusy: false, lastQuery: summary })
        toast(summary)
        await loadState({ silent: true })
      } catch (error) {
        store.set({ realityBusy: false })
        toast('读取失败：' + error.message)
      }
    }

    /** 看某条现实背后的对话原文（逐字，不改写）。 */
    async function openConversation(conversationId) {
      if (!conversationId) return
      try {
        const result = await api('/reality/conversation', { method: 'POST', body: { conversationId } })
        if (!result?.ok) { toast(result?.detail ?? '这段对话打不开。'); return }
        store.set({ conversation: result.conversation })
      } catch (error) {
        toast('打开对话失败：' + error.message)
      }
    }

    // ————————————————————————— 组件 —————————————————————————

    function PanelIcon({ size }) {
      const dimension = size || 16
      return h('svg', {
        width: dimension, height: dimension, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false',
      }, [
        h('circle', { key: 'r', cx: 8, cy: 8, r: 6.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeDasharray: '2 2.6', opacity: 0.85 }),
        h('circle', { key: 'c', cx: 8, cy: 8, r: 3.4, fill: 'currentColor', opacity: 0.9 }),
      ])
    }

    function NodeDot({ node, active, onSelect }) {
      const tone = (KIND[node.kind] ?? KIND.project).tone
      const classes = ['sl-node', 'tone-' + tone, active ? 'is-active' : ''].join(' ').trim()
      // 「我的现实」的来源比它的类型更有信息量，所以这类节点显示来源而不是重复类型名。
      const kindLabel = node.kind === 'reality'
        ? (node.unsupported ? '未连接 · 未知' : '家庭空间')
        : (KIND[node.kind] ?? KIND.project).label
      return h('button', {
        type: 'button',
        className: classes,
        onClick: () => onSelect(node),
        title: node.subtitle ? node.title + '｜' + node.subtitle : node.title,
      }, [
        h('span', { key: 'd', className: 'sl-node-dot', 'aria-hidden': 'true' }),
        h('span', { key: 'l', className: 'sl-node-label' }, node.title),
        h('span', { key: 'k', className: 'sl-node-kind' }, kindLabel),
      ])
    }

    function NetworkMap({ data, selected, onSelect }) {
      const nodes = data?.network?.nodes ?? []
      const edges = data?.network?.edges ?? []
      const focus = data?.network?.focus
      const status = data?.network?.focusStatus
      const radius = nodes.length > 6 ? 196 : 172
      const box = radius * 2 + 96
      const center = box / 2
      const positions = new Map()
      nodes.forEach((node, index) => {
        const angle = (-Math.PI / 2) + (index * 2 * Math.PI) / Math.max(nodes.length, 1)
        positions.set(node.id, {
          x: center + Math.cos(angle) * radius,
          y: center + Math.sin(angle) * radius,
        })
      })

      const lines = []
      lines.push(h('circle', { key: 'orbit', className: 'sl-orbit', cx: center, cy: center, r: radius, fill: 'none' }))
      for (const edge of edges) {
        const from = positions.get(edge.from)
        const to = positions.get(edge.to)
        if (!from || !to) continue
        lines.push(h('line', {
          key: edge.id, className: 'sl-link',
          x1: from.x, y1: from.y, x2: to.x, y2: to.y,
        }))
      }
      for (const node of nodes) {
        const position = positions.get(node.id)
        if (!position) continue
        lines.push(h('line', {
          key: 'spoke-' + node.id, className: 'sl-spoke',
          x1: center, y1: center, x2: position.x, y2: position.y,
        }))
      }

      return h('div', { className: 'sl-map', style: { width: box, height: box } }, [
        h('svg', { key: 'svg', className: 'sl-map-svg', viewBox: '0 0 ' + box + ' ' + box, 'aria-hidden': 'true' }, lines),
        h('div', { key: 'core', className: 'sl-core' }, [
          h('div', { key: 'o', className: 'sl-orb', 'aria-hidden': 'true' }, [
            h('span', { key: 'h', className: 'sl-orb-halo' }),
            h('span', { key: 'c', className: 'sl-orb-core' }),
            h('span', { key: 'm', className: 'sl-orb-mark' }, '∞'),
          ]),
          h('div', { key: 't', className: 'sl-core-text' }, [
            h('strong', { key: 'n' }, '生络'),
            h('span', { key: 's' }, status === 'running' ? '正在理解 · 调用 · 执行 · 核对' : focus ? '当前这件事在这里' : '在等你说一句话'),
          ]),
        ]),
        ...nodes.map((node) => {
          const position = positions.get(node.id)
          if (!position) return null
          return h('div', {
            key: 'pos-' + node.id,
            className: 'sl-node-holder',
            style: { left: position.x + 'px', top: position.y + 'px' },
          }, h(NodeDot, { node, active: selected?.id === node.id, onSelect }))
        }),
      ])
    }

    function Relations({ data, onSelect }) {
      const edges = data?.network?.edges ?? []
      if (edges.length === 0) return null
      return h('ul', { className: 'sl-relations' }, edges.slice(0, 6).map((edge) => h('li', { key: edge.id }, [
        h('button', { key: 'b', type: 'button', className: 'sl-relation', onClick: () => onSelect(null), title: edge.why ?? '' }, edge.label),
      ])))
    }

    function RealityBlock({ data }) {
      const reality = data?.reality
      const state = store.get()
      if (!reality) return null
      if (state.pendingDevice) {
        const labels = state.pendingDevice.requestedScopeLabels ?? []
        return h('div', { className: 'sl-card' }, [
          h('div', { key: 't', className: 'sl-card-title' }, '在家庭空间里确认'),
          h('div', { key: 'u', className: 'sl-code' }, state.pendingDevice.userCode),
          h('p', { key: 'd', className: 'sl-muted' }, '浏览器已经打开授权页。用你自己的 Family Space 账号登录，看清楚它要的范围再同意：'),
          labels.length > 0
            ? h('ul', { key: 'l', className: 'sl-scopes' }, labels.map((label) => h('li', { key: label.id }, label.label)))
            : null,
          h('p', { key: 'n', className: 'sl-hint' }, '连接码 ' + Math.max(1, Math.round((state.pendingDevice.expiresIn ?? 600) / 60)) + ' 分钟内有效。不是你刚发起的那一次，请不要同意。'),
          h('a', {
            key: 'a', className: 'sl-link-btn',
            href: state.pendingDevice.verificationUriComplete, target: '_blank', rel: 'noreferrer noopener',
          }, '重新打开授权页'),
        ])
      }
      if (reality.state === 'authorized') {
        const subject = reality.subject?.displayName ?? reality.subject?.principalId
        return h('div', { className: 'sl-card' }, [
          h('div', { key: 't', className: 'sl-row' }, [
            h('span', { key: 'l', className: 'sl-ok' }, '个人现实：已授权'),
            h('button', { key: 'b', type: 'button', className: 'sl-quiet sl-small', onClick: revokeReality }, '撤回'),
          ]),
          h('p', { key: 'd', className: 'sl-muted' }, [
            subject ? '当前账号：' + subject + '。' : '当前账号已授权。',
            '只读，只限你本人有权访问的部分；不会在启动时全量同步。撤回入口也在家庭空间「我的 → 隐私和数据」。',
          ].join('')),
          h('button', {
            key: 'q', type: 'button', className: 'sl-primary sl-small',
            onClick: queryRealityFromPanel, disabled: state.realityBusy,
          }, state.realityBusy ? '正在查…' : '查一下这件事的现实'),
          state.lastQuery ? h('p', { key: 'r', className: 'sl-hint' }, state.lastQuery) : null,
        ])
      }
      const expired = reality.state === 'expired'
      return h('div', { className: 'sl-card' }, [
        h('div', { key: 't', className: 'sl-card-title' }, expired ? '个人现实：授权已过期' : '个人现实：尚未授权'),
        h('p', { key: 'd', className: 'sl-muted' }, expired
          ? '旧的凭据已经不能用。重连一次，我才能继续读你有权访问的部分。'
          : '现在关于你的生活、家庭对话，我只有「未知」。我不会用测试数据或猜测填这个空白。'),
        h('button', { key: 'c', type: 'button', className: 'sl-primary', onClick: connectReality, disabled: state.busy }, '连接家庭空间'),
      ])
    }

    function RightPanel({ data, approval, onSelect }) {
      const network = data?.network ?? {}
      const selected = store.get().goal
      const understanding = network.understanding
      const activeRun = data?.activeRun
      const facts = (network.nodes ?? []).filter((node) => node.kind === 'reality')
      const workspaces = network.workspaces ?? []
      const knowledge = network.knowledge ?? []
      const nextStepNode = (network.nodes ?? []).find((node) => node.kind === 'task')
      const decisions = network.decisions ?? []

      return h('div', { className: 'sl-right-inner' }, [
        h('section', { key: 'a', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '当前正在处理的事情'),
          network.focus
            ? h('div', { key: 'f' }, [
                h('p', { key: 'g', className: 'sl-focus' }, network.focus),
                h('p', { key: 's', className: 'sl-muted' }, [
                  STATUS_LABEL[activeRun?.status ?? network.focusStatus] ?? '已记录',
                  activeRun?.toolCalls ? ' · 已经真实调用工具 ' + activeRun.toolCalls + ' 次' : '',
                ].join('')),
                activeRun?.status === 'failed' && activeRun?.endNote
                  ? h('p', { key: 'e', className: 'sl-error-note' }, '为什么停下：' + activeRun.endNote)
                  : null,
              ])
            : h('p', { key: 'e', className: 'sl-muted' }, '还没有开始的事。在下面说一句你想推进什么。'),
          approval ? h('div', { key: 'ap', className: 'sl-approval' }, [
            h('p', { key: 'p' }, '有一个审批在等你。这一步要你点了才会往下走。'),
            h('button', {
              key: 'b', type: 'button', className: 'sl-primary',
              onClick: () => openNativeSession(activeRun?.sessionId ?? store.get().sessionId),
            }, '到原生会话里允许或拒绝'),
          ]) : null,
          activeRun?.sessionId ? h('button', {
            key: 'o', type: 'button', className: 'sl-quiet sl-small',
            onClick: () => openNativeSession(activeRun.sessionId),
          }, '打开原生会话') : null,
        ]),

        h('section', { key: 'b', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '生络目前的理解'),
          understanding
            ? h('div', { key: 'u' }, [
                h('p', { key: 'hl', className: 'sl-strong' }, understanding.headline),
                h('ul', { key: 'ul', className: 'sl-bullets' }, (understanding.points ?? []).map((point, index) => h('li', { key: index }, point))),
              ])
            : h('p', { key: 'n', className: 'sl-muted' }, '还没有足够真实信息，我不编一个理解。'),
        ]),

        h('section', { key: 'c', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '用了哪些现实和资料'),
          h('ul', { key: 'ul', className: 'sl-sources' }, [
            h('li', { key: 'reality' }, data?.reality?.state === 'authorized'
              ? '个人现实：已授权' + (facts.length > 0 ? '（本次 ' + facts.length + ' 条）' : '（本次还没查）')
              : '个人现实：尚未授权 —— 未知'),
            ...workspaces.slice(0, 3).map((workspace) => h('li', { key: 'w-' + workspace.id }, '项目：' + workspace.title + (workspace.active ? '（当前）' : ''))),
            ...knowledge.slice(0, 2).map((item) => h('li', { key: 'k-' + item.id }, '知识：' + item.title)),
            h('li', { key: 'exec' }, '执行：DSH 原生会话（真实工具调用与审批）'),
          ]),
          h(RealityBlock, { key: 'reality', data }),
        ]),

        h('section', { key: 'd', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '下一步'),
          h('p', { key: 'p', className: 'sl-muted' }, nextStepNode
            ? '继续「' + nextStepNode.title + '」，在原生会话里推进；需要你定的地方我会停下来。'
            : '说一句你想推进什么，我会先给出「我会用到 / 我会交付 / 需要你定」，你点头再动手。'),
        ]),

        h('section', { key: 'e', className: 'sl-block' }, [
          h('h3', { key: 'h', className: 'sl-h3' }, '待你决定'),
          decisions.filter((decision) => !decision.resolved).length === 0 && !approval
            ? h('p', { key: 'n', className: 'sl-muted' }, '现在没有要你拍板的事。')
            : h('ul', { key: 'ul', className: 'sl-decisions' }, decisions.filter((decision) => !decision.resolved).slice(0, 4).map((decision) => h('li', { key: decision.id }, [
                h('strong', { key: 't' }, decision.title),
                decision.detail ? h('span', { key: 'd', className: 'sl-muted' }, decision.detail) : null,
              ]))),
        ]),
      ])
    }

    function TodayView({ data, approval }) {
      const [selected, setSelected] = React.useState(null)
      const ui = useStore()
      const nodes = data?.network?.nodes ?? []
      const empty = nodes.length === 0

      if (empty && !data?.loading) {
        return h('div', { className: 'sl-stage' }, [
          h('div', { key: 'c', className: 'sl-center' }, h('p', { className: 'sl-muted' }, '还没有真实节点。先从一个真实项目，或下面一句话开始。')),
          h(Composer, { key: 'composer', data, approval }),
        ])
      }

      return h('div', { className: 'sl-stage' }, [
        h('div', { key: 'map', className: 'sl-center' }, [
          h(NetworkMap, { key: 'm', data, selected, onSelect: setSelected }),
          h(Relations, { key: 'r', data, onSelect: setSelected }),
          selected ? h('div', { key: 'detail', className: 'sl-node-detail' }, [
            h('div', { key: 'h', className: 'sl-row' }, [
              h('strong', { key: 't' }, selected.title),
              h('button', { key: 'x', type: 'button', className: 'sl-quiet sl-small', onClick: () => setSelected(null) }, '收起'),
            ]),
            h('p', { key: 's', className: 'sl-muted' }, selected.subtitle ?? ''),
            selected.sourceRef ? h('p', { key: 'src', className: 'sl-muted' }, '来源：' + selected.sourceRef.label + (selected.time?.label ? ' · ' + selected.time.label : '')) : null,
            selected.openable?.kind === 'session'
              ? h('button', { key: 'o', type: 'button', className: 'sl-quiet sl-small', onClick: () => openNativeSession(selected.openable.target) }, '打开原生会话')
              : null,
            selected.openable?.kind === 'conversation'
              ? h('button', { key: 'c', type: 'button', className: 'sl-quiet sl-small', onClick: () => openConversation(selected.openable.target) }, '看原始对话证据')
              : null,
            selected.openable?.kind === 'artifact'
              ? h('a', { key: 'a', className: 'sl-link-btn', href: API + '/artifact?path=' + encodeURIComponent(selected.openable.target), target: '_blank', rel: 'noreferrer noopener' }, '打开成果')
              : null,
            ui.conversation ? h('div', { key: 'conversation', className: 'sl-conversation' }, [
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
          ]) : null,
          h('p', { key: 'hint', className: 'sl-hint' }, (data?.network?.hiddenCount ?? 0) > 0
            ? '还有 ' + data.network.hiddenCount + ' 个真实节点收在详情里。这里只放跟当前这件事有关的。'
            : '节点全部来自真实项目、会话、成果和你的现实；没来源的一律标未知。'),
        ]),
        h(Composer, { key: 'composer', data, approval }),
      ])
    }

    function ListView({ title, items, render, emptyText, footer }) {
      return h('div', { className: 'sl-stage sl-stage-list' }, [
        h('h2', { key: 'h', className: 'sl-h2' }, title),
        items.length === 0
          ? h('p', { key: 'e', className: 'sl-muted' }, emptyText)
          : h('ul', { key: 'ul', className: 'sl-list' }, items.map(render)),
        footer ?? null,
      ])
    }

    function Composer({ data, approval }) {
      const state = useStore()
      const contract = contractLines(data)
      const disabled = state.phase === 'working' || state.busy
      return h('div', { className: 'sl-composer' }, [
        state.phase === 'confirm' ? h('div', { key: 'k', className: 'sl-contract' }, [
          h('div', { key: 't', className: 'sl-contract-title' }, '先确认，再动手'),
          h('dl', { key: 'dl' }, [
            h('dt', { key: 'a' }, '我会用到'), h('dd', { key: 'a2' }, contract.uses.join('；')),
            h('dt', { key: 'b' }, '我会交付'), h('dd', { key: 'b2' }, contract.delivers.join('；')),
            h('dt', { key: 'c' }, '需要你定'), h('dd', { key: 'c2' }, contract.decisions.join('；')),
          ]),
        ]) : null,
        h('form', {
          key: 'f',
          className: 'sl-input-row',
          onSubmit: (event) => {
            event.preventDefault()
            if (disabled) return
            if (state.phase === 'confirm') beginWork()
            else store.set({ phase: 'confirm' })
          },
        }, [
          h('input', {
            key: 'i',
            className: 'sl-input',
            value: state.goal,
            placeholder: '今天你想推进什么？',
            onChange: (event) => store.set({ goal: event.target.value, phase: event.target.value.trim() ? store.get().phase : 'idle' }),
            disabled,
            'aria-label': '今天你想推进什么？',
          }),
          state.phase === 'working'
            ? h('button', { key: 's', type: 'button', className: 'sl-quiet', onClick: stopWork }, '停下')
            : h('button', { key: 'n', type: 'submit', className: 'sl-primary', disabled: disabled || !state.goal.trim() },
                state.phase === 'confirm' ? '开始工作' : '下一步'),
        ]),
        approval ? h('p', { key: 'ap', className: 'sl-approval-inline' }, '有一个审批在等你 —— 去原生会话里决定，我在这里等。') : null,
        state.phase === 'working' ? h('p', { key: 'w', className: 'sl-hint' }, '正在真实执行。审批、工具结果都是 DSH 原生的，我不会跳过它们。') : null,
      ])
    }

    function ShengluoPanel(props) {
      const state = useStore()
      React.useEffect(() => { attach(); return undefined }, [])

      // 原生审批状态：只读，用来提醒，不去抢审批本身（审批由 DSH 原生界面负责）。
      const sessionId = state.sessionId ?? state.data?.activeRun?.sessionId ?? null
      let approval = false
      try {
        if (sessionId && typeof props.useSessionStatus === 'function') {
          approval = Boolean(props.useSessionStatus((map) => map.get(sessionId)?.pendingInteraction !== undefined))
        }
      } catch {
        approval = false
      }

      const data = state.data
      const network = data?.network ?? {}

      const body = (() => {
        if (state.loading && !data) return h('div', { className: 'sl-stage' }, h('p', { className: 'sl-muted' }, '正在读取真实状态…'))
        if (state.error && !data) {
          return h('div', { className: 'sl-stage' }, h('div', { className: 'sl-error' }, [
            h('p', { key: 'm' }, '本机接口读不到：' + state.error),
            h('button', { key: 'r', type: 'button', className: 'sl-quiet', onClick: () => loadState() }, '重试'),
          ]))
        }
        if (state.view === 'projects') {
          return h(ListView, {
            title: '项目',
            items: network.workspaces ?? [],
            emptyText: '本机还没有登记过 DSH 项目。在工作区里打开一个目录，它就会出现在这里。',
            render: (workspace) => h('li', { key: workspace.id, className: 'sl-list-item' }, [
              h('div', { key: 't', className: 'sl-strong' }, workspace.title),
              h('div', { key: 'p', className: 'sl-muted' }, workspace.path),
            ]),
          })
        }
        if (state.view === 'artifacts') {
          return h(ListView, {
            title: '成果',
            items: network.artifacts ?? [],
            emptyText: '还没有真实成果。完成一件事后，写在工作区里的文件会出现在这里。',
            render: (artifact) => h('li', { key: artifact.path, className: 'sl-list-item' }, [
              h('div', { key: 't', className: 'sl-strong' }, artifact.name),
              h('div', { key: 'm', className: 'sl-muted' }, [artifact.kind, artifact.sizeLabel, artifact.modifiedAt ? String(artifact.modifiedAt).slice(0, 16).replace('T', ' ') : ''].filter(Boolean).join(' · ')),
              h('a', { key: 'a', className: 'sl-link-btn', href: API + '/artifact?path=' + encodeURIComponent(artifact.path), target: '_blank', rel: 'noreferrer noopener' }, '打开'),
            ]),
          })
        }
        if (state.view === 'knowledge') {
          return h(ListView, {
            title: '知识',
            items: network.knowledge ?? [],
            emptyText: '还没有配置知识来源（MKI 目录）。没有来源时我不会编知识条目。',
            render: (item) => h('li', { key: item.id, className: 'sl-list-item' }, [
              h('div', { key: 't', className: 'sl-strong' }, item.title),
              h('div', { key: 'm', className: 'sl-muted' }, [item.label, item.sizeLabel, item.at ? String(item.at).slice(0, 10) : ''].filter(Boolean).join(' · ')),
            ]),
          })
        }
        if (state.view === 'plugins') {
          return h('div', { className: 'sl-stage sl-stage-list' }, [
            h('h2', { key: 'h', className: 'sl-h2' }, '插件'),
            h('p', { key: 'p', className: 'sl-muted' }, '生络是 DeepSeek Harness 的原生插件。插件的安装、启停、升级由 DSH 自己的插件管理负责 —— 生络不复制一套。'),
            h('button', { key: 'b', type: 'button', className: 'sl-primary', onClick: openNativePlugins }, '打开 DSH 原生插件管理'),
            h('ul', { key: 'ul', className: 'sl-list' }, [
              h('li', { key: 'self', className: 'sl-list-item' }, [
                h('div', { key: 't', className: 'sl-strong' }, '生络（本插件）'),
                h('div', { key: 'm', className: 'sl-muted' }, '侧栏入口 + 网络主面板 + Family Space 授权 + 生络伙伴 preset'),
              ]),
            ]),
          ])
        }
        return h(TodayView, { data, approval })
      })()

      return h('div', { className: 'sl-root' }, [
        h('style', { key: 'css' }, CSS),
        h('aside', { key: 'nav', className: 'sl-nav' }, [
          h('div', { key: 'brand', className: 'sl-brand' }, [
            h('span', { key: 'm', className: 'sl-brand-mark', 'aria-hidden': 'true' }),
            h('span', { key: 't' }, '生络'),
          ]),
          h('nav', { key: 'n', 'aria-label': '生络导航' }, NAV.map((entry) => h('button', {
            key: entry.id,
            type: 'button',
            className: 'sl-nav-item' + (state.view === entry.id ? ' is-active' : ''),
            'aria-current': state.view === entry.id ? 'page' : undefined,
            onClick: () => store.set({ view: entry.id }),
          }, entry.label))),
          h('div', { key: 'reality', className: 'sl-nav-foot' }, [
            h('span', {
              key: 's',
              className: 'sl-nav-reality ' + (data?.reality?.state === 'authorized' ? 'is-ok' : 'is-unknown'),
            }, data?.reality?.state === 'authorized' ? '个人现实：已授权' : '个人现实：尚未授权'),
            h('span', { key: 'n', className: 'sl-nav-note' }, 'DSH 原生插件'),
          ]),
        ]),
        h('main', { key: 'main', className: 'sl-main' }, [body]),
        h('aside', { key: 'right', className: 'sl-right', 'aria-label': '当前这件事' },
          h(RightPanel, { data, approval })),
        state.toast ? h('div', { key: 'toast', className: 'sl-toast', role: 'status' }, state.toast) : null,
      ])
    }

    // ————————————————————————— 样式（只用宿主主题变量，深色浅色都跟着走） —————————————————————————

    const CSS = `
.sl-root{display:flex;flex:1;min-height:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55;overflow:hidden}
.sl-root *{box-sizing:border-box}
.sl-nav{width:176px;flex:0 0 176px;display:flex;flex-direction:column;gap:14px;padding:16px 12px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-layer-1));border-right:1px solid var(--dsw-alias-border-l1)}
.sl-brand{display:flex;align-items:center;gap:8px;font-weight:600;letter-spacing:.04em;padding:2px 6px}
.sl-brand-mark{width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.sl-nav nav{display:flex;flex-direction:column;gap:2px}
.sl-nav-item{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;padding:7px 10px;border-radius:8px;cursor:pointer}
.sl-nav-item:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sl-nav-item.is-active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.sl-nav-foot{margin-top:auto;display:flex;flex-direction:column;gap:4px;padding:8px 6px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.sl-nav-reality{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.sl-nav-reality.is-ok{color:var(--dsw-alias-state-success-primary)}
.sl-nav-reality.is-unknown{color:var(--dsw-alias-state-warn-primary)}
.sl-nav-note{font-size:11px;color:var(--dsw-alias-state-idle-primary)}
.sl-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.sl-stage{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:18px 20px 10px}
.sl-stage-list{padding:24px 28px}
.sl-h2{font-size:16px;font-weight:600;margin:0 0 14px}
.sl-h3{font-size:12px;font-weight:600;margin:0 0 8px;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}
.sl-center{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
.sl-map{position:relative;flex:0 0 auto;margin:0 auto}
.sl-map-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.sl-orbit{stroke:var(--dsw-alias-border-l1);stroke-dasharray:3 5;opacity:.8}
.sl-link{stroke:var(--dsw-alias-brand-primary);stroke-width:1.2;opacity:.42}
.sl-spoke{stroke:var(--dsw-alias-border-l2);stroke-width:1;opacity:.55}
.sl-core{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:none}
.sl-orb{position:relative;width:104px;height:104px;display:flex;align-items:center;justify-content:center;animation:sl-breathe 9s ease-in-out infinite}
.sl-orb-halo{position:absolute;inset:-6px;border-radius:50%;background:radial-gradient(circle at 50% 50%,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 20%,transparent) 0%,transparent 66%);filter:blur(3px)}
.sl-orb-core{position:absolute;inset:10px;border-radius:50%;background:radial-gradient(circle at 50% 47%,var(--dsw-alias-bg-base) 0%,var(--dsw-alias-bg-base) 31%,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 82%,transparent) 43%,color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent) 60%,transparent 76%);box-shadow:0 0 20px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 24%,transparent)}
.sl-orb-core::after{content:'';position:absolute;inset:26%;border-radius:50%;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 52%,transparent);opacity:.85;animation:sl-spin 26s linear infinite}
@keyframes sl-spin{to{transform:rotate(360deg)}}
.sl-orb-mark{position:relative;font-size:17px;line-height:1;color:var(--dsw-alias-label-primary);opacity:.95;letter-spacing:-.02em}
@keyframes sl-breathe{0%,100%{transform:scale(.975);opacity:.92}50%{transform:scale(1.03);opacity:1}}
@media (prefers-reduced-motion: reduce){.sl-orb{animation:none}.sl-orb-core::after{animation:none}}
.sl-core-text{display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center}
.sl-core-text strong{font-size:14px;letter-spacing:.12em}
.sl-core-text span{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:150px}
.sl-node-holder{position:absolute;transform:translate(-50%,-50%)}
.sl-node{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:6px 9px 6px 8px;border-radius:9px;cursor:pointer;max-width:150px;text-align:left;transition:border-color .15s,box-shadow .15s}
.sl-node:hover{border-color:var(--dsw-alias-border-l2);box-shadow:0 2px 10px rgba(0,0,0,.10)}
.sl-node.is-active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent)}
.sl-node-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.sl-node.tone-blue .sl-node-dot{background:var(--dsw-alias-brand-primary)}
.sl-node.tone-teal .sl-node-dot{background:var(--dsw-alias-state-success-primary)}
.sl-node.tone-amber .sl-node-dot{background:var(--dsw-alias-state-warn-primary)}
.sl-node.tone-rose .sl-node-dot{background:var(--dsw-alias-state-error-primary)}
.sl-node.tone-violet .sl-node-dot{background:var(--dsw-alias-brand-primary);opacity:.7}
.sl-node-label{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:132px}
.sl-node-kind{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.03em}
.sl-relations{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:5px;justify-content:center;max-width:600px}
.sl-relation{appearance:none;border:1px dashed var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px;padding:2px 8px;border-radius:999px;cursor:default;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sl-node-detail{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);max-width:520px;width:100%}
.sl-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.sl-hint{font-size:11px;color:var(--dsw-alias-state-idle-primary);text-align:center;margin:2px 0 0}
.sl-composer{padding:10px 0 2px;display:flex;flex-direction:column;gap:8px;max-width:760px;width:100%;margin:0 auto}
.sl-input-row{display:flex;gap:8px;align-items:center}
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
.sl-contract{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
.sl-contract-title{font-weight:600;margin-bottom:6px}
.sl-contract dl{display:grid;grid-template-columns:78px 1fr;gap:4px 10px;margin:0;font-size:12px}
.sl-contract dt{color:var(--dsw-alias-label-secondary)}
.sl-contract dd{margin:0}
.sl-right{width:320px;flex:0 0 320px;border-left:1px solid var(--dsw-alias-border-l1);overflow:auto;background:var(--dsw-alias-bg-base)}
.sl-right-inner{display:flex;flex-direction:column;gap:0;padding:16px 16px 24px}
.sl-block{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.sl-block:last-child{border-bottom:0}
.sl-focus{margin:0 0 4px;font-size:13.5px;font-weight:600}
.sl-strong{font-weight:600;margin:0 0 4px}
.sl-muted{color:var(--dsw-alias-label-secondary);margin:2px 0;font-size:12px}
.sl-bullets,.sl-sources,.sl-decisions{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:5px;font-size:12px}
.sl-bullets li,.sl-sources li,.sl-decisions li{color:var(--dsw-alias-label-secondary);position:relative;padding-left:11px}
.sl-bullets li::before,.sl-sources li::before,.sl-decisions li::before{content:'';position:absolute;left:0;top:7px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.sl-decisions li strong{display:block;color:var(--dsw-alias-label-primary)}
.sl-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 11px;margin-top:10px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:7px;align-items:flex-start}
.sl-card-title{font-weight:600;font-size:12.5px}
.sl-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:16px;letter-spacing:.14em;padding:5px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sl-scopes{list-style:none;margin:2px 0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.sl-scopes li{position:relative;padding-left:12px}
.sl-scopes li::before{content:'';position:absolute;left:0;top:6px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.sl-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.sl-approval{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:9px;padding:8px 10px;margin-top:8px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.sl-approval p{margin:0;font-size:12px;color:var(--dsw-alias-label-primary)}
.sl-approval-inline{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);margin:0;text-align:center}
.sl-error-note{font-size:11.5px;color:var(--dsw-alias-state-error-primary);margin:4px 0 0}
.sl-conversation{margin-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px;display:flex;flex-direction:column;gap:4px}
.sl-messages{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}
.sl-messages li{display:flex;gap:6px;font-size:11.5px;line-height:1.5}
.sl-who{flex:0 0 30px;color:var(--dsw-alias-label-secondary)}
.sl-msg-text{flex:1;min-width:0;white-space:pre-wrap;word-break:break-word}
.sl-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.sl-list-item{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:3px;background:var(--dsw-alias-bg-layer-1)}
.sl-error{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.sl-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 14px;font-size:12px;box-shadow:0 6px 22px rgba(0,0,0,.18);z-index:5;max-width:70%}
`

    // ————————————————————————— 注册 —————————————————————————

    function apply(ctx) {
      ctxRef = ctx

      ctx.effect(() => ctx.locale.register(NS, {
        zh: {
          panel: '生络',
          today: '今天',
          projects: '项目',
          artifacts: '成果',
          knowledge: '知识',
          plugins: '插件',
        },
        en: {
          panel: 'ShengLuo',
          today: 'Today',
          projects: 'Projects',
          artifacts: 'Artifacts',
          knowledge: 'Knowledge',
          plugins: 'Plugins',
        },
      }), 'shengluo: locale')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: -100,
        label: () => '生络',
        locale: NS,
      }, PanelIcon)), 'shengluo: sidebar entry')

      ctx.effect(() => ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, ShengluoPanel)
      }), 'shengluo: main panel')

      ctx.effect(() => () => {
        if (eventSource) { try { eventSource.close() } catch {} eventSource = null }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
        attached = false
        stopDevicePolling()
      }, 'shengluo: client resources')
    }

    return { inject: ['slots', 'locale', 'layout', 'sessions', 'uiWorkspace'], apply }
  },
})
