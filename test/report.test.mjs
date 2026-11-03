/**
 * 离线校验 /context 的分类、排版、语言、参数与算术。用合成数据，不碰任何真实会话。
 * 运行：node test/report.test.mjs
 *
 * 守的约定（都是真实踩过的）：
 *   · 「整条都是 <system-reminder>」的 user/message 要从用户消息里拆出来；
 *   · 分类之和必须等于表头那个分母（差额落到最后一行），否则读者会算出不同的数；
 *   · 列必须真的对齐 —— 中文按显示宽度（CJK 记 2 格）补齐，英文按码元；
 *   · 正文不放解释性文案；
 *   · 中英双语：默认中文，`en` 切英文，两套的算术必须完全一致。
 */
import assert from 'node:assert/strict'
import { apply, buildReport } from '../index.js'

/** 造一个事件：user/message 的 data 本身就是消息，其余藏一层 message。 */
function event(type, text, extra = {}) {
  const content = text === null ? [] : [{ type: 'text', text }]
  const base = type === 'user/message' ? { role: 'user', content } : { message: { content } }
  return { type, data: { ...base, ...extra } }
}

const REMINDER_MEMORY =
  '<system-reminder>\nThe following workspace instructions may be relevant.\n\nInstructions from: ~/.dsh/AGENTS.md\n</system-reminder>'
const REMINDER_SKILLS =
  '<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n<available_skills>...</available_skills>\n</system-reminder>'

const events = new Map([
  [1, event('system/message', 'You are an AI agent powered by DeepSeek Harness.', { turn: 0 })],
  [2, event('user/message', REMINDER_MEMORY, { turn: 1 })],
  [3, event('user/message', REMINDER_SKILLS, { turn: 1 })],
  [4, event('user/message', '请给这个仓库加一个 /context 命令', { turn: 1 })],
  [5, event('assistant/message', '好的，先看现有能力。', { turn: 1 })],
  [6, event('tool/call', null, { turn: 2, callId: 'c1', name: 'read', arguments: '{}' })],
  [
    7,
    event('tool/result', '{"content":"..."}', {
      turn: 2,
      message: { content: [{ type: 'text', text: '{"content":"..."}' }], source: { callId: 'c1' } },
    }),
  ],
])

const NODES = [
  { seq: 1, tokens: 12_400, heuristicTokens: 12_000 },
  { seq: 2, tokens: 1_500, heuristicTokens: 1_450 },
  { seq: 3, tokens: 1_500, heuristicTokens: 1_450 },
  { seq: 4, tokens: 3_200, heuristicTokens: 3_100 },
  { seq: 5, tokens: 8_100, heuristicTokens: 8_000 },
  { seq: 7, tokens: 153_300, heuristicTokens: 150_000 },
]

function fakeSession({ withContext = true, header = {}, eventMap = events } = {}) {
  return {
    requestContext: () =>
      withContext
        ? { provider: 'myapi', model: 'deepseek-v4.1-flash', contextWindow: 1_000_000 }
        : undefined,
    requestHeader: () => ({ config: { maxTokens: 32768 }, ...header }),
    eventAt: (seq) => eventMap.get(seq),
    snapshotEvents: () => [...eventMap.values()],
  }
}

const measurement = {
  logRevision: 42,
  baseline: { kind: 'usage', tokens: 150_000, usage: {} },
  surfaceDeltaTokens: 43_200,
  totalTokens: 193_200,
  surfaceTokens: 180_000,
  nodes: NODES,
}

assert.equal(
  NODES.reduce((sum, node) => sum + node.tokens, 0),
  measurement.surfaceTokens,
  'fixture: nodes must sum to surfaceTokens',
)

/** 显示宽度（CJK 记 2 格）。中文要对齐必须按这个算，不能按字符串下标。 */
function displayWidth(text) {
  let width = 0
  for (const char of text) {
    const code = char.codePointAt(0)
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    width += wide ? 2 : 1
  }
  return width
}

/** 各行括号必须落在同一显示列 —— 这是列对齐的硬指标。 */
function assertColumnsAlign(text) {
  const rows = text.split('\n').filter((line) => /^ {2}\S/.test(line) && line.includes('('))
  assert.ok(rows.length >= 3, 'expected several category rows')
  const columns = new Set(rows.map((line) => displayWidth(line.slice(0, line.indexOf('(')))))
  assert.equal(columns.size, 1, `category rows must share one column, got ${[...columns].join(', ')}`)
}

