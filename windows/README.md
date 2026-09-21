# AAAAGENT Windows 0.1.2


**自助配置：** 编译后运行 `npm run configure-local`（Windows 用 `npm.cmd`），即可填写 DeepSeek/百炼 Key、选择已适配模型、上传自己的参考音频。使用前需在百炼开通对应模型并配置 Key。Harness 与 Codex 必须另装、启动并完成登录或配置，缺失时不能向其转发任务。详见[安装与配置](docs/SETUP.md)。

Windows 桌宠开发与本地运行入口。

- [安装、配置和任务派发](README-WINDOWS.md)
- [本机验证记录](WINDOWS-VALIDATION.md#2026-09-19-windows-update)
- [0.1.2 更新内容](CHANGELOG-WINDOWS.md)

首次离线预览可双击 `Start-Windows.cmd`；配置真实服务后，在 `code/desktop-pet` 执行 `npm.cmd start`。

Windows 0.1.2 接入独立用户情绪、桌宠心情、消息快照和查询页面，并验证旧聊天导入、网页 Key/模型与音色设置。Codex app-server 和 DeepSeek Harness 保留 0.1.1 的真实派发结果，本次工作转交回归 64 项通过。模型、Cubism SDK 和服务凭据需自行配置。Mac 版本的代码与说明不受本次更新影响。

本项目原创内容禁止商用；使用须署名 AAAAGENT、原作者及[项目来源](https://github.com/phoiex/AAAAGENT)。完整条款见 [LICENSE](../LICENSE)。

新增 **记忆 → 导入旧聊天**，操作、模型费用与数据边界见[记忆说明](docs/MEMORY.md#导入旧聊天)。此功能的合成回归与真实 Windows 使用体验分开验证。

新增 **记忆 → 当前情绪**：查看用户与桌宠各自的状态、消息当时的快照、来源及后续分析。参见[情绪说明](docs/MEMORY.md#情绪记录怎样使用)。
