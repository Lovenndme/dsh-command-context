# dsh-command-context

English | [中文](README.zh.md)

A `/context` slash command for **DeepSeek Harness**: type it in a session to see how much
of the context window is used, how much is free, and which part of the prompt takes the
most room.

Inspired by Claude Code's `/context`, but every number comes from the harness's own
measurement instead of a parallel accounting of its own.

```
Context: deepseek-v4.1-flash (myapi)
[#####---------------]  253.3k / 1.00M tokens (25.3%)  measured
Free space: 746.7k tokens (74.7%)

By category (sum 218.5k tokens)
  System prompt        2.1k  (1.0%)
  Memory files       369.0  (0.2%)
  Skills               1.1k  (0.5%)
  User messages        7.9k  (3.6%)
  Assistant replies   39.1k  (17.9%)
  Tool results        69.5k  (31.8%)
  Tool definitions    98.4k  (45.0%)

Compaction trigger: ~800.0k tokens (80.0%), 546.7k headroom
```

Illustrative numbers. `measured` means the headline figure came from reusable provider
usage; `estimated` means it fell back to the character heuristic.

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
| Breakdown | `measure().nodes`, classified per node; the sum is `surfaceTokens` (= the sum of those nodes) plus `Tool definitions` when present |
| Tool definitions | `toolsTokens` from the `ctx.sessionProjections` unit `contextBreakdown` |
| Compaction trigger | `min(W * 0.8, W - maxTokens - 65536)`, the shipped `compaction-basic` defaults |

Occupancy follows the `@deepseek-ai/dsh-token-meter` definition verbatim: **measured
pressure ÷ the capacity of the model route that owns it**.

`totalTokens = baseline.tokens + surfaceDeltaTokens`. When `baseline.kind === 'usage'` the
baseline is the last request's reported usage (input + cache read/write + output);
otherwise it is the fixed four-characters-per-token heuristic, which under-prices CJK text
and JSON Schema documents.

The command is read-only: it never appends session events, never triggers a model call, and
never mutates session state. Its lifecycle (`command/run`, `command/done`) is recorded by
the command registry as log-only events.

## Why the report body is ASCII-only English

A command result renders inside a `<pre>` with `white-space: pre-wrap` and a monospace font.
Full-width CJK glyphs are wider than the assumed cell, and block characters such as `█░` are
taller than the line box — both visually collide with the neighbouring lines in that
container. ASCII has a constant width of one cell, so column alignment is exact: the meter
uses `#`/`-`, labels are English, and brackets are half-width.

Two languages are kept apart on purpose: the **report body is English** for the layout
reason above, while the **command's description in the slash panel is Chinese**
(`查看当前会话的上下文窗口占用`) to match built-in commands in a Chinese UI. Plugin Manager
metadata ships in both languages via `locale/en.json` and `locale/zh.json`.

## Limitations

- **An estimate, not a bill.** The headline is measured only when reusable provider usage
  exists. The breakdown is always per-message route pricing, so it is a different scale
  from the headline and will not sum to it — the `By category` line prints the sum so the
  two can be compared.
- **`Tool definitions` comes from a different estimator than the rows above it.** It is
  `toolsTokens` from the `contextBreakdown` projection (the harness's own tool-schema
  pricing, four-characters-per-token based) rather than a per-message route price. When that
  projection is unavailable the row is omitted rather than estimated separately, which is
  also when the sum drops back to the node total.
- **`Compaction trigger` describes the default policy's threshold** and does not assert that
  automatic compaction is enabled in your composition.
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
