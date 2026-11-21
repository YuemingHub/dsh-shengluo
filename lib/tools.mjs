/**
 * 生络 — 给主 Agent 的工具。
 *
 * 每次操作只实现一遍（Host 服务方法），UI 走 /sl/api 同名入口，Agent 走这里的工具，
 * 两条路调的是同一段代码（references/user-actions.md）。
 *
 * 授予或确认权限的动作（连接家庭空间、撤销授权、批准工具调用、打开本地文件）
 * 只留给用户，不注册成工具 —— Agent 不能替本人授权，也不能替本人批准。
 */

const textBlock = (value) => [{ type: 'text', text: value }]

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: true,
})

const factStatusLabel = {
  owner_said: '你亲口说的',
  fact: '有依据的陈述',
  inference: '家明归纳的暂定理解',
  unknown: '未知',
}

function renderReality(value) {
  if (!value?.ok) {
    return textBlock([
      '个人现实读不到：' + (value?.detail ?? '未知原因'),
      value?.state === 'unauthorized'
        ? '家庭空间尚未授权。不要把这里当成「没有相关经历」——现在是未知。需要时请让本人在生络面板里连接家庭空间。'
        : '',
    ].filter(Boolean).join('\n'))
  }
  if (!value.results?.length) {
    const unknown = value.unknowns?.[0]?.message
    return textBlock((unknown ? unknown + '\n' : '') + '这次范围内没有查到相关个人现实。没有不等于不存在，只是这次没有匹配到。')
  }
  const lines = value.results.map((fact, index) => {
    const meta = [
      fact.statusLabel || factStatusLabel[fact.factStatus] || '未知状态',
      fact.time?.eventTime ? '事件时间 ' + fact.time.eventTime : '',
      fact.source?.label ?? '',
    ].filter(Boolean).join(' · ')
    const sources = (fact.evidence ?? []).filter((item) => item.conversationId)
    return [
      (index + 1) + '. ' + fact.statement,
      '   [' + meta + ']',
      fact.id ? '   memory_id: ' + fact.id : '',
      fact.basis ? '   依据：' + fact.basis : '',
      fact.verbatimQuote ? '   （与你保存的原话逐字一致）' : '',
      sources.length ? '   conversation_id: ' + sources[0].conversationId : '',
    ].filter(Boolean).join('\n')
  })
  const conversations = (value.conversations ?? []).filter((item) => item.messages?.length > 0)
  return textBlock([
    '个人现实（只读，来自家庭空间，仅限本人有权访问的部分）：',
    ...lines,
    conversations.length
      ? '\n相关对话片段（逐字，未改写）：\n' + conversations.slice(0, 3).map((item) =>
          '· ' + (item.title ?? item.id) + '\n' +
          item.messages.slice(0, 8).map((message) => '  [' + (message.at ? String(message.at).slice(0, 16).replace('T', ' ') : '时间未知') + '] '
            + (message.speakerRef === 'self' ? '本人' : message.speakerRef === 'ai' ? '家明' : '未知') + '：' + message.text).join('\n'),
        ).join('\n')
      : '',
  ].filter(Boolean).join('\n'))
}

function renderConversation(value) {
  if (!value?.ok) return textBlock('这段对话证据读不到：' + (value?.detail ?? '未知原因'))
  const conversation = value.conversation
  const lines = conversation.messages.slice(0, 60).map((message) => {
    const who = message.speakerRef === 'self' ? '本人' : message.speakerRef === 'child' ? '孩子' : (message.speakerRef || '未知')
    return '[' + (message.at ? String(message.at).slice(0, 16).replace('T', ' ') : '时间未知') + '] ' + who + '：' + message.text
  })
  return textBlock([
    '对话证据：' + (conversation.title ?? conversation.id)
      + (conversation.startedAt ? '（' + String(conversation.startedAt).slice(0, 10) + '）' : ''),
    '逐字原文，未改写：',
    ...lines,
    conversation.limits?.truncated ? '（对话被截断）' : '',
  ].filter(Boolean).join('\n'))
}

