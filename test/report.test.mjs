/**
 * 离线校验 buildReport 的分类、排版与算术。用合成数据，不碰任何真实会话。
 * 运行：node test/report.test.mjs
 *
 * 守的几条约定（都是真实踩过的）：
 *   · 正文必须是纯 ASCII —— 命令结果渲染在 <pre> 里，CJK 与块字符会和相邻行挤在一起；
 *   · 列必须真的对齐 —— 按字符串长度补齐对 ASCII 才成立；
 *   · 「整条都是 <system-reminder>」的 user/message 要从用户消息里拆出来
 *     （AGENTS.md 工作区指令 = memory，skills 目录 = skills）；
 *   · 正文不放解释性文案（口径说明写在 README）。
 */
import assert from 'node:assert/strict'
import { buildReport } from '../index.js'

/** 造一个事件：user/message 的 data 本身就是消息，其余藏一层 message。 */
function event(type, text) {
  const content = text === null ? [] : [{ type: 'text', text }]
  return type === 'user/message'
    ? { type, data: { role: 'user', content } }
    : { type, data: { message: { content } } }
}

const REMINDER_MEMORY =
  '<system-reminder>\nThe following workspace instructions may be relevant to your work.\n\nInstructions from: ~/.dsh/AGENTS.md\n...\n</system-reminder>'
const REMINDER_SKILLS =
  '<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n<available_skills>...</available_skills>\n</system-reminder>'

const events = new Map([
  [1, event('system/message', 'You are an AI agent powered by DeepSeek Harness.')],
  [2, event('user/message', REMINDER_MEMORY)],
  [3, event('user/message', REMINDER_SKILLS)],
  [4, event('user/message', '请给这个仓库加一个 /context 命令')],
  [5, event('assistant/message', '好的，先看现有能力。')],
  [6, event('tool/result', '{"content":"..."}')],
])

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
  }
}

const measurement = {
  logRevision: 42,
  baseline: { kind: 'usage', tokens: 150_000, usage: {} },
  surfaceDeltaTokens: 43_200,
  totalTokens: 193_200,
  surfaceTokens: 180_000,
  nodes: [
    { seq: 1, tokens: 12_400, heuristicTokens: 12_000 },
    { seq: 2, tokens: 1_500, heuristicTokens: 1_450 },
    { seq: 3, tokens: 1_500, heuristicTokens: 1_450 },
    { seq: 4, tokens: 3_200, heuristicTokens: 3_100 },
    { seq: 5, tokens: 8_100, heuristicTokens: 8_000 },
    { seq: 6, tokens: 153_300, heuristicTokens: 150_000 },
  ],
}

// fixture 自检：节点之和必须等于 surfaceTokens，否则类别表会漏账
const nodeSum = measurement.nodes.reduce((sum, node) => sum + node.tokens, 0)
assert.equal(nodeSum, measurement.surfaceTokens, 'fixture: nodes must sum to surfaceTokens')

const report = buildReport(fakeSession(), measurement)
console.log(report)
console.log('\n' + '─'.repeat(64) + '\n')

// 1) 抬头与占用率 = totalTokens / capacity，并标注数字可信度
assert.match(report, /^Context: deepseek-v4\.1-flash \(myapi\)$/m)
assert.match(report, /193\.2k \/ 1\.00M tokens \(19\.3%\) {2}measured/)
assert.match(report, /^\[#{4}-{16}\]  /m, 'bar should be 4 filled of 20 for 19.3%')
assert.match(report, /Free space: 806\.8k tokens \(80\.7%\)/)

// 2) 六类齐全：memory / skills 必须从用户消息里拆出来
assert.match(report, /By category \(sum 180\.0k tokens\)/)
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
assert.match(report, /User messages +3\.2k +\(1\.8%\)/)

// 2b) 工具定义：给了 toolsTokens 就多一行，且分母变成「节点合计 + 工具定义」
assert.ok(!report.includes('Tool definitions'), 'no toolsTokens means no tools row')
const withTools = buildReport(fakeSession(), measurement, { toolsTokens: 98_400 })
console.log(withTools)
assert.match(withTools, /By category \(sum 278\.4k tokens\)/)
assert.match(withTools, /Tool definitions +98\.4k +\(35\.3%\)/)
assert.match(withTools, /System prompt +12\.4k +\(4\.5%\)/, 'shares must use the combined denominator')
assert.ok(
  withTools.indexOf('Tool results') < withTools.indexOf('Tool definitions'),
  'tools row belongs after the node rows',
)

// 3) 混排消息不算注入：只要有一条块不是 reminder，整条按用户消息算
events.set(7, event('user/message', 'normal text\n<system-reminder>tail</system-reminder>'))
const mixed = buildReport(fakeSession(), {
  ...measurement,
  totalTokens: 193_200,
  surfaceTokens: 181_000,
  nodes: [...measurement.nodes, { seq: 7, tokens: 1_000, heuristicTokens: 1_000 }],
})
assert.ok(!mixed.includes('Injected context'), 'mixed node must not be classified as injection')
assert.match(mixed, /User messages +4\.2k/, 'mixed node must stay under user messages')
events.delete(7)

// 4) 压缩触发点 = min(W*0.8, W-maxTokens-headroom)
assert.match(report, /Compaction trigger: ~800\.0k tokens \(80\.0%\), 606\.8k headroom/)

// 5) 未知上下文窗口：不猜占用率
const unknown = buildReport(fakeSession({ withContext: false }), {
  ...measurement,
  baseline: { kind: 'none', tokens: 0 },
})
console.log(unknown)
assert.ok(unknown.includes('Context window unknown'))
assert.match(unknown, /used 193\.2k tokens {2}estimated/)
assert.ok(!/ \/ /.test(unknown), 'must not print a used/capacity fraction without a capacity')
assert.ok(!unknown.includes('Compaction trigger'), 'no capacity means no trigger math')

// 6) 越过触发点时的措辞
const over = buildReport(fakeSession(), {
  ...measurement,
  totalTokens: 900_000,
  surfaceTokens: 890_000,
  nodes: [{ seq: 6, tokens: 890_000, heuristicTokens: 880_000 }],
})
assert.match(over, /Compaction trigger passed/)

// 7) 正文不放解释性文案（口径说明属于 README）
for (const banned of ['note:', 'policy min', 'Source:', 'counts this turn']) {
  assert.ok(!report.includes(banned), `UI must not carry explanatory copy: ${banned}`)
}

// 8) 排版契约：纯 ASCII（<pre> 里 CJK / 块字符会把行挤在一起）
for (const [what, text] of [
  ['main report', report],
  ['unknown-capacity report', unknown],
  ['over-trigger report', over],
]) {
  const bad = text.match(/[^\x20-\x7e\n]/g)
  assert.equal(bad, null, `${what}: output must be ASCII only, found ${JSON.stringify(bad)}`)
}

console.log('\nALL CHECKS PASSED')