// ── 默认语言：中文 ────────────────────────────────────────────────────
const zh = buildReport(fakeSession(), measurement, { compaction: {} })
console.log(zh)
console.log('\n' + '─'.repeat(64) + '\n')
assert.match(zh, /^上下文占用: deepseek-v4\.1-flash \(myapi\)$/m)
assert.match(zh, /193\.2k \/ 1\.00M tokens \(19\.3%\) {2}实测/)
assert.match(zh, /剩余空间: 806\.8k tokens \(80\.7%\)/)
assert.match(zh, /按类别（合计 193\.2k tokens）/)
for (const label of ['系统提示', '记忆文件', '技能', '用户消息', '助手回复', '工具结果']) {
  assert.ok(zh.includes(label), `missing zh label: ${label}`)
}
assert.match(zh, /未计入差额 +13\.2k +\(6\.8%\)/)
assert.match(zh, /压缩触发点（默认策略）: ~800\.0k tokens \(80\.0%\), 606\.8k 余量/)
assertColumnsAlign(zh)

// ── 同一份数据，英文版算术必须完全一致 ────────────────────────────────
const en = buildReport(fakeSession(), measurement, { lang: 'en', compaction: {} })
console.log(en)
assert.match(en, /^Context: deepseek-v4\.1-flash \(myapi\)$/m)
assert.match(en, /193\.2k \/ 1\.00M tokens \(19\.3%\) {2}measured/)
assert.match(en, /By category \(of 193\.2k tokens\)/)
assert.match(en, /Unaccounted +13\.2k +\(6\.8%\)/)
assert.match(en, /Compaction trigger \(default policy\): ~800\.0k tokens \(80\.0%\), 606\.8k headroom/)
assertColumnsAlign(en)

const rowCount = (text) =>
  text.split('\n').filter((line) => /^ {2}\S/.test(line) && line.includes('(')).length
assert.equal(rowCount(zh), rowCount(en), 'both languages must list the same rows')

// ── 工具定义 / MCP ───────────────────────────────────────────────────
const withTools = buildReport(
  fakeSession(),
  { ...measurement, totalTokens: 340_000 },
  { lang: 'en', toolsTokens: 98_400, compaction: {} },
)
assert.match(withTools, /By category \(of 340\.0k tokens\)/)
assert.match(withTools, /Tool definitions +98\.4k +\(28\.9%\)/)
assert.match(withTools, /Unaccounted +61\.6k/)
assert.ok(withTools.indexOf('Tool results') < withTools.indexOf('Tool definitions'))

const mcpEvents = new Map(events)
mcpEvents.set(8, event('tool/call', null, { turn: 3, callId: 'c2', name: 'mcp__a__b', arguments: '{}' }))
mcpEvents.set(
  9,
  event('tool/result', 'x', {
    turn: 3,
    message: { content: [{ type: 'text', text: 'x' }], source: { callId: 'c2' } },
  }),
)
// 两个 schema 的 JSON 长度刻意相等 → MCP 占工具定义正好一半
const balancedTools = [
  { name: 'read', description: 'xxxxx', parameters: {} },
  { name: 'mcp__a__b', description: '', parameters: {} },
]
assert.equal(JSON.stringify(balancedTools[0]).length, JSON.stringify(balancedTools[1]).length)

const mcp = buildReport(
  fakeSession({ header: { tools: balancedTools }, eventMap: mcpEvents }),
  {
    ...measurement,
    totalTokens: 400_000,
    surfaceTokens: 200_000,
    nodes: [...NODES, { seq: 9, tokens: 20_000, heuristicTokens: 20_000 }],
  },
  { lang: 'en', toolsTokens: 98_400, compaction: {} },
)
console.log(mcp)
assert.match(mcp, /Tool results +153\.3k/)
assert.match(mcp, /Tool definitions +49\.2k/)
assert.match(mcp, /MCP +69\.2k/)
assert.match(mcp, /Unaccounted +101\.6k/)
assert.ok(mcp.indexOf('Tool definitions') < mcp.indexOf('MCP'))
assert.ok(!en.includes('MCP'), 'no MCP tools means no MCP row')

// ── 压缩触发点三态 ───────────────────────────────────────────────────
const tuned = buildReport(fakeSession(), measurement, {
  lang: 'en',
  compaction: {},
  compactionPolicy: { thresholdRatio: 0.7, headroomTokens: 65536 },
})
assert.match(tuned, /Compaction trigger: ~700\.0k tokens \(70\.0%\)/)
assert.ok(!tuned.includes('default policy'), 'readable policy must not be labelled as default')
assert.ok(!buildReport(fakeSession(), measurement, { lang: 'en' }).includes('Compaction trigger'))

