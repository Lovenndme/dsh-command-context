# dsh-command-context

English | [中文](README.zh.md)

A `/context` slash command for **DeepSeek Harness**: type it in a session to see how much
of the context window is used, how much is free, and which part of the prompt takes the
most room.

Inspired by Claude Code's `/context`, but every number comes from the harness's own
measurement instead of a parallel accounting of its own.

```
Context: deepseek-v4.1-flash (myapi)
[##########----------]  500.0k / 1.00M tokens (50.0%)  measured
Free space: 500.0k tokens (50.0%)

By category (of 500.0k tokens)
  System prompt        4.0k  (0.8%)
  Memory files         1.0k  (0.2%)
  Skills               3.0k  (0.6%)
  Injected context     1.0k  (0.2%)
  User messages       30.0k  (6.0%)
  Assistant replies  160.0k  (32.0%)
  Tool results       101.0k  (20.2%)
  Tool definitions   100.0k  (20.0%)
  Unaccounted        100.0k  (20.0%)

Compaction trigger (default policy): ~800.0k tokens (80.0%), 300.0k headroom
```

`/context top [N]` appends the largest surface nodes — the answer to "what is actually
eating my context" (`/context 3` is accepted as a shorthand for `top 3`):

```
Largest nodes
  read            41.6k  turn 4
  pwsh            22.8k  turn 7
  assistant       18.4k  turn 9
  grep            12.0k  turn 2
  user             8.1k  turn 5
```

Tool results are named by the tool that produced them (resolved from `tool/call`), so a
single oversized output is visible at a glance. `N` defaults to 5 and is capped at 20.

Illustrative numbers. `measured` means the headline figure came from reusable provider
usage; `estimated` means it fell back to the character heuristic.

## Languages

The report is bilingual and **Chinese is the default**; `/context en` switches to English
(`/context zh` switches back). Both render identical numbers — only the wording changes:

```
上下文占用: deepseek-v4.1-flash (myapi)
[##########----------]  497.5k / 1.00M tokens (49.8%)  实测
剩余空间: 502.5k tokens (50.2%)

按类别（合计 497.5k tokens）
  系统提示      2.1k  (0.4%)
  记忆文件       379  (0.1%)
  技能          2.2k  (0.4%)
  用户消息     28.3k  (5.7%)
  助手回复    227.4k  (45.7%)
  工具结果    135.3k  (27.2%)
  工具定义     13.0k  (2.6%)
  未计入差额   88.8k  (17.9%)

压缩触发点（默认策略）: ~800.0k tokens (80.0%), 302.5k 余量
```

Column padding follows **display width** (a CJK glyph counts as two cells), so the numeric
columns line up in either language.

The card renders **expanded by default**. A command result normally lands in the generic
collapsed card that needs a click to open; this plugin's client half takes over the keyed
client slot `conversation.chat.commandview` for the `context` command only, so the report
is simply visible. Every other command keeps the built-in card. In a composition without a
chat UI the host half still works and the generic card is used.

## Install

```sh
dsh plugin --profile <profile> add dsh-command-context
```

Or install it from the plugin directory. The bundle is Host-only — no client half, no
extra services to compose:

```yaml
- insert:
    - id: dsh-command-context
      name: dsh-command-context
```

Requires `@deepseek-ai/dsh` `>=0.2.1-rc.5 <0.3.0-0`. The command is registered globally,
so it is available in every agent of that profile.

## How categories are decided

Classification is **per surface node**, not by slicing text: every surface node already
carries its own token price, so the command only has to decide which bucket it belongs to.

| Event | Bucket |
| --- | --- |
| `system/message` | `System prompt` |
| `user/message` whose blocks are all `<system-reminder>` and mention `workspace instructions` / `Instructions from:` / `memory root:` | `Memory files` |
| `user/message` whose blocks are all `<system-reminder>` and mention `skills are available` / `<available_skills>` | `Skills` |
| `user/message`, any other `<system-reminder>` injection | `Injected context` |
| `user/message`, real input | `User messages` |
| `developer/message` | `Injected context` |
| `assistant/message` | `Assistant replies` |
| `tool/result` | `Tool results` |
| `tool/result` whose tool name starts with `mcp__` | `MCP` |

The part that matters: **an instruction file (e.g. `AGENTS.md`) and the skills catalog each
arrive as their own `user/message`** whose only block is a `<system-reminder>` — they are
neither part of the system prompt nor something the user typed. Leaving them in
`User messages` inflates that line badly, which is exactly what the first version of this
plugin got wrong.

The split is deliberately conservative: if a message contains even one block that is not a
`<system-reminder>`, the whole message stays under `User messages`. Under-splitting beats
misattributing text the user actually wrote.

## Where the numbers come from

