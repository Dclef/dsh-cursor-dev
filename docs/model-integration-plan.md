# Cursor 子智能体与模型接入方案

> 状态：设计建议，尚未修改运行代码。
>
> 目标：保留 `dsh-cursor-dev` 当前基于官方 Cursor CLI 的子智能体能力，评估在同一插件中增加 DSH 原生模型 provider，使用户能在模型选择器中使用 Cursor 账号的模型。

## 一、结论

可以整合为一个插件，但必须区分两条运行通道：

| 通道 | 当前/候选实现 | 谁负责 Agent 循环与工具 | 能否成为 DSH 原生模型 |
| --- | --- | --- | --- |
| 子智能体 | 官方 Cursor CLI，ACP 或 `agent -p` | Cursor | 不需要；已经是子智能体 provider |
| 官方模型通道 | Cursor 官方 CLI / SDK | Cursor | **不能完整实现**：官方没有向第三方 Harness 暴露原始模型接口 |
| 私有模型通道 | `AgentService/Run`，ConnectRPC + Protobuf + HTTP/2 | DSH | 技术上可以，但有明确的条款和账号风险 |

**建议：默认保留并优化官方子智能体；不要默认加入私有 Cursor 模型通道。**

如果用户明确接受账号限制、封禁及协议失效风险，可以把私有通道做成默认关闭的独立实验模块；不建议把它包装成普通、无风险的正式模型 provider。

只把 CLI 的 `ask` 输出注册成模型，虽然能生成文本，却不能满足 DSH 主会话要求：DSH 的工具定义、工具结果、流式 tool-call、上下文与压缩请求都需要由 DSH 管理。CLI 已经消费了自己的 Agent 循环，无法把这些职责交还给 DSH。因此这种“CLI 套壳模型”不是推荐实现。

## 二、现状与可复用基础

当前插件已经具备：

- `lib/native-provider.js`：通过 `subagents.registerProvider()` 注册名为 `cursor` 的子智能体 provider。
- `lib/tool.js`：`cursor_code` 的模型选择、续聊、取消、步骤与真实 diff。
- `lib/cli-runner.js`：官方 `agent -p --output-format stream-json` 通道。
- `lib/models.js`：CLI alias 与 ACP 参数化模型 ID 的归一化。
- `lib/settings.js`：模型目录缓存、禁用项、面板默认模型及 transport 设置。
- `lib/usage.js`、`lib/quota-guard.js`：额度展示与运行前保护。
- `lib/index.js`：工具、子智能体和可选 Web 界面的生命周期装配。

这些代码应继续作为**子智能体平面**。模型接入应新增**模型平面**，而不是把现有 `CursorProvider` 改成 `LlmAdapter` 或让两个通道共享会话。

## 三、推荐架构

```text
dsh-cursor-dev
├── 共享只读基础层
│   ├── CLI 发现、代理与脱敏环境
│   ├── 账号/额度只读信息
│   ├── 模型名称与能力元数据
│   └── 统一设置页、诊断与日志
│
├── 子智能体平面（默认开启，保留现状）
│   ├── 官方 ACP / CLI transport
│   ├── cursor_code + cursor_subagent
│   ├── Cursor 会话池与续聊
│   └── 子会话镜像、步骤、diff、取消
│
└── 模型平面（独立开关、独立 provider ID）
    └── 默认不启用私有 Cursor 通道
        ├── LlmAdapter
        ├── 模型目录注册与发现
        ├── DSH StreamChunk 翻译
        ├── DSH 工具调用与工具结果续跑
        └── 私有协议客户端、凭据与版本适配
```

模型 provider 建议使用 `cursor-llm-experimental`，不要继续占用子智能体的 `cursor` ID。这样路由、日志、设置、错误与测试都能明确区分；同时避免同名插件的 provider 冲突。

## 四、方案 A：官方兼容路线（推荐）

### 做法

1. 保留官方 CLI 子智能体，不把 Cursor 放进 DSH 模型选择器。
2. 借鉴 WorkBuddy 的设置体验，但只管理子智能体：
   - 账号与额度；
   - 可用子智能体模型；
   - 默认模型、传输方式与推理档位；
   - 代理、CLI、运行状态诊断。
3. 子智能体模型通过 `cursor_code` 的 `model` 参数、面板默认模型或 `/cursor-subagent -m` 显式选择，均落在 Cursor CLI 自己的模型命名空间。
4. 用 DSH 原生模型执行规划、工具调度与验收，用 Cursor 子智能体完成编码。

### 优势

- 不读取或重放 Cursor 私有凭据，不调用私有聊天接口。
- 保留官方 Agent 行为，工具、权限与续聊由 Cursor 自己处理。
- 当前大部分实现与测试可以直接保留，升级风险最小。

