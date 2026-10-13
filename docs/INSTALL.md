# 安装与首次使用

[返回 README](../README.md)

本指南面向希望让 DSH 的父模型调用本机 Cursor CLI 的用户。安装完成后的流程是：**父模型派任务 → Cursor 执行 → 插件返回报告 → 父模型审查和继续处理**。

## 1. 准备 DSH 和 Cursor CLI

需要：

- 可正常对话的 DSH，以及一个支持工具调用的父模型。
- 插件使用的 Node.js 满足 `^22.19.0 || >=24.0.0`。桌面版应检查其自带运行时，终端里的 `node --version` 不一定是桌面程序使用的版本。
- 当前版 Cursor CLI，已完成登录，并有执行任务所需的账号权限、额度和网络连接。
- 原生子智能体入口需要 DSH 的 `subagents`、`agents` 服务；后台运行还需要宿主任务服务。包声明的 DSH 最低版本为 `>=0.2.0-rc.1`，建议使用当前桌面版及其标准 profile。

父模型的 API 配置与 Cursor 登录分别管理。插件使用本机 CLI 的登录状态，无需再向插件填写一份 Cursor API Key。

Windows，在 PowerShell 中按 [Cursor 官方安装说明](https://cursor.com/docs/cli)安装：

```powershell
irm 'https://cursor.com/install?win32=true' | iex
```

macOS / Linux：

```sh
curl https://cursor.com/install -fsS | bash
```

安装完成后，在能够找到 `agent` 命令的终端执行：

```sh
agent login
agent status --format json
```

状态应包含 `"isAuthenticated": true`。如果刚安装后终端找不到 `agent`，重新打开终端再检查。DSH 在启动时探测 CLI，安装 CLI 或改变 PATH 后也需要重启 DSH。

## 2. 选择安装来源

**发布状态（2026-10-13 核对）：** 公共 GitHub 仓库存在，npm 公共源尚未发布 `dsh-cursor-dev`。本轮新增的原生子智能体接入和面板模型锁定仍未从本地发布。GitHub 安装只会取得已推送的内容，不会包含维护者电脑上的未提交修改。

| 你要安装的内容 | 安装来源 |
| --- | --- |
| 已经推送到公开仓库的代码 | `git+https://github.com/Dclef/dsh-cursor-dev.git` |
| 含所需改动的源码目录 | 该目录的绝对路径，例如 `D:/plugins/dsh-cursor-dev` |
| 维护者提供的源码快照或发布包 | `.tgz` 文件的绝对路径，例如 `D:/Downloads/dsh-cursor-dev-0.8.1.tgz` |

表中的本地路径是示例，需要换成实际位置；包名里的版本以收到的文件为准。要试用尚未公开的改动，先取得包含这些改动的源码或安装包。不要期待从公开仓库安装后自动获得尚未发布的功能。

### 桌面用户：通过插件管理安装

1. 打开当前 DSH 的插件管理安装入口。
2. 输入上述 Git 地址，或者源码目录 / 安装包的**绝对路径**。浏览器界面不接受 `./dsh-cursor-dev` 这种相对路径。
3. 检查识别到的包名为 `dsh-cursor-dev`，完成安装并启用。
4. 按提示应用配置。安装或升级后台代码后完整重启一次 DSH，再刷新页面。

插件的 bundle 会声明所需的插件配置；当前源码还包含标准工具 `cursor_subagent` 的配置。普通安装不需要复制维护者的整个 profile，也不需要手工填写维护者电脑上的路径。

### 已配置 DSH CLI 的用户

在你实际使用的 DSH profile 下执行，避免安装到了另一套 profile：

```sh
dsh plugin add "git+https://github.com/Dclef/dsh-cursor-dev.git"
```

本地源码安装，例如 Windows：

```powershell
dsh plugin add "D:/plugins/dsh-cursor-dev"
```

或者在 macOS / Linux：

```sh
dsh plugin add "/home/you/plugins/dsh-cursor-dev"
```

安装收到的包：

```powershell
dsh plugin add "D:/Downloads/dsh-cursor-dev-0.8.1.tgz"
```

终端没有 `dsh` 命令时，使用桌面插件管理即可。不要把在任意项目目录执行 `npm install` 当成已经在 DSH 当前 profile 中启用插件。

## 3. 打开面板并保存模型

从 DSH 的 Cursor 插件入口打开面板，或者访问 **当前 DSH 地址**下的 `/plugins/dsh-cursor-dev/`。

例如 DSH 的地址是 `http://127.0.0.1:19387`，则面板是：

```text
http://127.0.0.1:19387/plugins/dsh-cursor-dev/
```

端口和主机名应以你自己的 DSH 为准。面板应能显示 CLI 安装和登录状态；登录正常后可以查看该账号的模型列表和额度信息。

在包含本轮修改的版本中：

1. 选择想让 Cursor 使用的模型，例如 **Auto**。
2. 如果希望父模型不能通过调用参数覆盖它，勾选 **锁定面板模型**。
3. 点击保存。确认页面显示的是已保存选择与锁定状态。

`auto` 与 `default[]` 都表示 Auto。面板保存的选择与当前已启动任务的模型不是同一项状态；新选择在后续运行时应用。锁定只决定选用哪个模型，不增加账号额度或模型访问权限。

升级后仍看不到锁定选项时，先确认安装的代码确实包含该功能，再完整重启 DSH。仅刷新浏览器不会重新加载已缓存的后台 JavaScript。旧版进程可能在刷新设置时丢弃新字段，因此应在新版进程启动后再保存锁定设置。

## 4. 做一次完整验证

在一个空的测试工作区开始，向 DSH 发送：

```text
/cursor-subagent 创建 cursor-cli-check.txt，内容为 cursor-cli-ok，然后读取它确认内容。只修改这个文件，最后汇报结果。
```

观察以下结果：

- Cursor 实际执行了任务，工作区出现指定文件且内容正确。
- 能打开对应的子会话查看过程；这需要宿主的会话服务。
- 任务完成后，父代理收到 Cursor 的结果并继续回复。

再通过父模型验证工具调用：

```text
请使用 cursor_code，sessionLabel 设为 install-check。
读取 cursor-cli-check.txt，给它追加一行 parent-child-return-ok，
读取确认后返回结果。请检查 Cursor 返回的文件变更，再向我汇报。
```

需要验证续聊时，仍在同一个父会话发送：

```text
请再次使用 cursor_code，sessionLabel 仍为 install-check，
continueSession 设为 true。让 Cursor 说明上一轮做了什么，再核对文件内容。
```

父模型应能调用工具并读取返回值；Cursor 应能读取前一轮的会话上下文。不同父会话的同名标签不是同一个会话。是否真正修改成功应以文件和验证记录为准，不能只看模型说“完成了”。

## 5. 如何让不同父模型使用 Cursor

在 DSH 切换父模型后，只要新模型支持工具调用、当前会话启用了 `cursor_code`，它就能使用同样的接口。插件不要求父模型与 Cursor 属于同一个供应商。

例如：

```text
父模型：DSH 中配置的 DeepSeek / GPT / Claude / 其他支持工具的模型
任务：调用 cursor_code 并传入 task、contextFiles、acceptance
执行模型：Cursor 账号中选择的 Auto 或其他可用模型
返回：工具报告交回调用它的父代理，再由父代理审查和回复用户
```

具体可用的父模型由 DSH 接入决定，具体可用的子模型由 Cursor 账号决定。这不意味着上述每个模型版本都经过本插件逐个实测。

希望默认把开发任务交给 Cursor，可以采用 [README 中的父代理指令](../README.md#三个入口)。没有这些指令时，父模型可能自行完成任务；手动使用 `/cursor-subagent` 可以直接派发。

标准工具 `cursor_subagent` 用于当前源码提供的原生一次性派发与后台任务。需要指定文件、模型、独立标签和续聊时使用 `cursor_code`。后台任务通过 DSH 的 `job_output` / `job_kill` 查看和取消。现在的续聊接口是 `continueSession`，没有实现 Cursor 的 `send_message` 持久收件箱。

## 6. 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 按包名安装返回 404 | npm 公共源尚未发布；改用上面的 Git 来源、已取得的源码目录或安装包 |
| DSH 报告找不到 Cursor CLI | 检查 `agent status --format json`；确认 CLI 位于 DSH 可见的 PATH 或常见安装目录，然后重启 DSH。当前代码不会应用插件配置中的 `command` 覆盖项 |
| 未登录或账号不可用 | 在运行 DSH 的同一操作系统用户下执行 `agent login`，检查账号和网络状态 |
| 面板选了 Auto，实际仍是其他模型 | 当前任务不会中途切换；新版请保存“锁定面板模型”。查看返回的 `modelSource` 与 `requestedModel`，确认是否有显式调用参数 |
| 显示 usage limit | 检查 Cursor 账号额度和模型可用性；更换父模型不会改变 Cursor 账号额度 |
| 父模型没有调用插件 | 确认插件已启用、工具允许使用且父模型支持工具调用；明确要求使用 `cursor_code` 或直接用斜杠命令 |
| 有 `cursor_code`，没有 `cursor_subagent` | 确认所装版本包含原生接入、bundle 配置已应用，以及当前 profile 提供子智能体和任务服务；升级后重启 |
| 更新后页面还是旧的 | 检查更新的是当前 profile 中实际加载的包，再重启 DSH 并刷新浏览器；只修改另一份源码不会自动更新所有安装副本 |
| 续聊没有原来的内容 | 确认父会话、`sessionLabel` 和工作区；检查是否重置过映射、删除过 Cursor 记录，或发生了加载失败回退 |
| 想彻底开始新任务 | 使用新 `sessionLabel`，或对原标签设置 `resetSession:true`；不要只依赖 `continueSession:false` 清空历史 |
| 提交几个任务但只运行一个 | 插件为避免 Cursor 的全局模型状态互相干扰，串行执行任务；后台派发也不会取消这个限制 |
| 旧会话报工具生命周期日志损坏 | 更新镜像写入代码可防止新增同类错误；已经损坏的旧日志仍需要备份后单独修复，升级不会自动改写它们 |

CLI 模型切换与任务执行使用同一个全局锁。进程可以缓存和回收，会话本身则通过 Cursor 持久存储恢复；“新起进程”不等于“全新历史”。

## 7. 维护者分发前检查

修改文档或本地源码不会自动发布给其他用户。分发新的功能前：

1. 核对 [package.json](../package.json) 的版本与兼容性声明，为正式发布更新版本。
2. 运行适当的测试；离线命令见 [README](../README.md#开发与验证)。完整 `npm test` 会包含需要真实账号的 CLI 测试。
3. 在源码目录运行 `npm pack` 或 `pnpm pack`，检查包中包括 `lib/`、`cordis.patch.yml`、README、本文及截图。
4. 使用独立的 DSH profile 验证安装包：安装、登录检测、父模型派发、结果返回、续聊和取消。
5. 将确认过的改动推送并打 tag，或分发检查过的 `.tgz` 包。GitHub 安装需要代码已经推送；npm 包名安装需要实际完成 npm 发布。
6. 在发布说明中明确新增能力、需要重启，以及旧配置的迁移步骤；发布后更新本文的来源与版本说明。

安装包通过文件白名单收录内容，不应包含本机 profile、登录信息、会话日志、探测脚本或依赖目录。正式发布与本地测试快照应有清晰的版本区分。
