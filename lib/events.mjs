/**
 * 生络 — 原生会话事件 → run 记录的纯归约。
 *
 * 只做三件事：
 * 1) 把 tool/call 与 tool/result 按 callId 配对成真实步骤（调用 ≠ 成功）；
 * 2) 从 assistant/message 里解析「结构化理解块」（没有就是不补模板）；
 * 3) 把 turn/end 变成「待验收」，而不是直接宣布完成。
 *
 * 不 import DSH：输入是 event 对象，输出是 run 补丁 + 要给 UI 的广播。
 */

const MAX_STEPS = 60
const MAX_RESULT_SUMMARY = 220

/**
 * 这些工具的输出正文属于本人现实/家庭对话：摘要也不许落进本地记录
 * （store 只存产品层索引，不复制现实正文——验收 14）。
 */
const SENSITIVE_RESULT_TOOLS = new Set(['shengluo_reality', 'shengluo_conversation'])

/** 工具名 → 工作阶段（只用于阶段提示，不代表成功）。 */
export const TOOL_PHASE = new Map([
  ['shengluo_reality', 'gathering'],
  ['shengluo_conversation', 'gathering'],
  ['shengluo_knowledge', 'gathering'],
  ['shengluo_network', 'judging'],
  ['read', 'gathering'],
  ['fs_search', 'gathering'],
  ['web_search', 'gathering'],
  ['web_fetch', 'gathering'],
  ['write', 'executing'],
  ['edit', 'executing'],
  ['bash', 'executing'],
  ['pwsh', 'executing'],
])

export const ACTION_VALUES = new Set(['answer', 'plan', 'execute', 'ask'])

const UNDERSTANDING_FENCE = /```shengluo:understanding\s*\r?\n([\s\S]*?)```/g

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clip(value, max = MAX_RESULT_SUMMARY) {
  const s = text(value).replace(/\s+/g, ' ')
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** 从 ToolResultMessage 里取一段人类可读摘要（不改写语义）。 */
export function summarizeToolResult(message) {
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  const pieces = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && text(block.text)) pieces.push(text(block.text))
  }
  return clip(pieces.join(' '))
}

/**
 * 解析结构化理解块。返回：
 *   { kind: 'none' }                      没有块
 *   { kind: 'ok', value }                 合法
 *   { kind: 'invalid', reason }           有块但不可用
 */
export function parseUnderstanding(rawText) {
  const source = typeof rawText === 'string' ? rawText : ''
  const blocks = [...source.matchAll(UNDERSTANDING_FENCE)]
  if (blocks.length === 0) return { kind: 'none' }
  const body = blocks[blocks.length - 1][1]
  let value
  try {
    value = JSON.parse(body)
  } catch (error) {
    return { kind: 'invalid', reason: 'JSON 解析失败：' + text(error && error.message) }
  }
  if (!value || typeof value !== 'object') return { kind: 'invalid', reason: '不是对象' }
  const headline = text(value.headline)
  if (!headline) return { kind: 'invalid', reason: '缺少 headline' }
  const list = (key) => {
    const raw = value[key]
    if (raw === undefined || raw === null) return []
    if (!Array.isArray(raw)) return null
    return raw.map((item) => text(item)).filter(Boolean)
  }
  const known = list('known')
  const inference = list('inference')
  const unknown = list('unknown')
  if (known === null || inference === null || unknown === null) {
    return { kind: 'invalid', reason: 'known/inference/unknown 必须是字符串数组' }
  }
  const action = text(value.action) || 'answer'
  if (!ACTION_VALUES.has(action)) return { kind: 'invalid', reason: '未知 action：' + action }
  return {
    kind: 'ok',
    value: {
      headline,
      known,
      inference,
      unknown,
      next: text(value.next),
      action,
    },
  }
}

/** 从 assistant/message 的 message 里拿纯文本（只取 text 块）。 */
export function assistantText(message) {
  if (!message || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function findOpenStep(steps, callId) {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step && step.callId === callId && step.status === 'running') return i
  }
  return -1
}

/**
 * 归约一个 session/event。
 * @param {object} run     当前 run 记录（只读，不修改原对象）
 * @param {object} event   SessionEvent 信封 { type, seq, time, data }
 * @param {object} [hints] { summarizeCall(name, args) } 可选，默认用简单人话
 * @returns {{ patch: object, broadcasts: Array<{type:string,payload:object}>, finalize: null|{reason:object} }}
 */
