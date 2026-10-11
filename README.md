# dsh-cursor-dev

**把 Cursor CLI 当成 DSH 的子智能体来写业务代码：你聊天的模型负责决策，Cursor 负责落地。**

[中文](#中文) · [English](#english)

---

## 中文

### 它做什么

装上之后，你在 DSH 里聊天的那个模型手里多一把工具：**`cursor_code`**。它负责想、负责判断、负责决定怎么改；真正动手的活交给本机的 Cursor CLI，在你的工作区里直接落地 —— 写新功能、重构、修 bug、补测试、跨文件机械改动，都是它的活。

- **按次挑模型** —— `model: "composer-2.5[fast=true]"` 干杂活，`model: "grok-4.7"` 做架构，成本与质量自己权衡；档位后缀（`reasoning_effort`、`fast`）原样透传。
- **真正的续聊** —— `continueSession: true` 复用同一个 Cursor 会话。进程被回收、**甚至 DSH 重启之后也还记得**：会话会从 Cursor 自己的会话库里 `session/load` 回来。
- **看得见** —— 每次调用都返回**逐步工具时间线**和**真实文件 diff**（`{oldText,newText}`），UI 里直接渲染成一张 diff 卡片，而不是让你相信一段总结。
- **独立证据** —— 回合前后各做一次文件指纹，**shell 命令写出来的文件也跑不掉**（这类改动根本不在 ACP 流里）；ACP diff 与指纹结果合并成一份变更清单。
- **额度面板** —— 不用问模型。浏览器打开就有 Cursor 用量/额度面板，还带当前活着的会话和每个会话的执行日志。

### 安装

**前置条件**

- DSH `>= 0.2.0-rc.1`
- Node `^22.19.0 || >=24.0.0`
- 已安装并登录 Cursor CLI（`agent status` 能看到 `✓ Logged in`）。插件会自动在 `PATH`、`%LOCALAPPDATA%\cursor-agent` 等位置找它。找不到时插件**照样挂载**（额度面板和会话列表仍然可用），只是 `cursor_code` 会返回一条说明，告诉你去装 CLI 或改 `command` 配置。

本插件是一个 **DSH bundle**（自带 `cordis.patch.yml`，`package.json` 里声明了 `dsh.bundle`），所以按 bundle 安装即可：

```sh
dsh plugin add dsh-cursor-dev
```

装完重启 DSH，`cursor_code` 就会出现在工具列表里。

**桌面版 / 手动安装**：桌面版 DSH 没有 `dsh` CLI，改成在 profile 里登记——把 `dsh-cursor-dev` 加进 `dsh.profile.bundles`，并在 `dependencies` 里指向本包：

```jsonc
// <profile>/package.json
{
  "dsh": { "profile": { "bundles": [/* …, */ "dsh-cursor-dev"] } },
  "dependencies": { "dsh-cursor-dev": "link:E:\\github project\\dsh-cursor-dev" }
}
```

然后安装依赖并重启。

### `cursor_code` 工具

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `task` | string，**必填** | 完整的编码任务：目标、要改的文件、验收标准写清楚。**子智能体看不到你的对话**，这是它唯一的输入。 |
| `contextFiles` | string[] | 让它先读的文件（工作区相对路径或绝对路径）。比手写一大段上下文便宜得多。 |
| `acceptance` | string | 验收条件/约束，例如「保持公开 API 不变」「收工前跑 pytest」。 |
| `model` | string | 本次任务用的 Cursor 模型，如 `composer-2.5`、`grok-4.7`、`kimi-k3`、`glm-5.2`；支持 `[reasoning_effort=high,fast=true]` 这类后缀。省略则用 CLI 默认。 |
| `mode` | `agent` \| `plan` \| `ask` | 默认 `agent`（会改文件）；`plan` / `ask` 只读。 |
| `continueSession` | boolean | 默认 `false`。`true` 表示接着同一个 Cursor 会话继续，子智能体记得它上一轮做了什么。 |
| `sessionLabel` | string | 给这条对话起个名字，方便在同一个 DSH 会话里并行维护多条独立工作线。默认 `default`。 |
| `resetSession` | boolean | 默认 `false`。清掉本插件记录的那条会话 id，让它无法再 `session/load`（不会删 Cursor 自己的任何数据）。 |
| `workspaceRoot` | string | 子智能体的工作目录，省略则用当前会话的工作目录。 |
| `report` | `summary` \| `detailed` | 默认 `summary`；`detailed` 额外返回思考摘要与更详细的步骤。 |
| `timeoutSeconds` | number | 单回合墙钟预算，默认 `1800`，上限 `7200`。 |

返回：`ok`、`cursorSessionId`、`reused` / `reloaded`、`model`、`mode`、`stopReason`、`durationMs`、`text`（子智能体最终消息）、`steps`（工具时间线）、`changes`（变更清单，标注 `source: "acp" | "fs"` 与 `operation`）、`preview`（真实 `{path, oldText, newText}`）、`reasoning`、`error`。

**它能干什么 / 不该用它干什么**：真正落地的实现工作（写/重构代码、修 bug、加测试、跨文件机械改动）交给它；能自己回答的问题、读文件，用你自己的工具。

### 配置

```jsonc
{
  "model": "",                       // 传给子进程的默认模型；留空用 CLI 默认
  "command": "",                     // 手动指定 Cursor CLI 路径（留空自动探测）
  "maxLiveSessions": 3,              // 池里保持存活的 Cursor 进程数
  "sessionIdleMinutes": 15,          // 空闲多久回收
  "maxScanFiles": 20000,             // 单次文件指纹扫描上限
  "toolName": "cursor_code",         // 注册的工具名
  "usageBaseUrl": "https://api2.cursor.sh",
  "usageUi": true                    // 关掉只影响面板，不影响编码工具
}
```

### 用量 / 额度面板

Cursor 没有任何 CLI 命令能查额度，所以插件自己调它的 dashboard RPC 并把结果host起来。四条**只读**路由：

| 路由 | 内容 |
| --- | --- |
| `GET /plugins/dsh-cursor-dev/` | 自适应 HTML 面板：包含额度、auto 桶、API 桶、计费周期、**当前存活的会话**（点「steps」看执行日志）、以及持久化下来的会话列表。30 秒自动刷新。 |
| `GET /plugins/dsh-cursor-dev/api/usage` | 归一化后的 JSON（`?force=1` 绕过 30 秒缓存） |
| `GET /plugins/dsh-cursor-dev/api/journal?key=<会话键>` | 某条会话的执行日志：逐步时间线 + 原始事件 |
| `GET /plugins/dsh-cursor-dev/status` | 解析到的 CLI 路径、活动会话、已持久化的对话 |

额度通过读取本机 Cursor 自己的凭据（`%APPDATA%\Cursor\auth.json`）调用 `https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` 获得，请求是只读的。**token 不会被记录、不会出现在任何响应里。**

### 数据落盘位置

`%LOCALAPPDATA%\dsh-cursor-dev`（可用环境变量 `DSH_CURSOR_DEV_DATA` 覆盖），里面只有对话索引 `conversations.json`。执行日志在内存里，带 TTL。

### 已知限制

- **Cursor CLI 的模型是全局状态，不是按会话的**（实测：在 A 会话切换模型，没碰过的 B 会话也会变，且跨进程、跨重启留存）。所以本插件的 Cursor 调用是**串行**的：换个模型不会偷偷污染另一条正在跑的工作线。
- Windows 上被回收的 Cursor 子进程可能短暂占用工作目录（`EBUSY`），测试里已做重试。
- 需要至少跑完一个回合，会话才会被 Cursor 落盘，在此之前 `session/load` 会报 `Session not found`；本插件只在确实存在过会话时才去 load。

### 开发与测试

```bash
npm test        # node --test --test-force-exit test/
```

21 个测试，**不需要 DSH**：真实的 Cursor CLI 加上真实插件模块，覆盖模型切换、`continueSession` 复用、**新进程 `session/load` 后仍能记起自己写过什么**、真实 diff、坏模型报错、额度 RPC 及其降级、把路由挂到真实 HTTP 服务上跑一遍、以及「找不到 CLI 时插件照样挂载、只有工具报错」。

---

## English

**Run the Cursor CLI as a child coding agent under your DSH parent model: the model you chat with decides, Cursor does the work.**

### What it does

It gives the model you chat with one more tool: **`cursor_code`**. That model thinks, decides and reviews; the actual code changes happen through the Cursor CLI already installed and signed in on your machine, inside your workspace — new features, refactors, bug fixes, tests, mechanical edits across files.

- **Pick the model per call** — `composer-2.5[fast=true]` for boilerplate, `grok-4.7` for architecture; effort/fast suffixes pass through.
- **Continue a conversation for real** — `continueSession: true` reuses the same Cursor session, and it still remembers after the process is reaped or **DSH restarts** (reloaded from Cursor's own session store via `session/load`).
- **Show its work** — every call returns a per-step tool timeline and the real `{oldText, newText}` file diffs, rendered as a diff card in the UI.
- **Verify independently** — a filesystem fingerprint before and after the turn catches changes the ACP stream never mentioned (shell writes, moves, deletes).
- **Report Cursor usage/quota** — a self-contained dashboard plus a JSON API, with no model tokens spent.

### Requirements

DSH `>= 0.2.0-rc.1`, Node `^22.19.0 || >=24.0.0`, and a logged-in Cursor CLI (`agent status`).

### Install

This package is a DSH bundle (it ships `cordis.patch.yml` and declares `dsh.bundle` in `package.json`):

```sh
dsh plugin add dsh-cursor-dev
```

On the desktop app, which has no `dsh` CLI, register it in your profile instead: add `"dsh-cursor-dev"` to `dsh.profile.bundles` and point `dependencies` at this package (use `"link:<path>"` for a local checkout), install, and restart DSH. `cursor_code` then appears in the tool list.

### Usage

Give `cursor_code` a complete, self-contained `task` — the child does not see your conversation. Point it at the right code with `contextFiles`, state the constraints in `acceptance`, choose a `model` for this job, and pass `continueSession: true` for follow-up work on the same conversation. Use it for real implementation work; use your own tools for reading files and answering questions.

### Notes

The Cursor CLI applies the model **globally** rather than per session, so this plugin serializes Cursor turns to keep concurrent work lines from being affected by a model switch. Usage data is read read-only from Cursor's own local credentials; the token is never logged or returned.

## License

MIT
