# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-11-02

### Added

- `Tool definitions` row: the token cost of the tool schemas the model is sent, read from
  the `tokenMeter` `contextBreakdown` projection (`toolsTokens`) rather than estimated
  locally. When that projection is unavailable the row is omitted instead of guessed.
- With the row present the table's sum becomes surface nodes + tool definitions, so every
  row shares one denominator.

### Changed

- Section title `By message type` → `By category`, since tool definitions are not a message
  type.

## [0.2.0] - 2026-11-01

### Added

- Client half: the report now renders **expanded by default** instead of inside the
  generic collapsed command card, so no click is needed to read it. It occupies the keyed
  client slot `conversation.chat.commandview` under key `context`, the documented
  per-command renderer seam; every other command keeps the built-in card.
- The card uses only public theme tokens (`--dsw-alias-bg-layer-1`,
  `--dsw-alias-border-l1`, `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`,
  `--dsw-alias-state-error-primary`), so it follows light and dark themes.

### Notes

- The host half is unchanged. A composition without the chat UI keeps the generic card.

## [0.1.0] - 2026-11-01

First public release.

### Added

- `/context` human command: reports the current session's context-window usage as
  `used / capacity` with a percentage, an ASCII meter, and the remaining free space.
- Per-category breakdown by session surface node: `System prompt`, `Memory files`,
  `Skills`, `Injected context`, `User messages`, `Assistant replies`, `Tool results`.
  Percentages are taken against the node total (`surfaceTokens`), which is the
  `tokenMeter` contract for that sum.
- `Compaction trigger` reference line, computed from the shipped
  `compaction-basic` defaults: `min(W * 0.8, W - maxTokens - 65536)`.
- Bilingual plugin metadata (`locale/en.json`, `locale/zh.json`) and an original
  icon, so the plugin shows a proper title, description, and artwork in Plugin
  Manager.

### Design notes

- Reads only documented, already-existing services: `ctx.tokenMeter.measure()`,
  `ctx.sessions.get()`, `Session.requestContext()`, `Session.requestHeader()`, and
  `Session.eventAt()`. The command never appends session events, never triggers a
  model call, and never mutates session state.
- Occupancy follows the `@deepseek-ai/dsh-token-meter` definition:
  `measure().totalTokens / resolveModelInfo().context`.
- `Memory files` and `Skills` are split out of user messages: in DSH each of them
  arrives as its own `user/message` whose only block is a `<system-reminder>`.
  Classification is conservative — a message that also contains real user text
  stays under `User messages`.
- Report body is intentionally ASCII-only English: command results render inside a
  `<pre>` with `white-space: pre-wrap`, where full-width CJK glyphs and block
  characters (`█░`) overlap adjacent lines. The command's description stays in
  Chinese to match the built-in commands in a Chinese UI.

### Known limitations

- The main figure is measured provider usage only when a reusable usage anchor
  exists; otherwise it is the fixed four-characters-per-token heuristic, which
  under-prices CJK text and JSON Schema. The report marks which one was used.
- Tool schemas are not part of the surface nodes, so they have no line of their
  own yet. Exposing them requires reading the `contextBreakdown` projection.
- The `Compaction trigger` line describes the default policy's threshold; it does
  not assert that automatic compaction is enabled in the current composition.
