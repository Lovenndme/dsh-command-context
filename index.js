/**
 * dsh-command-context — Host half.
 *
 * 注册一个全局人类命令 `/context`：报告当前会话的上下文窗口占用。
 *
 * 数据全部来自 Harness 已有的、文档化的只读接口，不重新发明统计口径：
 *   · `ctx.tokenMeter.measure(session)`  → 压力/表面 token（回放会话日志折叠得出，
 *     无模型调用；能复用上一次 provider usage 时用实测值）
 *   · `session.requestContext()`         → 当前路由的 provider / model / contextWindow
 *   · `session.requestHeader()`          → 本轮请求的 maxTokens（压缩触发点要用）
 *   · `session.eventAt(seq)`             → 取每个表面节点的事件，用来分类
 *
 * 分类是**按节点**算的，不是按文本长度估的：每个表面节点都带自己的 token 价，
 * 只要判定这个节点属于哪一类即可。实测结构（2026-10-31）：
 *   · system/message  → 系统提示（单块 text）
 *   · developer/message → 运行时注入
 *   · user/message    → 有两种：真实用户输入，以及「整条都是 <system-reminder>」的
 *                       注入消息——AGENTS.md 工作区指令是一条，skills 目录是另一条。
 *                       这两类必须从「用户消息」里拆出来，否则用户消息被虚高。
 *   · assistant/message → 助手回复
 *   · tool/result     → 工具结果
 *
 * 占用率口径与 `@deepseek-ai/dsh-token-meter` README 一致：
 *   占用率 = measure().totalTokens ÷ 该路由的模型上下文容量
 *
 * 输出刻意保持纯 ASCII + 英文：
 *   · 命令结果的正文渲染在 <pre> 里，CJK 与 `█░` 这类块字符在其中的字宽/行高不可控，
 *     会和相邻行挤在一起（实测过）。ASCII 在等宽字体下宽度恒为 1，排版才可靠。
 *   · 正文只放数字，不放解释性文案——解释留在 README。
 *
 * 只读：不写会话日志、不触发模型调用、不改变任何会话状态。
 * 命令生命周期（command/run、command/done）由命令注册表自己记录。
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-command-context'

/** 三个服务都是硬依赖：任一缺失时让插件加载失败，而不是默默降级显示错数字。 */
export const inject = ['commands', 'sessions', 'tokenMeter']

/**
 * 装载戳：仅在设置了 DSH_CONTEXT_LOAD_STAMP 环境变量时才写。
 *
 * 这个插件装进 profile 后挂在 node_modules 下，而 HMR 的默认 ignored 会把
 * node_modules 下的路径排除，所以改源码不会热更——开发时要靠「换模块代次 + 看戳」
 * 才分得清跑的是哪一代。默认关闭：普通使用者不该被插件往 home 目录写文件。
 */
const LOAD_STAMP = path.join(homedir(), '.dsh', 'tmp', 'dsh-command-context.loads.log')

function stampLoad() {
  if (!process.env.DSH_CONTEXT_LOAD_STAMP) return
  try {
    appendFileSync(LOAD_STAMP, `${new Date().toISOString()} rev=4\n`)
  } catch {
    // 诊断设施，写不进去不影响命令本身
  }
}

const USAGE = 'Usage: /context [top] [N]'

/** compaction-basic 的默认策略常量：读不到真实策略时才用，并在行上标注。 */
const DEFAULT_THRESHOLD_RATIO = 0.8
const DEFAULT_HEADROOM_TOKENS = 65536

/** `/context top` 的默认条数与上限。 */
const DEFAULT_TOP_COUNT = 5
const MAX_TOP_COUNT = 20

/** 进度条内部格数（ASCII，不含两端的方括号）。 */
const BAR_CELLS = 20

/* ------------------------------------------------------------------ 格式化 */