| Figure | Source |
| --- | --- |
| Used / pressure | `ctx.tokenMeter.measure(session).totalTokens` — replays the durable session log, no model call |
| Context capacity | `session.requestContext().contextWindow` (the `request/context` record) |
| Free space | capacity − pressure |
| Breakdown | `measure().nodes`, classified per node |
| Tool definitions | `toolsTokens` from the `ctx.sessionProjections` unit `contextBreakdown`, minus the MCP share |
| MCP | tool results produced by `mcp__*` tools (node pricing), plus the MCP share of the tool definitions above, allocated by declared schema size |
| Unaccounted | the table's denominator (the measured pressure) minus everything itemized above it |
| Largest nodes | `measure().nodes` sorted by tokens; tool results are named from the matching `tool/call` event |
| Compaction trigger | `min(W * ratio, W - maxTokens - headroom)`, using the compaction backend's own policy when it is reachable, otherwise the `compaction-basic` defaults and the row is labelled `(default policy)` |

Every row shares one denominator — the measured pressure — so the table always sums to the
headline. Whatever the two estimators cannot explain lands in `Unaccounted` instead of
leaving the reader to subtract and guess.

Occupancy follows the `@deepseek-ai/dsh-token-meter` definition verbatim: **measured
pressure ÷ the capacity of the model route that owns it**.

`totalTokens = baseline.tokens + surfaceDeltaTokens`. When `baseline.kind === 'usage'` the
baseline is the last request's reported usage (input + cache read/write + output);
otherwise it is the fixed four-characters-per-token heuristic, which under-prices CJK text
and JSON Schema documents.

The command is read-only: it never appends session events, never triggers a model call, and
never mutates session state. Its lifecycle (`command/run`, `command/done`) is recorded by
the command registry as log-only events.

## Why the report avoids block characters

A command result renders inside a `<pre>` with `white-space: pre-wrap` and a monospace font.
Block characters such as `█░` are taller than the line box and visually collide with the
neighbouring lines in that container, so the meter uses `#`/`-` instead. Column alignment is
computed from display width rather than string length, which is what makes the Chinese labels
line up with the numbers.

The command's description in the slash panel is Chinese (`查看当前会话的上下文窗口占用`) to
match built-in commands in a Chinese UI. Plugin Manager metadata ships in both languages via
`locale/en.json` and `locale/zh.json`.

## Limitations

- **An estimate, not a bill.** The headline is measured only when reusable provider usage
  exists. The itemized rows are route pricing / heuristic, so they are a different scale
  from the headline; `Unaccounted` is that difference, not a category and not a mistake.
  When the headline itself is heuristic (no reusable provider usage) the table sums exactly
  and `Unaccounted` disappears.
- **`Tool definitions` comes from a different estimator than the rows above it.** It is
  `toolsTokens` from the `contextBreakdown` projection (the harness's own tool-schema
  pricing) rather than a per-message route price. When that projection is unavailable the
  row is omitted rather than estimated separately, and its share moves into `Unaccounted`.
- **The definitions part of `MCP` is allocated, not measured.** Tool schemas are only known as
  one `toolsTokens` total, so the MCP share of it is split by declared schema size; the MCP
  *results* part is real per-node pricing. When a session sends no `mcp__*` tool the row is
  absent.
- **`Compaction trigger` is labelled `(default policy)` unless the backend's own policy was
  reachable.** Either way it does not assert that automatic compaction is enabled in your
  composition; with no compaction backend reachable the line is omitted entirely.
- **No capacity, no percentage.** A session with no `request/context` record yet reports the
  used tokens and says plainly that it cannot compute a ratio.
- Covers the current session only; subagent sessions are not included.

## Updating during development

A bundle installed from a local directory is a junction into your source tree, and the HMR
watcher's default `ignored` includes `**/node_modules` — so **editing the source does not
hot-reload the plugin**. To load a new module generation without quitting the app:

1. Toggle the plugin row off and on once (`set_plugin` with `include:dsh-command-context`,
   `enabled: false` then `true`). The loader re-imports the module.
2. Set `DSH_CONTEXT_LOAD_STAMP=1` before launching to have the plugin append a
   `time rev=N` line to `~/.dsh/tmp/dsh-command-context.loads.log` on every activation, so
   you can tell which generation is live. Off by default — the plugin writes nothing to
   your home directory otherwise.
3. If the stamp does not advance, fully quit the app from its tray icon and relaunch
   (closing the window only minimizes it, and the host process keeps the old module).

`install_bundle` answers `already-installed` for an existing package; replacing a version
needs `remove_bundle` first, and that removes the junction — back up the source directory
before doing it.

## Development

```sh
node --check index.js
node test/report.test.mjs
```

The test suite uses synthetic data to assert classification (including the memory/skills
split and that mixed messages are not misattributed), the occupancy arithmetic, the
unknown-capacity branch, ASCII-only output, column alignment, and the absence of
explanatory copy in the report.

## License

MIT
