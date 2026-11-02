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

const USAGE = 'Usage: /context (no arguments)'

/** compaction-basic 的默认策略常量，只用于压缩触发点这一行。 */
const DEFAULT_THRESHOLD_RATIO = 0.8
const DEFAULT_HEADROOM_TOKENS = 65536

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
 */
function summariseNodes(session, nodes) {
  const totals = new Map()
  for (const node of nodes) {
    const event = session.eventAt(node.seq)
    const key = event ? classifyNode(event) : 'unclassified'
    totals.set(key, (totals.get(key) ?? 0) + node.tokens)
  }
  return totals
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
  // 节点合计就是 surfaceTokens（token-meter 的契约）；工具定义不是表面节点，
  // 单独取 token-meter 的 contextBreakdown.toolsTokens。有它时分母改成
  // 「节点合计 + 工具定义」，整张表仍然只用一个分母。
  const totals = summariseNodes(session, measurement.nodes)
  const rows = CATEGORY_ORDER.filter((key) => (totals.get(key) ?? 0) > 0).map((key) => ({
    label: CATEGORY_LABELS[key],
    tokens: totals.get(key),
  }))

  const toolsTokens =
    Number.isFinite(options.toolsTokens) && options.toolsTokens > 0 ? options.toolsTokens : 0
  if (toolsTokens > 0) rows.push({ label: 'Tool definitions', tokens: toolsTokens })

  if (rows.length > 0) {
    const denominator = surface + toolsTokens
    const share = denominator > 0 ? denominator : 1
    lines.push('')
    lines.push(`By category (sum ${formatTokens(denominator)} tokens)`)
    const labelWidth = Math.max(...rows.map((row) => row.label.length))
    const tokenWidth = Math.max(...rows.map((row) => formatTokens(row.tokens).length))
    for (const row of rows) {
      lines.push(
        `  ${row.label.padEnd(labelWidth)}  ${formatTokens(row.tokens).padStart(tokenWidth)}  (${formatPercent(row.tokens / share)})`,
      )
    }
  }

  // ── 压缩触发点（参考行）──────────────────────────────────────────────
  // 说的是「按 compaction-basic 默认策略，压力到哪里会触发压缩」，
  // 不断言「你的自动压缩已启用」——后端是否挂载、preset 是否改过策略都不由这里断言。
  const outputCap = header?.config?.maxTokens ?? 0
  if (capacity) {
    const trigger = Math.min(
      Math.floor(capacity * DEFAULT_THRESHOLD_RATIO),
      capacity - outputCap - DEFAULT_HEADROOM_TOKENS,
    )
    if (trigger > 0) {
      const headroom = trigger - pressure
      lines.push('')
      lines.push(
        headroom > 0
          ? `Compaction trigger: ~${formatTokens(trigger)} tokens (${formatPercent(trigger / capacity)}), ${formatTokens(headroom)} headroom`
          : `Compaction trigger passed: ~${formatTokens(trigger)} tokens (${formatPercent(trigger / capacity)})`,
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

/** 执行一次 `/context`：只读测量，永不改动会话。 */
function executeContext(ctx, invocation) {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }

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

  return {
    kind: 'success',
    text: buildReport(session, measurement, { toolsTokens: readToolsTokens(ctx, session) }),
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
        handler: (invocation) => executeContext(ctx, invocation),
      }),
    'command-context registration',
  )
}