function formatTokens(value) {
  if (!Number.isFinite(value)) return '-'
  const n = Math.max(0, value)
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatPercent(ratio) {
  if (!Number.isFinite(ratio)) return '-'
  return `${(Math.max(0, ratio) * 100).toFixed(1)}%`
}

/** 把 0..1 的比例画成一条 ASCII 进度条。 */
function renderBar(ratio) {
  const clamped = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
  const filled = Math.round(clamped * BAR_CELLS)
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_CELLS - filled)}]`
}

/* ------------------------------------------------------------------ 分类 */

/**
 * 类别标签与输出顺序。顺序按「离用户输入越远越靠前」排，
 * 和 Claude Code 的 /context 观感一致。
 */
const CATEGORY_ORDER = [
  'system',
  'memory',
  'skills',
  'injected',
  'user',
  'assistant',
  'tool',
  'unclassified',
]

const CATEGORY_LABELS = {
  system: 'System prompt',
  memory: 'Memory files',
  skills: 'Skills',
  injected: 'Injected context',
  user: 'User messages',
  assistant: 'Assistant replies',
  tool: 'Tool results',
  unclassified: 'Unclassified nodes',
}

/**
 * MCP 工具的名字带 `mcp__<server>__<tool>` 前缀，这是区分「内置工具」与「MCP 提供
 * 的工具」唯一可靠的依据——不依赖某个具体 server 的配置。
 */
const MCP_TOOL_PREFIX = 'mcp__'

function isMcpTool(name) {
  return typeof name === 'string' && name.startsWith(MCP_TOOL_PREFIX)
}

/** 事件里的消息：`user/message` 的 data 本身就是消息，其余藏一层 `message`。 */
function messageOf(event) {
  return event.type === 'user/message' ? event.data : event.data?.message
}

/** 取一条消息里的文本块（trim 后非空的）。 */
function textBlocks(event) {
  const content = messageOf(event)?.content
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .filter((text) => text.trim().length > 0)
}

/**
 * 判定「整条消息都是 <system-reminder> 注入」的那类 user/message 属于哪一类。
 *
 * 只要有一条块不是 reminder 开头，就算真实用户输入——宁可少拆，不把用户自己
 * 写的内容错算成注入。
 */
function classifyReminder(joined) {
  if (/skills are available|<available_skills>/.test(joined)) return 'skills'
  if (/workspace instructions|Instructions from:|memory root:/.test(joined)) return 'memory'
  return 'injected'
}

function classifyNode(event) {
  switch (event.type) {
    case 'system/message':
      return 'system'
    case 'developer/message':
      return 'injected'
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'tool'
    case 'user/message': {
      const texts = textBlocks(event)
      if (texts.length === 0) return 'user'
      const allReminders = texts.every((text) => text.trimStart().startsWith('<system-reminder>'))
      return allReminders ? classifyReminder(texts.join('\n')) : 'user'
    }
    default:
      return 'unclassified'
  }
}

/**
 * 把 `measure().nodes` 按类别聚合。
 *
 * 节点只出现在会话表面的节点 seq 上，所以 `eventAt(seq)` 必然拿得到事件；
 * 拿不到时归入 unclassified（理论上不会发生，出现即说明表面与日志不一致）。
 *
 * 工具结果再按来源分一次：由 MCP 工具产生的单独记 'mcp'，和内置工具分开算。
 * 分类依据是 callId → 工具名（`mcp__` 前缀），所以需要调用方把名字表传进来。
 */
function summariseNodes(session, nodes, toolNames = new Map()) {
  const totals = new Map()
  for (const node of nodes) {
    const event = session.eventAt(node.seq)
    let key = event ? classifyNode(event) : 'unclassified'
    if (key === 'tool') {
      const callId = event.data?.message?.source?.callId
      const name = callId !== undefined ? toolNames.get(callId) : undefined
      if (isMcpTool(name)) key = 'mcp'
    }
    totals.set(key, (totals.get(key) ?? 0) + node.tokens)
  }
  return totals
}

/**
 * 把「工具定义」按 MCP / 内置拆开。
 *
 * 手上只有 `contextBreakdown.toolsTokens` 一个总数，没有逐工具的实测价，所以按
 * **声明体积占比**（`JSON.stringify(schema).length`）去分配这个总数：总量仍是那个
 * 可信的数，拆分只是按比例分摊，不另造一个刻度。
 */
function splitToolDefinitions(session, toolsTokens) {
  const tools = session.requestHeader()?.tools
  if (!(toolsTokens > 0) || !Array.isArray(tools) || tools.length === 0) {
    return { mcp: 0, rest: toolsTokens }
  }

  let mcpSize = 0
  let totalSize = 0
  for (const tool of tools) {
    let size = 0
    try {
      size = JSON.stringify(tool).length
    } catch {
      size = 0
    }
    totalSize += size
    if (isMcpTool(tool?.name)) mcpSize += size
  }

  if (totalSize === 0) return { mcp: 0, rest: toolsTokens }
  const mcp = Math.round((toolsTokens * mcpSize) / totalSize)
  return { mcp, rest: toolsTokens - mcp }
}

/* ------------------------------------------------------------------ 报告 */

/**
 * 由一次测量结果拼出整份报告文本。
 *
 * 纯函数（除了只读的 `session` 查询），便于离线用合成数据验证格式。
 */
export function buildReport(session, measurement, options = {}) {
  const context = session.requestContext()
  const header = session.requestHeader()
  const model = context?.model ?? header?.config?.model ?? 'unknown model'
  const provider = context?.provider
  const capacity = Number.isFinite(context?.contextWindow) ? context.contextWindow : undefined

  const pressure = measurement.totalTokens
  const surface = measurement.surfaceTokens
  // 主数字的可信度标签：provider 实测 vs 字符启发式。
  const accuracy = measurement.baseline.kind === 'usage' ? 'measured' : 'estimated'

  const lines = []

  // ── 抬头：模型 + 占用条 ──────────────────────────────────────────────
  lines.push(`Context: ${provider ? `${model} (${provider})` : model}`)

  const ratio = capacity ? pressure / capacity : NaN
  if (capacity) {
    lines.push(
      `${renderBar(ratio)}  ${formatTokens(pressure)} / ${formatTokens(capacity)} tokens (${formatPercent(ratio)})  ${accuracy}`,
    )
    const free = Math.max(0, capacity - pressure)
    lines.push(`Free space: ${formatTokens(free)} tokens (${formatPercent(free / capacity)})`)
  } else {
    lines.push(`  used ${formatTokens(pressure)} tokens  ${accuracy}`)
    lines.push('Context window unknown: this session has no request/context record yet.')
  }

  // ── 分类明细 ────────────────────────────────────────────────────────
  // 节点合计是 surfaceTokens（token-meter 的契约）；工具定义不是表面节点，
  // 单独取 token-meter 的 contextBreakdown.toolsTokens。
  //
  // 整张表只用一个分母：**provider 侧的总压力**。两套口径（实测压力 vs 逐消息
  // 路由定价）解释不掉的差额，落到 Unaccounted 行里如实暴露，而不是让读者自己
  // 去减——那样每个人算出来的都不一样，也没人知道差的是什么。
  const toolNames = collectToolNames(session)
  const totals = summariseNodes(session, measurement.nodes, toolNames)
  const rows = CATEGORY_ORDER.filter((key) => (totals.get(key) ?? 0) > 0).map((key) => ({
    label: CATEGORY_LABELS[key],
    tokens: totals.get(key),
  }))

  const toolsTokens =
    Number.isFinite(options.toolsTokens) && options.toolsTokens > 0 ? options.toolsTokens : 0
  const toolSplit = splitToolDefinitions(session, toolsTokens)
  if (toolSplit.rest > 0) rows.push({ label: 'Tool definitions', tokens: toolSplit.rest })

  // MCP 单独一类：它的工具结果（按节点定价）+ 它在工具定义里占的那一份（按声明体积分摊）。
  const mcpTotal = (totals.get('mcp') ?? 0) + toolSplit.mcp
  if (mcpTotal > 0) rows.push({ label: 'MCP', tokens: mcpTotal })

  if (rows.length > 0) {
    const itemized = rows.reduce((sum, row) => sum + row.tokens, 0)
    const denominator = Math.max(pressure, itemized)
    const unaccounted = denominator - itemized
    if (unaccounted > 0) rows.push({ label: 'Unaccounted', tokens: unaccounted })

    lines.push('')
    lines.push(`By category (of ${formatTokens(denominator)} tokens)`)
    const labelWidth = Math.max(...rows.map((row) => row.label.length))
    const tokenWidth = Math.max(...rows.map((row) => formatTokens(row.tokens).length))
    const share = denominator > 0 ? denominator : 1
    for (const row of rows) {
      lines.push(
        `  ${row.label.padEnd(labelWidth)}  ${formatTokens(row.tokens).padStart(tokenWidth)}  (${formatPercent(row.tokens / share)})`,
      )
    }
  }

  // ── 压缩触发点（参考行）──────────────────────────────────────────────
  // 只有真的找得到压实后端时才谈阈值：读得到它的策略就用真实的，读不到才回落到
  // 默认值并在行上标 (default policy)。没有后端就不显示——不报一个不存在的阈值。
  const outputCap = header?.config?.maxTokens ?? 0
  if (capacity && options.compaction) {
    const policy = options.compactionPolicy ?? {}
    const usesDefaults =
      !Number.isFinite(policy.thresholdRatio) || !Number.isFinite(policy.headroomTokens)
    const ratioTarget = Number.isFinite(policy.thresholdRatio)
      ? policy.thresholdRatio
      : DEFAULT_THRESHOLD_RATIO
    const headroomTokens = Number.isFinite(policy.headroomTokens)
      ? policy.headroomTokens
      : DEFAULT_HEADROOM_TOKENS

    const trigger = Math.min(
      Math.floor(capacity * ratioTarget),
      capacity - outputCap - headroomTokens,
    )
    if (trigger > 0) {
      const label = `Compaction trigger${usesDefaults ? ' (default policy)' : ''}`
      const headroom = trigger - pressure
      lines.push('')
      lines.push(
        headroom > 0
          ? `${label}: ~${formatTokens(trigger)} tokens (${formatPercent(trigger / capacity)}), ${formatTokens(headroom)} headroom`
          : `${label} passed: ~${formatTokens(trigger)} tokens (${formatPercent(trigger / capacity)})`,
      )
    }
  }

  return lines.join('\n')
}

/* ------------------------------------------------------------------ 命令 */

/**
 * 取工具定义（tool schema）占多少 token。
 *
 * 来源是 `tokenMeter` 注册的 `contextBreakdown` 投影——文档明确它有
 * `systemTokens` / `toolsTokens` / `messageTokens`，且 `toolsTokens` 跟随最新的
 * `request/header`。这是唯一"和 harness 同口径"的来源；自己按字符数估一个数
 * 只会得到另一套刻度，所以投影读不到时就返回 undefined，报告里干脆不显示这一行。
 */
function readToolsTokens(ctx, session) {
  const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
  if (!projections || typeof projections.snapshot !== 'function') return undefined

  try {
    const snapshot = projections.snapshot(session, ['contextBreakdown'])
    const tokens = snapshot?.values?.contextBreakdown?.toolsTokens
    return Number.isFinite(tokens) && tokens > 0 ? tokens : undefined
  } catch {
    return undefined
  }
}

/** 非工具节点在「最大节点」里的固定 ASCII 标签（不打印正文，正文常常是中文）。 */
const NODE_LABELS = {
  'system/message': 'system',
  'developer/message': 'developer',
  'user/message': 'user',
  'assistant/message': 'assistant',
}

/**
 * 找压实后端。压实后端通常挂在 agent 作用域（宿主层往往是关的），所以要依次试：
 *   1. 本插件所在上下文 `ctx.get('compaction')`
 *   2. `agentPresets.serviceFor(agent, 'compaction')` —— 专为「从会话外拿某个 agent
 *      作用域里的服务」设计的入口
 *   3. `agent.ctx.get('compaction')` —— 运行期 agent 对象带 ctx 时的直取
 *
 * 三条都拿不到就返回 undefined，报告里对应的行整行不出现：不报一个不存在的阈值。
 */
function resolveCompaction(ctx, agent) {
  const attempts = []

  if (typeof ctx.get === 'function') {
    attempts.push(() => ctx.get('compaction'))
    const presets = ctx.get('agentPresets')
    if (presets && typeof presets.serviceFor === 'function') {
      attempts.push(() => presets.serviceFor(agent, 'compaction'))
    }
  }

  const agentCtx = agent && typeof agent === 'object' ? agent.ctx : undefined
  if (agentCtx && typeof agentCtx.get === 'function') {
    attempts.push(() => agentCtx.get('compaction'))
  }

  for (const attempt of attempts) {
    try {
      const service = attempt()
      if (service) return service
    } catch {
      // 这条路径不可达，试下一条
    }
  }
  return undefined
}

/** 读压实后端暴露的策略字段；读不到就返回空对象，由调用方回落到默认值并标注。 */
function readCompactionPolicy(service) {
  if (!service || typeof service !== 'object') return {}
  for (const candidate of [service.config, service.resolvedConfig, service.policy]) {
    if (candidate && typeof candidate === 'object') return candidate
  }
  return {}
}

/**
 * callId → 工具名。
 *
 * `tool/result` 只带 callId，工具名在对应的 `tool/call` 事件上，所以要扫一遍事件表。
 * 人类命令是一次性的，这次扫描相对一次 `measure()` 可忽略。
 */
function collectToolNames(session) {
  const names = new Map()
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return names
  }
  for (const event of events) {
    if (event?.type === 'tool/call' && typeof event.data?.name === 'string') {
      names.set(event.data.callId, event.data.name)
    }
  }
  return names
}

/**
 * 最大的若干个表面节点——「我的上下文到底被谁吃了」。
 *
 * 工具结果标工具名（read / grep / pwsh …），其它节点标角色名。刻意不打印消息正文：
 * 报告正文必须纯 ASCII，而用户与助手的正文常常是中文，塞进等宽列会把对齐打散。
 */
function buildLargestNodes(session, nodes, limit) {
  const toolNames = collectToolNames(session)
  const top = [...nodes]
    .filter((node) => Number.isFinite(node.tokens) && node.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit)

  if (top.length === 0) return 'Largest nodes: none'

  const rows = top.map((node) => {
    const event = session.eventAt(node.seq)
    const callId = event?.type === 'tool/result' ? event.data?.message?.source?.callId : undefined
    const label = (callId !== undefined ? toolNames.get(callId) : undefined) ?? NODE_LABELS[event?.type] ?? 'node'
    return { label, tokens: node.tokens, turn: event?.data?.turn }
  })

  const labelWidth = Math.max(...rows.map((row) => row.label.length))
  const tokenWidth = Math.max(...rows.map((row) => formatTokens(row.tokens).length))
  const lines = ['Largest nodes']
  for (const row of rows) {
    const turn = Number.isFinite(row.turn) ? `  turn ${row.turn}` : ''
    lines.push(
      `  ${row.label.padEnd(labelWidth)}  ${formatTokens(row.tokens).padStart(tokenWidth)}${turn}`,
    )
  }
  return lines.join('\n')
}

/**
 * 解析 `/context` 的参数。
 *
 *   空        → 只出报告
 *   `N`       → 报告 + 最大的 N 个节点（`top N` 的简写：`/context 3` 是人第一反应）
 *   `top`     → 报告 + 最大的 5 个节点
 *   `top N`   → 报告 + 最大的 N 个节点
 *
 * 其它一律 undefined（回 Usage）。数字必须是纯数字：`top 3x` 不该被 parseInt 吃掉尾巴。
 */
function parseRequest(rawInput) {
  const parts = rawInput.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { mode: 'report' }

  if (parts.length === 1 && /^\d+$/.test(parts[0])) {
    const limit = Number.parseInt(parts[0], 10)
    return limit > 0 ? { mode: 'top', limit: Math.min(limit, MAX_TOP_COUNT) } : undefined
  }

  if (parts[0] !== 'top') return undefined
  if (parts.length > 2) return undefined
  if (parts.length === 2 && !/^\d+$/.test(parts[1])) return undefined

  const limit = parts.length === 2 ? Number.parseInt(parts[1], 10) : DEFAULT_TOP_COUNT
  return limit > 0 ? { mode: 'top', limit: Math.min(limit, MAX_TOP_COUNT) } : undefined
}

/** 执行一次 `/context`：只读测量，永不改动会话。 */
function executeContext(ctx, invocation) {
  const request = parseRequest(invocation.rawInput)
  if (!request) return { kind: 'error', text: USAGE }

  const session = ctx.sessions.get(invocation.agent.id)
  if (!session) {
    return { kind: 'error', text: 'This session is not loaded in memory, so it cannot be measured.' }
  }

  let measurement
  try {
    measurement = ctx.tokenMeter.measure(session)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `Could not measure context usage: ${detail}` }
  }

  const compaction = resolveCompaction(ctx, invocation.agent)
  const report = buildReport(session, measurement, {
    toolsTokens: readToolsTokens(ctx, session),
    compaction,
    compactionPolicy: readCompactionPolicy(compaction),
  })

  return {
    kind: 'success',
    text:
      request.mode === 'top'
        ? `${report}\n\n${buildLargestNodes(session, measurement.nodes, request.limit)}`
        : report,
  }
}

/**
 * 注册 `/context`。
 * @param ctx 带命令注册表、会话存储和 token 计量的宿主上下文。
 */
export function apply(ctx) {
  stampLoad()
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'context',
        description: '查看当前会话的上下文窗口占用',
        // 必须声明 input：不声明的话，composer 会把 `/context 3` 当成普通提示词
        // 发给模型，而不是交给命令执行器（实测踩到：args 永远为空，消息落进 user/message）。
        input: { hint: '[top] [N]' },
        handler: (invocation) => executeContext(ctx, invocation),
      }),
    'command-context registration',
  )
}