### 限制

- 不能实现“在 DSH 主会话模型选择器里直接选择 Cursor 模型”。
- 每次委派有 Cursor Agent 启动与执行成本，不能当作低价、逐 token 的 LLM API。

## 五、方案 B：私有协议模型通道（仅实验，不建议默认交付）

WorkBuddy 可借鉴的是 **DSH 模型注册接缝和设置生命周期**，不是 Cursor 的上游协议。WorkBuddy 使用 `PiAiAdapter + OpenAI completions + loopback shim`；Cursor 没有公开 OpenAI completions 端点，不能原样复用。

已有社区实现证明技术路径存在：`greatyao/dsh-connect-cursor` 使用原生 `LlmAdapter` 连接 `agent.v1.AgentService/Run`；`NOirBRight/dsh-llm-cursor` 也提供独立 Cursor 模型 provider。后者明确记录 Cursor 官方人员对该类使用的封禁风险说明。

### 必需模块

1. **`CursorLlmAdapter`**
   - 实现 `providerInfo`、`listModels`、`resolveModel`、`stream`。
   - 在 `ctx.inject(['llm'])` 的可选作用域注册；无 `llm` 服务时子智能体继续工作。
   - 失败必须产生闭合的 DSH `StreamChunk`，不能把协议异常直接泄漏给主循环。

2. **协议客户端**
   - ConnectRPC + Protobuf + HTTP/2。
   - 处理流帧、心跳、背压、半关闭、取消与进程卸载。
   - 客户端版本与 schema 独立适配；不能假定 Cursor 升级后字段不变。

3. **消息与工具桥**
   - DSH system/user/assistant/tool 历史到 Cursor 请求的转换。
   - DSH tool declarations 到 Cursor MCP tool declarations。
   - Cursor 增量到 `block-start` / delta / `block-end` / `finish`。
   - 工具结果必须回到同一个逻辑 Run 或可靠地续跑；只把工具结果拼成新文本不算完整支持。

4. **凭据边界**
   - 优先由官方 CLI 管理登录；私有模块若需额外凭据，必须单独说明。
   - token 不进入 Web 响应、日志、父会话或普通 `settings.json`。
   - 不复制 WorkBuddy 的账号池、自动换号、签到等与 Cursor 无关的功能。

5. **模型目录**
   - 可复用 CLI 目录作为展示参考，但实际 wire model ID 必须由模型通道自己的目录验证。
   - CLI alias、ACP variant、Cursor wire variant 是三种命名空间，不能互相猜测。
   - 上下文窗口、图片、推理档位未知时应标为未知，不能虚构。

### 明确的上线门槛

- 至少完成普通文本流、一次工具调用、连续多次工具调用、工具结果续跑、异常工具结果、长上下文、取消和卸载测试。
- 在真实 DSH 主会话中验证工具由 DSH 执行，而不是 Cursor 私有 Agent 自行执行。
- 真实验证模型、推理档与账单，不能仅验证“能返回文本”。
- 风险说明与启用确认在设置页和 README 同时可见。

## 六、不顺带搬运的 WorkBuddy 功能

- 国内/国际双 provider、账号池、自动换号。
- 签到、福利、积分倍率与活动徽标。
- WorkBuddy 生图/视频、CodeBuddy CLI bridge。
- loopback OpenAI shim（除非未来确有 OpenAI 兼容上游）。
- 私有协议的 channel 指纹修复、自动“继续”等高风险补偿逻辑。

当前 Cursor 插件已有自己的额度与设置界面，没必要为了外观相似而重写为 React。优先复用现有 HTML/HTTP 面板，避免引入一套新的构建链。

## 七、现阶段更值得做的优化

### P0 更正：不要打通 DSH `agentOptions` 到 Cursor 模型

> 这一节替换初版方案里的错误建议。初版误以为 `cursor_subagent` 的 `model` / `reasoning_effort` 尚未接通，属于缺陷。

核对当前宿主（`@deepseek-ai/dsh-tool-subagent` / `@deepseek-ai/dsh-subagent`）后，真实契约是：

