# dsh-command-context

[English](README.md) | 中文

给 **DeepSeek Harness** 加一个 `/context` 斜杠命令：在会话里输入它，就能看到**当前会话的上下文窗口占用**——用了多少、还剩多少、提示词里各部分各占多大。

参考 Claude Code 的 `/context`，但数字全部来自 Harness 自己的口径，不另起一套统计。

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

`/context top [N]` 会额外列出最大的几个表面节点——「上下文到底被谁吃了」：

```
Largest nodes
  read            41.6k  turn 4
  pwsh            22.8k  turn 7
  assistant       18.4k  turn 9
  grep            12.0k  turn 2
  user             8.1k  turn 5
```

工具结果用产生它的工具名标注（从 `tool/call` 解析），一眼能看出是不是某一个输出吃掉了上下文。`N` 默认 5，上限 20。

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
| 分类明细 | `measure().nodes` 逐个按节点归类 |
| 工具定义 | `ctx.sessionProjections` 的 `contextBreakdown` 投影里的 `toolsTokens` |
| Unaccounted | 表头那个分母（实测压力）减去上面所有已归类的行 |
| Largest nodes | `measure().nodes` 按 token 降序；工具结果用对应 `tool/call` 事件里的工具名标注 |
| 压缩触发点 | `min(W × ratio, W − maxTokens − headroom)`：能读到压实后端自己的策略就用真实的，读不到才用 `compaction-basic` 默认值并标注 `(default policy)` |

所有行共用**一个分母**（实测压力），所以整张表永远加得到表头那个数；两套估算解释不掉的差额落到 `Unaccounted`，而不是留给读者自己去减。

占用率口径照 `@deepseek-ai/dsh-token-meter` README 的原话：**实测压力 ÷ 该路由的模型上下文容量**。

`totalTokens = baseline.tokens + surfaceDeltaTokens`。`baseline.kind === 'usage'` 时是上一次请求的实测用量（含缓存读写与本轮输出），否则是字符启发式（4 字符/token，中文与 JSON Schema 会低估）。

命令是只读的：不写会话日志、不触发模型调用、不改会话状态。它的生命周期（`command/run`、`command/done`）由命令注册表记为纯日志事件。

## 为什么正文是纯 ASCII 英文

命令结果的正文渲染在 `<pre>` 里（`white-space: pre-wrap`，等宽字体）。CJK 是全角，`█░` 这类块字符又比行盒高，两者在这个容器里都会和相邻行挤在一起（实测踩到过）。ASCII 宽度恒为一格，列对齐才算得准，所以正文一律 ASCII：进度条用 `#`/`-`，标签用英文，括号用半角。

两处语言是刻意分开的：**报告正文用英文**（排版原因见上），**斜杠面板里的命令描述用中文**（`查看当前会话的上下文窗口占用`），和中文界面下的内置命令保持一致。Plugin Manager 里的标题/描述中英双语（`locale/en.json`、`locale/zh.json`）。

## 已知限制

- **是估算，不是账单。** 只有 `measured` 时主数字才是实测；分类明细是路由定价/启发式，与主数字不同源——`Unaccounted` 就是这段差额，它不是一个类别，也不是算错了。主数字本身是启发式时（拿不到可复用的 provider 用量），整张表正好加平，`Unaccounted` 会消失。
- **`Tool definitions` 和上面几行的估算口径不同**：它取的是 `contextBreakdown` 投影里的 `toolsTokens`（harness 自己对 tool schema 的计价），不是逐消息的路由定价。读不到这个投影时这一行不显示，那部分占比会落进 `Unaccounted`。
- **`Compaction trigger` 读不到压实后端自己的策略时会标注 `(default policy)`**；两种情况都不代表你的组合里自动压缩已启用——完全找不到压实后端时，这一行整行不显示。
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
