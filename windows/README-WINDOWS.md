# AAAAGENT Windows 0.1.2 开发版

[项目首页](../README.md) · [平台差异](../docs/PLATFORMS.md) · [验证记录](WINDOWS-VALIDATION.md)

Windows 版使用 Electron 桌面窗口和独立 Node.js 后端，支持本地 Live2D 展示、透明置顶、拖动缩放、全身/半身切换、文字输入及网页控制台。源码入口是 **`windows/code/desktop-pet/`**。

2026-09-19 在 Windows 11 x64 / Node 22.14.0 上完成 0.1.2 适配：新增独立情绪状态与网页查询，验证旧聊天导入、自助配置及 Windows 工作转交。完整结果与限制见[本次验证](WINDOWS-VALIDATION.md#2026-09-19-windows-update)。这是源码开发版，没有签名安装器。

## 0.1.2 新功能与升级

在 **控制台 → 记忆 → 当前情绪** 查看用户情绪、桌宠心情、每条消息当时的快照和后续分析。两个主体分别保存；来源被纠正、删除或屏蔽后，相关状态按来源校验失效。未知强度显示“未评估”，不会当作零或中性。文字推测复用现有对话请求，未启用额外后台增强模型。参见[记忆说明](docs/MEMORY.md#情绪记录怎样使用)。

已有安装先退出桌宠，执行第 3 节的 `build:windows`、`refresh:runtime` 再启动。保留原 `.local/`、外部 Key 和本地模型资源；新情绪表自动创建，旧聊天不会补造历史快照。旧聊天导入仍从 **记忆 → 导入旧聊天** 单独启动。

## 本次自助配置更新 / Self-service setup

完成后端编译后可先运行 `npm.cmd run configure-local` 打开本机网页，无需预先手写 Key/音色 JSON。网页支持 DeepSeek 与百炼 Key、模型预设、自己的参考音频和两次独立费用确认；先开通对应百炼模型并确认账户余额，再保存 Key。已有配置从运行控制台修改。完整步骤及英文见 [Setup](docs/SETUP.md)。0.1.1 的 Windows ACL/文件身份修复继续保留；本次设置测试 49 项通过、4 项 Unix 专属检查跳过，详见验证记录。

After backend compilation, `npm.cmd run configure-local` opens local first-run setup without pre-existing keys, voice metadata or JSON. Enable the matching Bailian models before use. See [English setup](docs/SETUP.md#english). Windows ACL/file identity fixes are retained. This update passed 49 setup tests, with four Unix-specific checks skipped; setup and emotion regressions are available through the npm commands in the validation report.

## 1. 准备环境和资源

- Windows x64；推荐 Node.js 24 LTS，最低 22.12.0，需带 npm。
- 能访问 npm registry 和 GitHub Releases。SQLite、Electron、唤醒组件需要各自的 Windows 二进制依赖。
- 自行准备有权使用的 Live2D 模型及 Cubism SDK。公开仓库不包含私人模型、SDK、密钥和账号数据库。

把完整资源放在以下位置，保留模型引用的纹理、物理、动作、表情和授权声明：

```text
windows/code/desktop-pet/desktop/
  assets/local-model/pet.model3.json
  assets/local-model/presets.json
  assets/local-model/parameter-map.json
  assets/local-model/…模型引用的其他文件
  vendor/cubism/Core/live2dcubismcore.min.js
  vendor/cubism/Framework/src/…
```

从旧私有包迁移时，将它的 `desktop/config/parameter-map.json` 复制到上述 `assets/local-model/parameter-map.json`，使角色实际映射优先于公共默认值。**只迁移资源和经过核对的配置，不要用旧 Mac 源码或 node_modules 覆盖 Windows 目录。**

## 2. 启动离线预览

在仓库根目录打开 PowerShell：

```powershell
cd windows/code/desktop-pet
npm.cmd ci
npm.cmd run dev
```

也可以双击 `windows/Start-Windows.cmd`。首次运行安装依赖，之后重新构建后端和界面。

离线预览会加载实际模型，文字回复是 `Offline preview received: …`。它不读取供应商凭据、个人聊天或微信登录状态；语音和控制台需要正式配置。预览聊天不持久化，显示大小、位置和按键偏好保存在 Electron 用户目录中。

点击角色聊天，拖动角色移动窗口，使用大小手柄及全身/半身按钮调整显示。按住发言的按键仅在窗口有焦点且焦点不在输入框时生效。`Ctrl+R` 刷新界面，`Ctrl+Shift+I` 打开开发工具，通过「退出」或 `Alt+F4` 关闭。

## 3. 配置真实服务

先执行 `npm.cmd run build:windows`。以 `config/providers.example.json` 为模板，在源码包外建立 `config.local.json`，填写自己的服务配置、外部凭据路径、授权音色 ID 和真实音色登记文件。JSON 路径使用 `C:/…` 或双反斜杠。

旧 Mac 绝对路径、音色 `credentialRef` 和激活哈希不能原样复用。音色引用与凭据实际路径绑定；迁移时更新路径绑定，保留真实音色、模型、端点和登记证据。

```powershell
node tools/private-file.mjs "C:/AAAAGENT-secrets/deepseek.key"
node tools/private-file.mjs "C:/AAAAGENT-secrets/dashscope.key"
node tools/voice-reference.mjs "C:/AAAAGENT-secrets/dashscope.key"
npm.cmd run configure -- "C:/AAAAGENT-secrets/config.local.json" --activate
npm.cmd start
```

首配检查资源、Windows ACL、音色元数据及运行指纹，在 `windows/.local/` 创建新数据，不覆盖已有配置。`--activate` 允许后续真实服务调用；发送文字或使用语音可能产生供应商费用。启动不会自动迁入旧聊天或旧微信账号。

点击「控制台」打开当前后端的认证管理页面。地址和令牌随会话生成，不要保存旧地址或公开分享完整链接。

修改源码或本地模型参数后，先退出桌宠，再执行：

```powershell
npm.cmd run build:windows
npm.cmd run refresh:runtime
npm.cmd start
```

刷新会备份配置及激活文件，更新运行指纹，并保留记忆、供应商设置和激活状态。

## 4. 本地模型参数

可以在被 Git 忽略的 `desktop/assets/local-model/parameter-map.json` 中添加可选的 `parameterOverrides`，例如 `"parameterOverrides": { "YOUR_MODEL_SWITCH": 1 }`。保留文件中已有的头部、嘴型映射，用模型的实际参数 ID 替换示例名称。

覆盖值必须是有限数字，且位于模型声明的参数范围内；每帧都会应用。适合固定本地外观开关，不适合覆盖口型等需要连续动画的参数。具体模型参数、素材和私人配置不提交到公共仓库。

## 5. Windows 任务派发（沿用 0.1.1 适配器）

### Codex

安装并登录 Windows Codex。在桌宠任务卡中选择已有的本地 Codex 任务，核对正文后确认发送。Windows 适配器使用官方 `codex app-server --stdio` JSONL 接口完成会话读取、恢复、发送和回执查询，不再依赖 `/Applications/Codex.app` 或 Unix socket。

程序优先查找 `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`，其次查找 PATH 中的 `codex.exe`。自定义安装可在启动桌宠前设置：

```powershell
$env:PET_CODEX_EXECUTABLE = "C:/your/codex.exe"
# 仅使用自定义配置目录时设置；默认是 ~/.codex
$env:CODEX_HOME = "C:/your/codex-home"
npm.cmd start
```

适配器继承已有线程的模型和权限设置。发送响应丢失会保留为“结果未知”，不自动重发。需要额外命令/文件审批或交互提问的任务，请回到 Codex 处理；桌宠没有这类审批界面，会拒绝命令/文件审批；可在 Codex 中重新发起需要批准的操作。独立 app-server 会话产生的消息可能需要在 Codex 中重新打开任务才能显示。

### DeepSeek Harness

仓库自带 Harness 接入代码和工作预设；Harness 引擎是单独安装的官方组件。本机已验证 `@deepseek-ai/dsh@0.1.5-rc.2`，运行它需要 Node.js 24.14 或更高版本。以下命令从本 README 的代码目录运行：

```powershell
$harnessInstall = "$env:LOCALAPPDATA/AAAAGENT/harness"
$env:DSH_HOME = "$env:LOCALAPPDATA/AAAAGENT/dsh-home"
$env:PET_HARNESS_HOME = "$env:LOCALAPPDATA/AAAAGENT/harness-service"
npm.cmd install --prefix "$harnessInstall" @deepseek-ai/dsh@0.1.5-rc.2
npm.cmd run build
node tools/prepare-harness.mjs "$env:DSH_HOME" "$env:PET_HARNESS_HOME"
node "$harnessInstall/node_modules/@deepseek-ai/dsh/lib/bin.js" web --no-open --port 19372 > "$env:PET_HARNESS_HOME/web.log" 2>&1
```

最后一条命令持续运行。打开自己电脑上 `web.log` 的本地链接，在 Harness 原生页面配置 DeepSeek 凭据。该日志含登录令牌，不要分享；准备工具会为其设置 Windows 私有 ACL。已有的自定义工作预设不会被覆盖。

另开 PowerShell，进入代码目录，设置与上面相同的 `DSH_HOME`、`PET_HARNESS_HOME`，然后执行 `npm.cmd start`。在桌宠项目索引选择真实 Windows 工作目录，选择 Harness、确认任务，再查看任务回执。`DSH_HOME` 是引擎数据/预设目录，`PET_HARNESS_HOME` 是包含 `web.log` 和 `workspace` 的服务目录，两者用途不同。

## 6. 验证和排障

```powershell
npm.cmd run test:windows
npm.cmd test
npm.cmd run test:release
npm.cmd run test:stress
npm.cmd run test:windows:ui
npm.cmd run doctor
```

UI 检查需要实际模型与 SDK，其他测试使用合成数据。`doctor` 检查本地文件是否齐备；账号、云服务和设备请在配置后试用。

| 现象 | 处理方式 |
| --- | --- |
| PowerShell 拒绝 npm.ps1 | 使用 `npm.cmd`，不必修改全局执行策略。 |
| 出现 /mnt/c、WSL 提示或唤醒平台不支持 | 检查 `npm.cmd config get script-shell`。本目录 `.npmrc` 使用 `cmd.exe`；如果环境变量覆盖了它，在当前终端设置 `$env:npm_config_script_shell=$env:ComSpec`。 |
| better_sqlite3.node is not a valid Win32 application | 原生依赖可能被 Bash/WSL 安装成 Linux 版本。确认使用 Windows Node 和 cmd.exe 后重新执行 `npm.cmd ci`。 |
| Electron 下载失败 | 检查 GitHub Releases 连通性。Electron 下载器可使用 `ELECTRON_GET_USE_PROXY=1` 和 `GLOBAL_AGENT_HTTP_PROXY`；不要把个人代理地址提交到仓库。 |
| 首配提示凭据不私密 | 对自己选择的凭据执行 `tools/private-file.mjs`，不要跳过 ACL 或文件身份检查。 |
| 修改后提示运行文件变化 | 退出桌宠，重新构建并执行 `refresh:runtime`。 |
| 异常终止后有 backend.lock | 确认锁内 PID 对应后端已退出，再备份锁文件后重启；不要删除仍在运行的后端的锁或业务数据库。正常退出会等待后端清理。 |

## 可用范围

- 本次验证覆盖 Windows 原生依赖、模型渲染、隔离的 preload、真实云端文字回复与 TTS 音频生成、窗口布局、ACL 及本地数据库读写。
- 实体麦克风/摄像头、云端 ASR、扬声器实际效果、唤醒准确率、微信登录投递需单独验收。
- 唤醒模型需另放在 `windows/.local/data/wake-models/` 并通过指纹校验；默认不开启持续监听。
- Windows Codex 与原生 Harness 均已实测“准备任务 → 确认 → 接收 → 完成回执”。实测范围为隔离目录中的简单文字任务。Harness 默认服务目录仍是 `%APPDATA%/DeepSeek Harness`，新安装可按上文指定。
- Windows ARM64 未验证。后端使用系统 Node 的 ABI，不能用 Electron ABI 的 SQLite 文件替代。

修改入口：界面见 `desktop/main.mjs`、`desktop/style.css`；渲染见 `desktop/cubism-renderer.mjs`；窗口及权限见 `desktop/electron/main.mjs`；通信及退出见 `desktop/electron/transport.mjs`。

## English

Use the separate `windows/code/desktop-pet` tree with Windows x64 and Node.js 24 LTS (minimum 22.12). Bring your authorized rig and Cubism SDK, then run `npm.cmd ci` and `npm.cmd run dev`. The preview echoes input offline. The local `.npmrc` prevents a global Bash/WSL script-shell setting from installing Linux native modules into this Windows project.

For real services, run `npm.cmd run build:windows`, prepare external configuration and restricted credential files, rebind genuine voice metadata to the Windows path, configure with `--activate`, then run `npm.cmd start`. Quit before rebuilding and run `npm.cmd run refresh:runtime` to register changes without losing personal data. Optional `parameterOverrides` stay in the ignored local mapping. See the [validation record](WINDOWS-VALIDATION.md#2026-09-19-windows-update) for measured results and limits.

Windows 0.1.1 adds official Codex app-server dispatch and native Harness work with drive-qualified directories. Both were exercised through the real confirmation/receipt workflow. Harness is an external installation; use the same DSH_HOME and PET_HARNESS_HOME in both processes. Interactive tool approvals must be handled in the native application. macOS source and documentation are unchanged.

Windows 0.1.2 adds independent emotion states and **Memory → Current emotion**, with frozen message snapshots and source invalidation. Unknown intensity stays unknown. It also validates chat import and web-based key/model/voice setup. No additional background emotion model is enabled.
