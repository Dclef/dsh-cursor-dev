# Cursor 工具详情与 CLI 设置回退：安装副本验收

日期：2026-11-03（Asia/Shanghai）。修复基线：main / e1ef94e / 0.12.10；本记录对应随后纳入 0.12.11 的 transport 补丁。此处记录修复阶段的观测结果，不把发布成功视为运行中 GUI 已自动加载。

## 实际原因

1. 桌面 DSH 使用的 profile 安装了独立的 0.12.7 插件副本，并非源码工作区的链接。其全部 lib 文件与仓库 495f8f2 对应文件一致。先前 0.12.10 的 CLI 名称、输入及输出修复尚未进入这份安装。
2. 对运行中的 DSH GUI 只读取证：settings API 返回 `transport: cli`，面板 HTML 的 bootstrap.settings 却没有 transport，且其 GET 处理没有同步 transportChoice。因此打开后显示 ACP；再保存锁定等其他设置时，界面还可能把旧 ACP 控件值写回文件。
3. [index.js](../../../lib/index.js) 虽然创建了 refreshTransport 回调，却没有把它传入设置路由。保存只落盘，当前 SessionPool 不切换；重启后才读到新值。
4. 延迟的 ACP 模型探测可以让旧 GET 在 CLI 已保存后返回探测前的 ACP 设置快照。文件仍为 CLI，但界面会收到旧值。

## 修改与回归

- [usage.js](../../../lib/usage.js)：bootstrap 携带 transport；GET 同步已保存值，保留未保存草稿；无关 POST 不再清掉 transport 草稿。
- [settings.js](../../../lib/settings.js)：等待模型探测后再读取设置，避免返回旧快照。
- [index.js](../../../lib/index.js)：补齐 refreshTransport 到设置路由的接线。
- [panel-model.test.mjs](../../../test/panel-model.test.mjs)、[settings.test.mjs](../../../test/settings.test.mjs)：新增 7 项面板、设置和时序回归。其中 5 项在对应原生产代码上先验证失败；另 2 项确认缓存写入不会覆盖已保存 transport。
- [transport-wiring.test.mjs](../../../test/transport-wiring.test.mjs)：通过真实 apply 挂载设置路由；原代码保存后 transitions=[]，修复后下一次实际 Pool.run 获得 CliSession，模拟进程 argv 包含 -p，不启动真实 Cursor。

本轮不重写旧日志；0.12.10 的 CLI → 镜像名称、参数、输出及异常证据修复继续保留。

## 完整源码离线回归

在源码仓库根目录运行（Bash）：

```bash
DSH_CURSOR_LIVE_TESTS=0 npm test
```

修复阶段实测：309 项，299 通过、0 失败、0 取消、10 跳过，5736.2718 ms，退出码 0。跳过 3 项真实 Cursor/账户测试及 7 项 Windows 不适用的认证存储测试；不代表 macOS 已验证。

## 针对实际安装副本运行同一组回归

从包含 test 目录的源码仓库运行 [verify-runtime-copy.mjs](verify-runtime-copy.mjs)，把参数换为当前 DSH profile 实际安装的插件绝对路径。脚本将测试模块的 import 指向该安装目录，执行真实被安装的生产模块；不把源码通过当成安装通过。

```bash
node docs/test/2026-11-03/verify-runtime-copy.mjs /absolute/profile/node_modules/dsh-cursor-dev
```

- 更新前安装 0.12.7：54 项，37 通过、17 失败，退出码 1，包含工具名/输入/输出、取消、设置重开及 Pool 切换等缺陷。
- 更新到 0.12.10 加本轮补丁后：同一组 54 项全部通过、0 失败，714.3789 ms，退出码 0。
- 再次比较全部 lib 文件：安装目录与工作区零差异。
- git diff --check：退出码 0。原有未跟踪锁文件未改，未进入提交或发布包。

## 生效边界

修复阶段先逐文件读取、备份，再更新 desktop profile 的实际安装副本；写入前核对漂移，写入后检查 SHA-256。安装操作没有改写操作者设置，未变更 profile 的依赖锁定来源。原始安装路径、备份、日志及逐文件哈希仅在维护者本机保存，不放入公开报告。

更新后再次读取 GUI：HTTP 200，但 bootstrap 仍未包含 transport、GET 修复标记仍不存在；检查时仍有 1 个 Cursor 编码任务运行。因此未重启或热重载，**这次安装检查不等同于 GUI 重启后的真机验收**。

升级后需等待运行任务结束，重启 DSH 并刷新页面。届时应检查首屏 transport=cli、重开及保存其他设置仍为 CLI，新任务的工具卡带有真实名称/参数/输出。历史未保存的工具内容不会自动恢复；运行中的旧任务也不会因为磁盘文件更新而换用新解析器。