/**
 * @param {object} deps
 * @param {import('./reality.mjs').RealityProjection} deps.reality
 * @param {{ build: Function, store: object }} deps.network
 */
export function registerTools(ctx, { reality, network, logger }) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'shengluo_reality',
    description: [
      '按当前任务检索这个人的个人现实（他自己有权访问的部分）。',
      '返回的每条都带事实状态（他亲口说的 / 有证据的事实 / 推测 / 未知）、来源、事件时间和稳定 id。',
      '未授权时会明确返回未授权：那时个人现实是未知，不是空的，不要猜。',
      '只读，不会写入或修改家庭空间里的任何数据。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要推进的事情，用这个人的原话或你现在的理解，1..2000 字。' },
        max_items: { type: 'integer', description: '最多要几条，1..50，默认 10。' },
        fact_status: {
          type: 'array',
          items: { type: 'string', enum: ['owner_said', 'fact', 'inference', 'unknown'] },
          description: '只看这些事实状态；不传＝全部。',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema({
        ok: { type: 'boolean' },
        state: { type: 'string' },
        detail: { type: 'string' },
        code: { type: 'string' },
        results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        limits: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => renderReality(value),
    },
    async execute(args) {
      const filters = {}
      if (Number.isFinite(args?.max_items)) filters.max_items = args.max_items
      if (Array.isArray(args?.fact_status) && args.fact_status.length > 0) filters.fact_status = args.fact_status
      return reality.query({ task: args?.task, filters })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'shengluo_conversation',
    description: [
      '读一段家庭对话的逐字原文，用来核对个人现实里某条结论的原始证据。',
      '只有这个人的令牌有权访问的对话能读到；别人的私人对话永远读不到（会返回打不开）。',
      '只读，逐字返回，不摘要、不改写。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '来自 shengluo_reality 结果的 source.conversation_id。' },
        max_messages: { type: 'integer', description: '最多几条消息，1..500，默认 200。' },
      },
      required: ['conversation_id'],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema({
        ok: { type: 'boolean' },
        detail: { type: 'string' },
        code: { type: 'string' },
        conversation: { type: 'object', additionalProperties: true },
      }),
      render: (_args, value) => renderConversation(value),
    },
    async execute(args) {
      return reality.readConversation(args?.conversation_id, { maxMessages: args?.max_messages })
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'shengluo_network',
    description: [
      '读生络网络：当前这件事相关的真实节点和它们之间用普通人语言写的关系。',
      '节点来自真实项目、原生会话、工作区成果、个人现实、知识与待决定的事项。',
      '用来在回答里说明「我依据什么」「下一步是什么」，不要用它编造关系。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        include_hidden: { type: 'boolean', description: '是否也返回默认不显示的节点，默认 false。' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: objectSchema({
        ok: { type: 'boolean' },
        focus: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
        edges: { type: 'array', items: { type: 'object', additionalProperties: true } },
        hiddenCount: { type: 'integer' },
        realityState: { type: 'string' },
      }),
      render: (_args, value) => {
        if (!value?.ok) return textBlock('网络读不到：' + (value?.detail ?? '未知原因'))
        const lines = value.nodes.map((node) => '- [' + node.kind + '] ' + node.title + (node.subtitle ? ' —— ' + node.subtitle : ''))
        const relations = value.edges.map((edge) => '- ' + edge.label)
        return textBlock([
          '当前这件事：' + (value.focus ?? '还没有明确目标'),
          '与你有关的真实节点（' + value.nodes.length + ' 个，另有 ' + (value.hiddenCount ?? 0) + ' 个收在详情里）：',
          ...lines,
          relations.length ? '它们之间的关系：' : '',
          ...relations,
          '个人现实状态：' + (value.realityState === 'authorized' ? '已授权' : '未授权（未知）'),
        ].filter(Boolean).join('\n'))
      },
    },
    async execute(args, exec) {
      const snapshot = await network.snapshot({ includeHidden: args?.include_hidden === true })
      return { ok: true, ...snapshot, agentSessionId: exec?.agent?.id ?? null }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch (error) { logger?.warn?.('shengluo: tool disposer failed: ' + String(error?.message ?? error)) }
    }
  }
}