export function reduceSessionEvent(run, event, hints = {}) {
  const patch = {}
  const broadcasts = []
  const steps = Array.isArray(run?.steps) ? run.steps.slice() : []
  const data = event && event.data && typeof event.data === 'object' ? event.data : {}
  const type = text(event && event.type)

  if (type === 'user/message') {
    patch.phase = 'understanding'
    return { patch, broadcasts, finalize: null }
  }

  if (type === 'tool/call') {
    const callId = text(data.callId)
    const name = text(data.name) || 'tool'
    let summary = { verb: '使用工具', target: name }
    if (typeof hints.summarizeCall === 'function') {
      try { summary = hints.summarizeCall(name, text(data.arguments)) || summary } catch { /* 摘要失败不影响归约 */ }
    }
    const step = {
      callId: callId || 'call-' + String(event.seq ?? steps.length),
      name,
      verb: text(summary.verb) || '使用工具',
      target: clip(summary.target ?? name, 120),
      turn: Number(data.turn) || null,
      step: Number(data.step) || null,
      startedAt: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString(),
      endedAt: null,
      status: 'running',
      error: null,
      resultSummary: '',
    }
    steps.push(step)
    patch.steps = steps.slice(-MAX_STEPS)
    patch.toolCalls = (run?.toolCalls ?? 0) + 1
    patch.phase = TOOL_PHASE.get(name) ?? 'executing'
    patch.lastActivity = { verb: step.verb, target: step.target }
    broadcasts.push({ type: 'run/step-start', payload: { step } })
    return { patch, broadcasts, finalize: null }
  }

  if (type === 'tool/result') {
    const message = data.message ?? {}
    const callId = text(message.source?.callId) || text(message.toolCallId) || text(message.callId) || text(data.callId)
    const failed = Boolean(data.error) || message.isError === true
    const index = findOpenStep(steps, callId)
    const endedAt = new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString()
    if (index < 0) {
      // 孤立 result（例如插件中途启用）：如实计数，但不伪造一个步骤。
      patch.orphanResults = (run?.orphanResults ?? 0) + 1
      return { patch, broadcasts, finalize: null }
    }
    const step = { ...steps[index] }
    step.status = failed ? 'failed' : 'ok'
    step.endedAt = endedAt
    step.error = failed ? (text(data.error?.message) || text(data.error?.code) || '工具返回错误') : null
    const sensitive = SENSITIVE_RESULT_TOOLS.has(step.name)
    step.resultSummary = failed || sensitive ? '' : summarizeToolResult(message)
    // 敏感工具只记「有结果、在原生会话里」，不把正文或摘要写进产品状态。
    step.resultSummaryHidden = sensitive ? true : undefined
    steps[index] = step
    patch.steps = steps.slice(-MAX_STEPS)
    patch.toolSucceeded = (run?.toolSucceeded ?? 0) + (failed ? 0 : 1)
    patch.toolFailed = (run?.toolFailed ?? 0) + (failed ? 1 : 0)
    broadcasts.push({ type: 'run/step-end', payload: { step } })
    return { patch, broadcasts, finalize: null }
  }

  if (type === 'assistant/message') {
    const content = assistantText(data.message)
    if (!content) return { patch, broadcasts, finalize: null }
    // 最终答复：每条 assistant 消息都更新，最后一条就是这次会话的真实最终答复。
    // 只留在内存（index.js 拦截，不写产品状态）——面板要能看到它，但正文不落盘。
    patch.finalReply = content.length > 6000 ? content.slice(0, 6000) + '…' : content
    patch.finalReplyAt = new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString()
    const parsed = parseUnderstanding(content)
    if (parsed.kind === 'ok') {
      patch.understanding = parsed.value
      patch.understandingCaptured = true
      patch.understandingSource = {
        at: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString(),
        turn: Number(data.turn) || null,
        step: Number(data.step) || null,
      }
      patch.understandingInvalid = null
      patch.understandingMissing = false
      patch.phase = 'judging'
      broadcasts.push({ type: 'run/understanding', payload: { understanding: parsed.value, source: patch.understandingSource } })
    } else if (parsed.kind === 'invalid') {
      patch.understandingInvalid = parsed.reason
      broadcasts.push({ type: 'run/understanding-invalid', payload: { reason: parsed.reason } })
    } else if (run?.understandingCaptured !== true && run?.understanding == null) {
      // 没有结构化块：只记「这次没有留下」，不拿模板顶上。
      patch.understandingMissing = true
    }
    return { patch, broadcasts, finalize: null }
  }

  if (type === 'approval/asked') {
    patch.phase = 'waiting-for-you'
    patch.pendingApproval = {
      id: text(data.id) || null,
      toolName: text(data.toolName) || null,
      reason: text(data.reason) || '这一步要你点了才会往下走。',
      at: new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString(),
    }
    return { patch, broadcasts, finalize: null }
  }

  if (type === 'approval/decided') {
    const outcome = text(data.outcome)
    const rejected = outcome === 'rejected'
    patch.pendingApproval = null
    patch.phase = rejected ? 'stopped-by-owner' : 'executing'
    if (rejected) {
      patch.approvalRejected = true
      patch.lastDecision = 'rejected'
      patch.note = '你拒绝了这一步，我没有继续做。'
    }
    broadcasts.push({ type: 'run/approval-decided', payload: { outcome } })
    return { patch, broadcasts, finalize: null }
  }

  if (type === 'turn/end') {
    const reason = data.reason && typeof data.reason === 'object' ? data.reason : { kind: 'completed' }
    patch.phase = 'verifying'
    return { patch, broadcasts, finalize: { reason } }
  }

  return { patch, broadcasts, finalize: null }
}