const over = buildReport(
  fakeSession(),
  {
    ...measurement,
    totalTokens: 900_000,
    surfaceTokens: 890_000,
    nodes: [{ seq: 7, tokens: 890_000, heuristicTokens: 880_000 }],
  },
  { lang: 'en', compaction: {} },
)
assert.match(over, /Compaction trigger \(default policy\) passed/)

// ── 未知上下文上限 ──────────────────────────────────────────────────
const unknownZh = buildReport(
  fakeSession({ withContext: false }),
  { ...measurement, totalTokens: 0, surfaceTokens: 0, nodes: [] },
  { compaction: {} },
)
assert.ok(unknownZh.includes('上下文上限未知'))

const unknownEn = buildReport(
  fakeSession({ withContext: false }),
  { ...measurement, baseline: { kind: 'none', tokens: 0 } },
  { lang: 'en', compaction: {} },
)
assert.ok(unknownEn.includes('Context window unknown'))
assert.ok(!/ \/ /.test(unknownEn), 'must not print a used/capacity fraction without a capacity')

// ── 正文不放解释性文案 ───────────────────────────────────────────────
for (const banned of ['note:', 'policy min', 'Source:', 'counts this turn']) {
  assert.ok(!en.includes(banned), `UI must not carry explanatory copy: ${banned}`)
}

// ── 走真实的 apply → handler ────────────────────────────────────────
function mountCommand() {
  const registered = []
  const ctx = {
    get: () => undefined,
    sessions: { get: () => fakeSession() },
    tokenMeter: { measure: () => measurement },
    commands: { register: (definition) => (registered.push(definition), () => {}) },
    effect: (fn) => fn(),
  }
  apply(ctx)
  assert.equal(registered.length, 1, 'apply must register exactly one command')
  const definition = registered[0]
  // 不声明 input，composer 会把带参数的调用当普通提示词发给模型。
  assert.match(definition.input?.hint ?? '', /top/)
  return (rawInput) =>
    definition.handler({
      rawInput,
      agent: { id: 'session-1' },
      commandId: 'cmd-1',
      attachments: [],
      signal: { aborted: false },
    })
}

const run = mountCommand()

const plainZh = run('')
assert.equal(plainZh.kind, 'success')
assert.ok(plainZh.text.includes('上下文占用'))
assert.ok(!plainZh.text.includes('最大节点'), 'plain /context must not list nodes')

const topTwoEn = run('top 2 en')
assert.ok(topTwoEn.text.includes('Largest nodes'))
const rowsEn = topTwoEn.text.split('Largest nodes')[1].trim().split('\n')
assert.equal(rowsEn.length, 2)
assert.match(rowsEn[0], /read +153\.3k {2}turn 2/)
assert.match(rowsEn[1], /system +12\.4k/)

const topTwoZh = run('top 2')
const rowsZh = topTwoZh.text.split('最大节点')[1].trim().split('\n')
assert.equal(rowsZh.length, 2)
assert.match(rowsZh[0], /read +153\.3k {2}第 2 轮/)

assert.equal(run('3').text, run('top 3').text, 'bare N must equal top N')
assert.equal(run('3').text.split('最大节点')[1].trim().split('\n').length, 3)

for (const bad of ['bogus', '0', 'top 0', 'top x', 'top 3x', 'top 1 2']) {
  const result = run(bad)
  assert.equal(result.kind, 'error', `"${bad}" must be rejected`)
  assert.equal(result.text, '用法：/context [top] [N] [zh|en]')
}

// ── 排版契约 ────────────────────────────────────────────────────────
for (const [what, text] of [
  ['en report', en],
  ['with tools', withTools],
  ['with mcp', mcp],
  ['unknown en', unknownEn],
  ['over-trigger', over],
  ['top en', topTwoEn.text],
]) {
  const bad = text.match(/[^\x20-\x7e\n]/g)
  assert.equal(bad, null, `${what}: English output must be ASCII only, found ${JSON.stringify(bad)}`)
}
for (const [what, text] of [
  ['zh report', zh],
  ['top zh', topTwoZh.text],
]) {
  const bad = text.match(/[█░]/g)
  assert.equal(bad, null, `${what}: block characters must not be used, found ${JSON.stringify(bad)}`)
}

console.log('\nALL CHECKS PASSED')