- `cursor_subagent` 的 `provider` / `model` / `reasoning_effort` 是 **DSH 的 LLM 路由**：工具会先 `llm.resolveModelInfo(provider, model)` 预检，再经 `agentOptions` 传给子 Agent，用来为"继承父上下文、由 DSH 驱动 LLM 循环"的子智能体选择模型。
- 本插件的 Cursor provider 是 `inheritsParentContext: false` 的外部进程，模型是 Cursor CLI 自己的 alias/variant 命名空间，运行的是 Cursor 的 Agent 循环。DSH 的 LLM 目录根本不认识 `composer-2.5`、`grok-4.7-xhigh` 这类名字。
- 宿主用 `NO_START_CAPABILITIES` / `capabilities.agentOptions: false` 明确告诉工具："这个后端不支持 DSH 侧的 agentOptions/modelSelection"，并在参数出现时于 `start` 之前 fail-closed 拒绝。当前 `native-provider.js` 声明 `agentOptions: false`、显式拒绝该字段，**正是正确防御**，不是遗漏。

因此把 `request.agentOptions.model` 映射到 `resolveModelSelection()` 会造成语义错配：DSH 模型名被当成 Cursor 模型，预检和账单口径都不成立。正确做法是：

- 保持 `agentOptions: false`、`maxDepth: provider-managed`、`cordis.patch.yml` 的既有配置不变。
- 逐任务选模型继续走 `cursor_code` 的 `model`、`/cursor-subagent -m`，或面板默认模型/锁定模型。
- 若要让 `cursor_subagent` 调用方也能指定 Cursor 模型，只能扩展本插件自己的工具参数与 prompt 协议（例如在 task 中显式传 `model`），经 `resolveModelSelection()` 后进入 Cursor CLI；这不是 DSH `agentOptions` 的职责。
- 未来若 Cursor 提供官方原始模型 API、本插件改为 `inheritsParentContext: true` 的 LlmAdapter，才重新评估 `agentOptions` 能力。

### P1：修正模型目录来源混用

ACP 与 CLI 的模型 ID 不完全等价。当前缓存只有一种命名空间时，另一种 transport 不应假装它能够精确匹配。

建议按 transport 分缓存，记录 `account/roster/proxy` 维度的刷新时间与来源；解析失败时保留明确错误，不回退到名称相似的其他模型。

### P1：额度保护按模型与通道细分

现有全局 quota guard 可作为基础，但应区分：

- 面板探测、目录读取；
- 子智能体正式运行；
- 未来模型通道的每次 token 请求。

后台刷新不能触发付费模型测试；余额未知不应被当作余额为零，也不能被当作余额充足。

### P2：统一诊断而不统一会话

面板可以展示“主会话模型 / 子智能体模型 / transport / 当前额度”，但两套会话和生命周期必须分开。模型通道不可复用子智能体的 `SessionPool`，否则 DSH 的工具回传、取消与续聊会混入 Cursor 自己管理的对话。

## 八、实施顺序

1. **第一期（推荐直接做）**：transport 分目录、错误和诊断补齐；保持 DSH `agentOptions` 与 Cursor 模型命名空间隔离，不动模型 provider。
2. **第二期（低风险体验优化）**：设置页分为“账号 / 子智能体模型 / 能力 / 诊断”，复用现有界面。
3. **技术预研（不改默认行为）**：以社区 Cursor LlmAdapter 为参照，确认当前 DSH 版本的工具结果续跑协议；只做协议契约与测试，不启用真实账号调用。
4. **实验期（仅用户另行明确授权）**：独立、默认关闭的私有模型模块；完成全部上线门槛后再决定是否发布。

## 九、验收建议

第一期完成后至少满足：

- `cursor_code` 现有行为与离线回归不变。
- 原生 `subagent` 默认路由不报错；传入 DSH `agentOptions` 时按宿主契约 fail-closed 拒绝，且有测试固定这一行为。
- 面板锁模型、ACP/CLI 差异、取消和续聊均有测试。
- 子智能体的模型选择仍只使用 Cursor CLI 自己的目录与 transport，不借用 DSH LLM 目录。
- 未安装或未登录时，子智能体功能与设置页给出可执行诊断。
- 不读取私有 Cursor token，不发起私有 AgentService 请求。

## 十、外部依据

- WorkBuddy 模型接入：<https://github.com/dingminhua/dsh-connect-workbuddy>
- Cursor 官方输出协议：<https://cursor.com/docs/cli/reference/output-format>
- Cursor 官方人员对私有 provider / proxy 的答复：<https://forum.cursor.com/t/does-using-oh-my-pi-s-cursor-provider-or-an-openai-compatible-proxy-to-the-same-endpoints-violate-cursor-s-tos/167778/5>
- 社区原生 LlmAdapter 参照：<https://github.com/greatyao/dsh-connect-cursor>
- 另一独立 Cursor provider 及其风险说明：<https://github.com/NOirBRight/dsh-llm-cursor>

以上社区代码仅作为协议与架构参照。若实际复制代码，需保留对应 MIT 许可与 NOTICE，并单独审查；本方案不授权默认复制或启用私有接口实现。
