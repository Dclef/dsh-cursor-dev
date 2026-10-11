# dsh-cursor-dev

**一句话：你聊天的那个模型负责想，本机的 Cursor CLI 负责写代码。**

![Cursor 面板：额度、子智能体模型与会话](screenshots/panel-zh.png)

[中文](#中文) · [English](#english)

---

## 中文

### 这个插件是干嘛的

装好之后，你在 DSH 里聊天的那个模型（父模型）手上会多一把工具：**`cursor_code`**。

它的分工是这样的：

- **父模型**：听懂你要什么、决定怎么改、拆任务、验收。
- **Cursor CLI**：在你自己的工作区里真的动手——建文件、改代码、跑命令。

你不用记任何参数。直接在对话里用人话说就行：

> 帮我把登录页加上验证码，样式跟注册页保持一致，改完把测试跑一遍。

父模型自己会判断要不要派给 Cursor，并把任务写全（要改哪些文件、验收标准是什么）再递过去。派活的活它干，你只看结果。

### 三步用起来

**第一步：装好并登录 Cursor CLI**（插件不替你做这一步，只负责告诉你缺哪一步）

```sh
# Windows PowerShell
irm 'https://cursor.com/install?win32=true' | iex

# macOS / Linux
curl https://cursor.com/install -fsS | bash

agent login                  # 会打开浏览器授权
agent status --format json   # 看到 "isAuthenticated": true 就成了
```

没装或没登录也不用慌：插件照常挂载，面板会直接告诉你缺的是哪一步、要跑哪条命令。

**第二步：装插件**

```sh
dsh plugin add dsh-cursor-dev
```

桌面版没有 `dsh` 命令，就在 profile 里登记：

```jsonc
// <profile>/package.json
{
  "dsh": { "profile": { "bundles": [/* …, */ "dsh-cursor-dev"] } },
  "dependencies": { "dsh-cursor-dev": "file:E:/github project/dsh-cursor-dev" }
}
```

装完**重启 DSH**，`cursor_code` 就出现在工具列表里了。

**第三步：开始派活**

就这么说：

| 你想干什么 | 直接这么说 |
| --- | --- |
| 让它写功能 | 「让 Cursor 把 XX 实现了，验收标准是 YY」 |
| 接着上一轮改 | 「让它继续，把测试也补上」（同一个 Cursor 会话，它记得自己改过什么） |
| 换个更强的模型 | 「这次用 grok-4.7 来做架构设计」 |
| 只要方案，别动代码 | 「让它先出个方案，别改文件」 |
| 指定它先看哪些文件 | 「让它看 `lib/index.js` 和 `lib/tool.js` 再动手」 |
| 看它在干什么 | 打开 **设置 → Cursor 子智能体** |

一个完整的例子（可以直接复制改改）：

```text
用 cursor_code 给这个工作区加一个「导出 CSV」的功能：
- 入口放在 src/export/csv.ts，导出函数签名保持和 json 导出一致
- 相关文件：src/export/json.ts、src/types.ts
- 验收标准：npm test 全绿，并且新增一个 csv 导出的单测
- 跑完告诉我改了哪些文件
```

### 它凭什么比「让模型自己写」靠谱

- **看得见它干了什么** —— 每次调用都返回逐步的工具时间线和**真实文件 diff**（改前/改后原文），UI 里直接渲染成 diff 卡片。不是让你相信一段总结。
- **改了文件它赖不掉** —— 回合前后各扫一遍文件指纹，**用 shell 命令写出来的文件也算**（这种改动压根不会出现在 ACP 流里）。
- **会话能续，DSH 重启也能续** —— `continueSession: true` 复用同一个 Cursor 会话；进程被回收、甚至 DSH 重启之后，会话还能从 Cursor 自己的会话库里 `session/load` 回来，它记得自己上一轮改了什么。
- **按活挑模型** —— 杂活用便宜的（composer-2.5），架构用贵的（grok-4.7），档位后缀 `[reasoning_effort=high,fast=true]` 原样透传。嫌每次写麻烦？面板里选一次，以后默认就用它。

### 面板：设置 → Cursor 子智能体

不用问模型、不用翻日志，这些都在面板里（默认中文，右上角一键切 English）：

![设置里的 Cursor 子智能体](screenshots/panel-zh-settings.png)

- **额度** —— 包含额度、Auto 桶、API 桶、本期花费、计费周期，30 秒自动刷新。
- **子智能体模型** —— 下拉列出 CLI 报出的全部模型，点保存就生效，**下一次调用就用它**，不用重启。留空 = 跟随 CLI 默认（Auto）。
- **会话** —— 上半张表是当前活着的进程（会话 id、模型、模式、回合数、**正在干什么**）；下半张表是历史会话。**点会话键**展开那一轮的执行日志：任务、模型、逐步时间线。

额度数据是从本机 Cursor 自己的凭据（`%APPDATA%\Cursor\auth.json`）只读调它的 dashboard RPC 拿的，**token 不会被记录、不会出现在任何响应里**。你也可以直接开 <http://127.0.0.1:19387/plugins/dsh-cursor-dev/> 看同一个页面（DSH 桌面版运行时）。

### 想知道细节？`cursor_code` 的参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `task` | string，**必填** | 完整任务：目标、要改什么、验收标准。**子智能体看不到你的对话**，这是它唯一的输入。 |
| `contextFiles` | string[] | 让它先读的文件，比手写一大段上下文便宜得多。 |
| `acceptance` | string | 验收条件／约束，例如「保持公开 API 不变」「收工前跑 pytest」。 |
| `model` | string | 本次任务用的模型，如 `composer-2.5`、`grok-4.7`、`kimi-k3`、`glm-5.2`。省略则用面板里选的（再退回到 CLI 默认）。 |
| `mode` | `agent` \| `plan` \| `ask` | 默认 `agent`（会改文件）；`plan` / `ask` 只读。 |
| `continueSession` | boolean | 默认 `false`；`true` = 接着同一个 Cursor 会话继续。 |
| `sessionLabel` | string | 给这条对话起个名字，方便并行维护多条工作线。默认 `default`。 |
| `resetSession` | boolean | 清掉本插件记的会话 id，让它没法再 load（不会删 Cursor 自己的数据）。 |
| `workspaceRoot` | string | 子智能体的工作目录，省略则用当前会话的工作目录。 |
| `report` | `summary` \| `detailed` | 默认 `summary`；`detailed` 额外给思考摘要和更细的步骤。 |
| `timeoutSeconds` | number | 单回合墙钟预算，默认 `1800`，上限 `7200`。 |

返回：`ok`、`cursorSessionId`、`reused` / `reloaded`、`model`、`mode`、`stopReason`、`durationMs`、`text`（子智能体的最终消息）、`steps`（工具时间线）、`changes`（变更清单，标注 `source: "acp" | "fs"` 和 `operation`）、`preview`（真实 `{path, oldText, newText}`）、`reasoning`、`error`。

**该用它就别客气**（真正落地的实现工作：写/重构代码、修 bug、加测试、跨文件机械改动）；**不该用它就别浪费**（能自己回答的问题、读文件——用你自己的工具）。

### 配置

```jsonc
{
  "model": "",                       // 传给子进程的默认模型；留空用 CLI 默认。面板里选的优先于这项
  "command": "",                     // 手动指定 Cursor CLI 路径（留空自动探测）
  "maxLiveSessions": 3,              // 池里保持存活的 Cursor 进程数
  "sessionIdleMinutes": 15,          // 空闲多久回收
  "maxScanFiles": 20000,             // 单次文件指纹扫描上限
  "toolName": "cursor_code",         // 注册的工具名
  "usageBaseUrl": "https://api2.cursor.sh",
  "usageUi": true                    // 关掉只影响面板，不影响编码工具
}
```

面板里改的东西存在插件数据目录的 `settings.json`，**不写你的 profile 配置**：改模型、改语言都立刻生效，不用重启。

### 数据落在哪

`%LOCALAPPDATA%\dsh-cursor-dev`（可用环境变量 `DSH_CURSOR_DEV_DATA` 覆盖），只有两个文件：对话索引 `conversations.json`、面板设置 `settings.json`。执行日志在内存里，带 TTL。

### 几个坑（提前说清楚）

- **Cursor CLI 的模型是全局的，不是按会话的**（实测：在 A 会话切模型，没碰过的 B 会话也会变，而且跨进程、跨重启留着）。所以本插件的调用是**串行**的，免得切模型污染另一条工作线。
- Windows 上被回收的 Cursor 子进程可能短暂占着工作目录（`EBUSY`），测试里已做重试。
- 会话至少跑完一个回合才会被 Cursor 落盘，在那之前 `session/load` 会报 `Session not found`；本插件只在确实存在过会话时才去 load。

### 开发与测试

```bash
npm test        # node --test --test-force-exit "test/**/*.test.mjs"
```

74 个测试、6 个文件，**不需要 DSH**：真实的 Cursor CLI + 真实插件模块，覆盖模型切换、`continueSession` 复用、**新进程 `session/load` 后仍记得自己写过什么**、真实 diff、坏模型报错、额度 RPC 及其降级、把路由挂到真实 HTTP 服务上跑一遍、「**webServer 还没就绪时一条路由都不许挂、就绪后五条全挂上**」、「找不到 CLI 时插件照样挂载、只有工具报错」、返回值必须能无损序列化（否则一次成功的运行会被宿主当成失败丢掉），以及面板这一侧：模型列表解析与缓存、设置的读/合并/原子写、面板选择与 profile 配置的优先级、`settings` 路由、`agent status --format json` 的登录状态解析与 60 秒缓存（含超时与未登录两种降级），还有浏览器半边的设置页与新装引导卡片（含**开机竞态**的回归测试）。

---

## English

**Run the Cursor CLI as a child coding agent under your DSH parent model: the model you chat with decides, Cursor does the work.**

### What it is

After installing, the model you chat with gets one more tool: **`cursor_code`**. That model plans, decides and reviews; the Cursor CLI already installed on your machine does the actual editing inside your workspace.

You do not have to remember any parameter — just say what you want in plain language:

> Add a CAPTCHA to the login page, keep the styling consistent with the signup page, and run the tests when you're done.

The parent model decides whether to delegate, writes the task out in full (which files, what "done" means) and hands it over.

### Three steps

**1. Install and sign in to the Cursor CLI**

```sh
# Windows PowerShell
irm 'https://cursor.com/install?win32=true' | iex
# macOS / Linux
curl https://cursor.com/install -fsS | bash

agent login                  # opens the browser
agent status --format json   # expect "isAuthenticated": true
```

A missing or signed-out CLI never takes the plugin down: the panel tells you which step is missing and prints the command that fixes it.

**2. Install the plugin**

```sh
dsh plugin add dsh-cursor-dev
```

On the desktop app (no `dsh` CLI), register it in your profile: add `"dsh-cursor-dev"` to `dsh.profile.bundles` and point `dependencies` at this package, then install and **restart DSH**.

**3. Delegate**

| What you want | Just say |
| --- | --- |
| Write a feature | "Have Cursor implement XX, done means YY" |
| Keep going on the same work | "Let it continue and add the tests too" (`continueSession`) |
| A stronger model this time | "Use grok-4.7 for the architecture" |
| A plan, no edits | "Have it propose a plan without touching files" (`mode: plan`) |
| Point it at files | "Have it read `src/a.ts` first" (`contextFiles`) |
| Watch it work | Open **Settings → Cursor child agent** |

### Why it beats "just let the model write it"

Every call returns a step-by-step tool timeline and the **real `{oldText, newText}` diffs**, rendered as a diff card — you verify, you don't trust a summary. A filesystem fingerprint before and after the turn catches changes the ACP stream never mentions (shell writes, moves, deletes). `continueSession: true` keeps the same Cursor conversation, and it survives a process reap **and a DSH restart** (`session/load`). Models are picked per job, or once in the panel.

The panel (**Settings → Cursor child agent**, Chinese by default with a one-click English switch) shows quota, live sessions with what each is doing, durable conversations (**click a key for the run journal**) and the model picker. Usage comes read-only from Cursor's own local credentials; the token is never logged or returned. The same page is served at `http://127.0.0.1:19387/plugins/dsh-cursor-dev/`.

### Parameters, if you want them

`task` (required, the child sees only this), `contextFiles`, `acceptance`, `model`, `mode` (`agent` / `plan` / `ask`), `continueSession`, `sessionLabel`, `resetSession`, `workspaceRoot`, `report` (`summary` / `detailed`), `timeoutSeconds` (default 1800, max 7200). Use it for real implementation work; use your own tools for reading files and answering questions.

### Notes

The Cursor CLI applies the model **globally**, not per session, so this plugin serializes turns to keep a model switch from affecting another work line. Panel choices are stored in the plugin's own data directory (`%LOCALAPPDATA%\dsh-cursor-dev`), never in your profile config, and take effect on the next call. Routes: `/plugins/dsh-cursor-dev/` (dashboard), `/api/usage`, `/api/journal`, `/api/settings` (the only writable one) and `/status`.

### Development

```bash
npm test        # 74 tests, 6 files, no DSH required
```

## License

MIT
