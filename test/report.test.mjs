/**
 * 离线校验 /context 的分类、排版、参数与算术。用合成数据，不碰任何真实会话。
 * 运行：node test/report.test.mjs
 *
 * 守的几条约定（都是真实踩过的）：
 *   · 正文必须是纯 ASCII —— 命令结果渲染在等宽容器里，CJK 与块字符会把行挤在一起；
 *   · 列必须真的对齐 —— 按字符串长度补齐对 ASCII 才成立；
 *   · 「整条都是 <system-reminder>」的 user/message 要从用户消息里拆出来
 *     （AGENTS.md 工作区指令 = memory，skills 目录 = skills）；
 *   · 正文不放解释性文案（口径说明写在 README）；
 *   · 分类之和必须等于表头那个分母（差额落到 Unaccounted），否则读者会算出不同的数。
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
  '<system-reminder>\nThe following workspace instructions may be relevant to your work.\n\nInstructions from: ~/.dsh/AGENTS.md\n</system-reminder>'
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

function fakeSession({ withContext = true } = {}) {
  return {
    requestContext: () =>
      withContext
        ? { provider: 'myapi', model: 'deepseek-v4.1-flash', contextWindow: 1_000_000 }
        : undefined,
    requestHeader: () => ({
      config: { provider: 'myapi', model: 'deepseek-v4.1-flash', maxTokens: 32768 },
    }),
    eventAt: (seq) => events.get(seq),
    snapshotEvents: () => [...events.values()],
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

// fixture 自检：节点之和必须等于 surfaceTokens，否则类别表会漏账
const nodeSum = NODES.reduce((sum, node) => sum + node.tokens, 0)
assert.equal(nodeSum, measurement.surfaceTokens, 'fixture: nodes must sum to surfaceTokens')

const report = buildReport(fakeSession(), measurement, { compaction: {} })
console.log(report)
console.log('\n' + '─'.repeat(64) + '\n')

// 1) 抬头与占用率 = totalTokens / capacity，并标注数字可信度
assert.match(report, /^Context: deepseek-v4\.1-flash \(myapi\)$/m)
assert.match(report, /193\.2k \/ 1\.00M tokens \(19\.3%\) {2}measured/)
assert.match(report, /^\[#{4}-{16}\]  /m, 'bar should be 4 filled of 20 for 19.3%')
assert.match(report, /Free space: 806\.8k tokens \(80\.7%\)/)

// 2) 六类齐全：memory / skills 必须从用户消息里拆出来
assert.match(report, /By category \(of 193\.2k tokens\)/)
for (const label of [
  'System prompt',
  'Memory files',
  'Skills',
  'User messages',
  'Assistant replies',
  'Tool results',
]) {
  assert.ok(report.includes(label), `missing category: ${label}`)
}
assert.match(report, /Memory files +1\.5k +\(0\.8%\)/)
assert.match(report, /Skills +1\.5k +\(0\.8%\)/)
assert.match(report, /User messages +3\.2k +\(1\.7%\)/)

// 2b) 口径差必须显式成一行：压力 193.2k - 节点 180.0k = 13.2k
assert.match(report, /Unaccounted +13\.2k +\(6\.8%\)/)

// 2c) 工具定义：给了 toolsTokens 就多一行，分母取「实测压力」与「已归类合计」的较大者
const withTools = buildReport(
  fakeSession(),
  { ...measurement, totalTokens: 340_000 },
  { toolsTokens: 98_400, compaction: {} },
)
console.log(withTools)
assert.match(withTools, /By category \(of 340\.0k tokens\)/)
assert.match(withTools, /Tool definitions +98\.4k +\(28\.9%\)/)
assert.match(withTools, /Unaccounted +61\.6k/) // 340.0k - (180.0k + 98.4k)
assert.ok(
  withTools.indexOf('Tool results') < withTools.indexOf('Tool definitions'),
  'tools row belongs after the node rows',
)

// 3) 混排消息不算注入：只要有一条块不是 reminder，整条按用户消息算
events.set(8, event('user/message', 'normal text\n<system-reminder>tail</system-reminder>', { turn: 3 }))
const mixed = buildReport(
  fakeSession(),
  {
    ...measurement,
    totalTokens: 194_200,
    surfaceTokens: 181_000,
    nodes: [...NODES, { seq: 8, tokens: 1_000, heuristicTokens: 1_000 }],
  },
  { compaction: {} },
)
assert.ok(!mixed.includes('Injected context'), 'mixed node must not be classified as injection')
assert.match(mixed, /User messages +4\.2k/, 'mixed node must stay under user messages')
events.delete(8)

// 4) 压缩触发点 = min(W*0.8, W-maxTokens-headroom)；读不到真实策略时标注 default policy
assert.match(report, /Compaction trigger \(default policy\): ~800\.0k tokens \(80\.0%\), 606\.8k headroom/)
// 4b) 读得到真实策略就用真实值，且不再标 default
const tuned = buildReport(fakeSession(), measurement, {
  compaction: {},
  compactionPolicy: { thresholdRatio: 0.7, headroomTokens: 65536 },
})
assert.match(tuned, /Compaction trigger: ~700\.0k tokens \(70\.0%\)/)
assert.ok(!tuned.includes('default policy'))
// 4c) 没有压实后端就不谈阈值
assert.ok(!buildReport(fakeSession(), measurement).includes('Compaction trigger'))

// 5) 未知上下文窗口：不猜占用率
const unknown = buildReport(
  fakeSession({ withContext: false }),
  { ...measurement, baseline: { kind: 'none', tokens: 0 } },
  { compaction: {} },
)
console.log(unknown)
assert.ok(unknown.includes('Context window unknown'))
assert.match(unknown, /used 193\.2k tokens {2}estimated/)
assert.ok(!/ \/ /.test(unknown), 'must not print a used/capacity fraction without a capacity')
assert.ok(!unknown.includes('Compaction trigger'), 'no capacity means no trigger math')

// 6) 越过触发点时的措辞
const over = buildReport(
  fakeSession(),
  { ...measurement, totalTokens: 900_000, surfaceTokens: 890_000, nodes: [{ seq: 7, tokens: 890_000, heuristicTokens: 880_000 }] },
  { compaction: {} },
)
assert.match(over, /Compaction trigger \(default policy\) passed/)

// 7) 正文不放解释性文案（口径说明属于 README）
for (const banned of ['note:', 'policy min', 'Source:', 'counts this turn']) {
  assert.ok(!report.includes(banned), `UI must not carry explanatory copy: ${banned}`)
}

// 8) 走真实的 apply → handler：参数解析与「最大节点」排行
function mountCommand({ toolsTokens } = {}) {
  const registered = []
  const ctx = {
    get: (name) =>
      name === 'sessionProjections' && toolsTokens !== undefined
        ? { snapshot: () => ({ values: { contextBreakdown: { toolsTokens } } }) }
        : undefined,
    sessions: { get: () => fakeSession() },
    tokenMeter: { measure: () => measurement },
    commands: { register: (definition) => (registered.push(definition), () => {}) },
    effect: (fn) => fn(),
  }
  apply(ctx)
  assert.equal(registered.length, 1, 'apply must register exactly one command')
  const definition = registered[0]
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

const plain = run('')
assert.equal(plain.kind, 'success')
assert.ok(!plain.text.includes('Largest nodes'), 'plain /context must not list nodes')

const topTwo = run('top 2')
assert.equal(topTwo.kind, 'success')
assert.ok(topTwo.text.includes('Largest nodes'))
const largestRows = topTwo.text.split('Largest nodes')[1].trim().split('\n')
assert.equal(largestRows.length, 2, 'top 2 must list exactly two nodes')
assert.match(largestRows[0], /read +153\.3k {2}turn 2/, 'tool results must be named by tool, with its turn')
assert.match(largestRows[1], /system +12\.4k/, 'non-tool nodes fall back to a role label')

const topDefault = run('top')
assert.equal(topDefault.text.split('Largest nodes')[1].trim().split('\n').length, 5)

for (const bad of ['bogus', 'top 0', 'top x', 'top 1 2']) {
  const result = run(bad)
  assert.equal(result.kind, 'error', `"${bad}" must be rejected`)
  assert.equal(result.text, 'Usage: /context [top [N]]')
}

// 9) 排版契约：纯 ASCII
for (const [what, text] of [
  ['main report', report],
  ['with tools', withTools],
  ['unknown-capacity report', unknown],
  ['over-trigger report', over],
  ['top output', topTwo.text],
]) {
  const bad = text.match(/[^\x20-\x7e\n]/g)
  assert.equal(bad, null, `${what}: output must be ASCII only, found ${JSON.stringify(bad)}`)
}

console.log('\nALL CHECKS PASSED')
