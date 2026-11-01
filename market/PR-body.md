# Add Lovenndme/dsh-command-context

Submits a new plugin to the list.

**Repository:** https://github.com/Lovenndme/dsh-command-context
**npm:** [`dsh-command-context`](https://www.npmjs.com/package/dsh-command-context)
**Category:** `usage`

## What it does

A `/context` human command for DeepSeek Harness. Type it in any session to get:

```
Context: deepseek-v4.1-flash (myapi)
[#####---------------]  253.3k / 1.00M tokens (25.3%)  measured
Free space: 746.7k tokens (74.7%)

By message type (sum 120.1k tokens)
  System prompt        2.1k  (1.8%)
  Memory files       369.0  (0.3%)
  Skills               1.1k  (0.9%)
  User messages        7.9k  (6.6%)
  Assistant replies   39.1k  (32.5%)
  Tool results        69.5k  (57.8%)

Compaction trigger: ~800.0k tokens (80.0%), 546.7k headroom
```

## Why it belongs in `usage`

It is a read-only observability command: it reports how the context window is being
spent, so users can see what actually fills their prompt (tool results vs. memory files
vs. skills) instead of guessing.

## Facts a reviewer usually asks about

- **No network at all.** The plugin never makes an outbound request; there is no version
  check, no telemetry, no remote fetch.
- **Read-only.** It appends no session events, triggers no model call, and mutates no
  session state. It reads documented host services only (`ctx.commands`,
  `ctx.sessions`, `ctx.tokenMeter`).
- **One client-side touch, scoped to itself.** The client half occupies the keyed slot
  `conversation.chat.commandview` under key `context` so the report opens expanded
  instead of inside the generic collapsed card. It touches no other command and uses only
  public theme tokens. A composition without the chat UI still works via the host half.
- **Host-only.** No client half, no extra services to compose beyond the plugin row.
- **Requirements:** `@deepseek-ai/dsh` `>=0.2.1-rc.5 <0.3.0-0`.
- **License:** MIT.

## Checklist

- [x] Public repository
- [x] Published on npm (`dsh-command-context@0.1.0`)
- [x] `dsh-plugin` topic set on the repository
- [x] Entry file `data/plugins/Lovenndme__dsh-command-context.yml` added in this PR
