# dsh-command-context

[English](README.md) | 中文

给 **DeepSeek Harness** 加一个 `/context` 斜杠命令：在会话里输入它，就能看到**当前会话的上下文窗口占用**——用了多少、还剩多少、提示词里各部分各占多大。

参考 Claude Code 的 `/context`，但数字全部来自 Harness 自己的口径，不另起一套统计。

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

（示意数据。`measured` 表示主数字来自可复用的 provider 实测用量，`estimated` 表示回落到字符启发式。）

结果卡片**默认展开**。命令结果默认落在内置的折叠卡片里、要点一下才展开；本插件的客户端半区只接管 `context` 这一条命令的 keyed slot（`conversation.chat.commandview`），所以报告直接铺开。其他命令仍是内置卡片；没有聊天界面的组合下，宿主半区照常工作、走内置卡片。

## 安装

```sh
dsh plugin --profile <profile> add dsh-command-context
```

或用 Plugin Manager 安装本目录。这是个纯宿主插件（Host-only），没有浏览器半区，也不需要额外组合服务：

```yaml
- insert:
    - id: dsh-command-context
      name: dsh-command-context
```

要求 `@deepseek-ai/dsh` `>=0.2.1-rc.5 <0.3.0-0`。命令是全局注册的，装好后该 profile 下所有 agent 都能用。

## 分类是怎么判定的

按**表面节点**分类，不是按文本长度切——每个表面节点自带 token 价，判定归属即可。

| 事件 | 落到哪一类 |
| --- | --- |
| `system/message` | `System prompt` |
| `user/message`，整条都是 `<system-reminder>` 且含 `workspace instructions` / `Instructions from:` / `memory root:` | `Memory files` |
| `user/message`，整条都是 `<system-reminder>` 且含 `skills are available` / `<available_skills>` | `Skills` |
| `user/message`，其他 `<system-reminder>` 注入 | `Injected context` |
| `user/message`，真实输入 | `User messages` |
| `developer/message` | `Injected context` |
| `assistant/message` | `Assistant replies` |
| `tool/result` | `Tool results` |

关键点：**指令文件（如 `AGENTS.md`）和 skills 目录各自是一条独立的 `user/message`**，单块 `<system-reminder>`——既不是系统提示的一部分，也不是用户自己写的。不拆出来的话「用户消息」会被明显虚高，这正是本插件最早版本的错误。

拆分是保守的：只要一条消息里有一块不是 `<system-reminder>` 开头，整条就按「用户消息」算。宁可少拆，也不错算用户自己写的内容。

## 数字从哪来

| 数字 | 来源 |
| --- | --- |
| 已用 / 总占用 | `ctx.tokenMeter.measure(session).totalTokens`（回放会话日志折叠，无模型调用） |
| 上下文上限 | `session.requestContext().contextWindow`（`request/context` 事件） |
| 剩余空间 | 上限 − 总占用 |
| 分类明细 | `measure().nodes` 逐个按节点归类，合计是 `surfaceTokens`（= 各节点之和）加上有值时的 `Tool definitions` |
| 工具定义 | `ctx.sessionProjections` 的 `contextBreakdown` 投影里的 `toolsTokens` |
| 压缩触发点 | `min(W × 0.8, W − maxTokens − 65536)`，即 `compaction-basic` 的默认策略 |

占用率口径照 `@deepseek-ai/dsh-token-meter` README 的原话：**实测压力 ÷ 该路由的模型上下文容量**。

`totalTokens = baseline.tokens + surfaceDeltaTokens`。`baseline.kind === 'usage'` 时是上一次请求的实测用量（含缓存读写与本轮输出），否则是字符启发式（4 字符/token，中文与 JSON Schema 会低估）。

命令是只读的：不写会话日志、不触发模型调用、不改会话状态。它的生命周期（`command/run`、`command/done`）由命令注册表记为纯日志事件。

## 为什么正文是纯 ASCII 英文

命令结果的正文渲染在 `<pre>` 里（`white-space: pre-wrap`，等宽字体）。CJK 是全角，`█░` 这类块字符又比行盒高，两者在这个容器里都会和相邻行挤在一起（实测踩到过）。ASCII 宽度恒为一格，列对齐才算得准，所以正文一律 ASCII：进度条用 `#`/`-`，标签用英文，括号用半角。

两处语言是刻意分开的：**报告正文用英文**（排版原因见上），**斜杠面板里的命令描述用中文**（`查看当前会话的上下文窗口占用`），和中文界面下的内置命令保持一致。Plugin Manager 里的标题/描述中英双语（`locale/en.json`、`locale/zh.json`）。

## 已知限制

- **是估算，不是账单。** 只有 `measured` 时主数字才是实测；分类明细始终是各消息的路由定价，与主数字不同源、不会相等——`By message type` 那行给出节点合计，便于对照。
- **`Tool definitions` 和上面几行的估算口径不同**：它取的是 `contextBreakdown` 投影里的 `toolsTokens`（harness 自己对 tool schema 的 4 字符/token 计价），不是逐消息的路由定价。读不到这个投影时这一行不显示，而不是另估一个数——那时合计也会回落到节点合计。
- **`Compaction trigger` 只陈述默认策略下的触发点**，不代表你的组合里自动压缩已启用。
- **没有上限就不给比例**：会话还没有 `request/context` 记录时，只报已用量并明确说明无法换算。
- 只覆盖当前会话，不含子代理会话。

## 开发时如何让改动生效

以本地目录安装的 bundle 是指向源码目录的 junction，而 HMR 的默认 `ignored` 含 `**/node_modules`——所以**改源码不会热更**。不退出应用换模块代次：

1. 把这个插件行关掉再打开一次（`set_plugin` 传 `include:dsh-command-context`，先 `enabled: false` 再 `true`），Loader 会重新 `import` 模块。
2. 启动前设 `DSH_CONTEXT_LOAD_STAMP=1`，插件每次激活会往 `~/.dsh/tmp/dsh-command-context.loads.log` 追加一行 `时间 rev=N`，据此判断现场跑的是哪一代。默认关闭——插件不会往你的 home 目录写任何东西。
3. 如果戳没前进，才需要**从托盘彻底退出应用**再打开（关窗口只是最小化，主进程还在，模块代次不会换）。

`install_bundle` 对已安装的包会直接返回 `already-installed`；换版本得先 `remove_bundle`，而它会删掉 junction——动手前先备份源码目录。

## 开发

```sh
node --check index.js
node test/report.test.mjs
```

测试用合成数据断言：分类归属（含 memory/skills 拆分、混排不误判）、占用率算术、未知上限分支、正文纯 ASCII、列对齐，以及正文不含解释性文案。

## 许可证

MIT
