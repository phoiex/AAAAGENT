# 安装与配置 / Setup

[项目首页](../README.md) · [English](#english)

## 编译后即可打开首次设置

这是源码开发版。首次设置不要求已有 Key、音色或 JSON 配置；完整桌宠运行仍需自己有权使用的 Live2D 模型、Cubism SDK 和本机应用构建。供应商账户、外部执行器、素材与订阅均不随包提供。

从本版本的 `code/desktop-pet/` 目录运行：

```sh
npm ci
npm run build
npm run configure-local
```

Windows PowerShell 使用 `npm.cmd`；系统和桌面构建要求见 [Windows 安装说明](../windows/README-WINDOWS.md)。Mac 要求 Node.js 20.19+；原生桌面另需 Swift/Xcode Command Line Tools。保留设置窗口，打开它显示的本机链接。链接含会话授权，不要截图公开或转发。首次入口只启动本地设置服务，不会打开设备、登录账户或自动调用模型。已有配置时使用原桌宠入口，在控制台“模型与声音”中修改。

## Key、模型和自己的参考音频

API Key 按完整凭据保存与发送，兼容带点号等新格式；只清除首尾粘贴空白，不截断内容。不限制旧前缀，保留非空、长度与请求头安全检查，继续拒绝内部空白或控制字符。已被旧版拒绝的 Key 可更新后重新保存；保存后自动测试一次连接，每个已保存条目也可点击“测试连接”。测试只读取对应供应商的模型目录，不生成内容；成功显示“连接测试通过”，失败直接显示已隐藏敏感信息的报错。测试失败保留 Key，刷新页面不会重新测试。百炼测试使用当前适配的北京接口；具体模型仍需开通。

- 文本对话及相关文字处理使用 **DeepSeek** Key。ASR、多模态和 **百炼托管 MiniMax** 使用 **阿里云百炼** Key。
- 先在[百炼控制台](https://bailian.console.aliyun.com/)开通要使用的模型，再按[官方说明获取 Key](https://help.aliyun.com/zh/model-studio/get-api-key)。**调用前请确认模型已开通、账户余额充足，再保存 Key 并试用。** DeepSeek Key 在[官方控制台](https://platform.deepseek.com/api_keys)管理。
- 在本机页显式保存 Key。密钥放在项目外按安装目录区分的受限文件中，网页只得到引用和状态，不回显原值。每次保存生成新条目，旧条目及旧音色绑定保留；在各模型模块手动选择对应凭据，再保存设置。选择下拉框本身不发送请求。
- 可以使用已适配的系统音色，也可上传自己有权使用的参考 MP3/M4A/WAV：10 秒至 5 分钟、最多 20 MB。网页在本机转换为单声道 PCM WAV，服务端独立核验格式和时长。上传先保存在本地；只有之后明确确认创建才发到百炼流程。系统音色不要求复刻。
- MiniMax Turbo 与 HD 始终显示为可配置型号。音色设置分为准备方案、确认创建、试听和首次正式启用；完整合成成功后登记为可选音色。新登记不会自动替换当前音色。

页面分别显示两次费用确认。按[百炼 MiniMax 文档](https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api)，Turbo 每万计费字符 2 元，HD 3.5 元；复刻试听按字符计费，克隆音色首次正式合成另收一次 9.9 元。以调用时供应商规则和账单为准。共用账本记录本地费用估算，默认不设累计上限。没有勾选本次费用确认时不会发起对应云请求。

403 或 2038 的明确零费拒绝会提示检查开通、认证或权限，处理后可点击“准备重试”，再单独确认费用。结果未知、断线或取消不会自动重发；样音下载失败也不重新复刻。旧失败记录保留。复刻格式及权限要求见[官方复刻文档](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api)。

## 完成设置与启动

按 [Live2D 接入说明](LIVE2D.md)配置自己的素材、参数映射和表现目录，再完成本机桌面构建。首次设置页会列出缺项；缺模型或构建时仍可以保存 Key、选择模型和准备音色。

Mac 桌面构建：

```sh
npm run build:desktop
npm run build:native
```

Windows 使用 `npm.cmd run build:windows`，具体依 [Windows 安装说明](../windows/README-WINDOWS.md)。资源齐备后，在设置页点击完成，只生成“已准备”配置。接着显式启用：

```sh
npm run configure-local -- --activate-existing
node dist/app/trial-launcher.js
```

启用命令会重新核对文件指纹与凭据权限，本身不启动模型请求或设备；后续启动应用并使用对话、识别、TTS 等能力可能计费。运行中的模型设置保存后，需要按原入口重启才生效。已有 Key、音色、聊天、记忆、Prompt、微信状态和历史账不因更新重置。

有既有成功注册资料的用户仍可沿用 `node tools/configure-local.mjs /absolute/path/to/config.local.json --activate` 和 `config/providers.example.json`。该入口需要有效的音色注册资料；配置冲突时请按报错检查资料。

个人运行数据在本版本根目录的 `.local/` 下；外部受限 Key 文件和这些数据都不应进入 Git。设置进程异常退出后，仅在确认本机锁对应的进程已结束且身份匹配时回收锁；活跃/复用 PID或无法核对的锁会拒绝覆盖。

## 必须另装的工作执行器

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)和 [Codex](https://openai.com/codex/for-work/)是独立程序。请分别安装、启动、登录或配置所需账户，再检查桌宠中的连接状态。缺少某一个执行器时，对应任务转发不可用，不影响本机设置入口。项目只提供连接适配，不携带它们的安装包、账号或订阅。

Mac Harness 使用本机服务与预设连接，当前适配协议为 0.1.5-rc.1。Mac Codex 连接需要受支持的桌面 App 构建和本机状态，安装后请检查连接状态。Windows 保留现有官方 `codex app-server --stdio` 适配和 Harness 单独配置流程，具体版本、目录和登录步骤以[平台说明](../windows/README-WINDOWS.md)为准。

任务发送前仍需核对完整卡片并确认；微信需要使用自己的账号连接。微信语音回复采用音频文件，请在手机上确认接收和播放效果。

## 验证与干净发布

`npm run test:setup` 使用合成音频、测试凭据和本机 HTTP 检查首次配置与音色流程；`npm run test:release` 检查已有发布功能。完成配置后，可用自己的账号和设备试用。

Windows 的 ACL/runner 身份问题仍待修复，其他已知问题见版本对应的验证记录。

发布前在干净副本运行 `python3 tools/check-release.py`。排除 `node_modules`、构建产物、`.local/`、数据库、密钥、参考/样音、模型和 SDK，保留第三方许可。不要复制私有工程 Git 历史。检查器检查目录结构和已知敏感信息模式，素材许可需另行核对。

<a id="english"></a>

## English

### Open setup without a Key, voice or JSON file

From this version's `code/desktop-pet/`, run `npm ci`, `npm run build`, then `npm run configure-local`. Use `npm.cmd` in Windows PowerShell. Keep the terminal open and visit its local URL; the URL contains a session token and must remain private. Opening setup performs no provider request, account login or device access. Existing installations use the running console's model/voice page. A full desktop still requires your own licensed Live2D model, Cubism SDK and native/Electron build; follow the [platform instructions](../windows/README-WINDOWS.md) on Windows.

Text dialogue uses **DeepSeek**. ASR, multimodal models and **DashScope-hosted MiniMax** use an **Alibaba Bailian Key**. First enable the relevant models in [Bailian](https://bailian.console.aliyun.com/) and obtain a Key using the [official guide](https://help.aliyun.com/zh/model-studio/get-api-key). Before trying the service, confirm model access and sufficient account balance, then save the Key. [DeepSeek keys](https://platform.deepseek.com/api_keys) are configured separately.

Save keys explicitly in the local form. Each save triggers one connection test; each saved credential also has a “测试连接” button. This only reads the provider’s model list and generates no content. Success shows “连接测试通过”; failures show the provider error with sensitive data removed. Failures keep the key, and refreshing does not repeat the test. Bailian testing uses the currently supported Beijing endpoint; individual models still need access. Restricted per-install files remain outside the repository; responses contain references/status, never key values. New saves preserve old entries and voice bindings. Manually select the intended credential for each model and save; selection alone makes no network request. Existing runtime settings take effect after restart.

Use an adapted system voice, or upload reference MP3/M4A/WAV you are authorized to use: 10 seconds to 5 minutes, up to 20 MB. The browser converts it locally to mono PCM WAV and the server validates duration/format. Upload is local until explicit cloud confirmation. MiniMax presets are visible before any clone exists. Preparing a voice is free of network calls; creation and first formal activation require separate cost confirmations. A successful full synthesis is required for registration, and registration never automatically replaces your selected voice. Samples play only on your action.

According to the [Bailian MiniMax documentation](https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api), Turbo costs CNY 2 per 10,000 billed characters and HD CNY 3.5. Clone demos incur character fees; first formal use of a cloned voice adds a one-time CNY 9.9. Provider rules/bills at invocation time apply. The existing shared ledger retains estimates and unknown costs; default accounting is uncapped, without restoring old experimental call quotas. A proven zero-charge 403/2038 refusal can be explicitly prepared again after resolving access; another cost confirmation is still required. Unknown outcomes are never automatically repeated, and demo download failure does not recreate the clone. See the [clone API requirements](https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api).

### API key formats

API keys are saved and sent intact, including newer formats containing periods. Only surrounding pasted whitespace is trimmed; content is never truncated or restricted to an old prefix. Nonempty, length and HTTP-header safety checks remain, including rejection of embedded whitespace and control characters. After updating, save a previously rejected key again; saving does not establish provider authentication.

### Prepare, activate and run

Configure your own model using [Live2D integration](LIVE2D.md#english). On Mac build the desktop/native targets; on Windows follow `npm.cmd run build:windows` in the [Windows guide](../windows/README-WINDOWS.md). Missing resources are listed in setup without blocking credential/voice preparation. Completing setup writes a **prepared** configuration. Run `npm run configure-local -- --activate-existing` (Windows: `npm.cmd`) to recheck runtime fingerprints and credential permissions, then use the normal launcher. Activation itself makes no provider or device call; subsequent interaction can incur charges. Existing data, keys, voices, prompts and accounting remain intact. The previous explicit JSON configuration command remains available for users with genuine registration metadata.

### Install external executors separately

Install, launch and sign into/configure [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Codex](https://openai.com/codex/for-work/) separately. Neither engine, account nor subscription is bundled. If an executor is absent, its task-forwarding path is unavailable. Check connection compatibility before dispatch. Mac uses the registered Harness protocol and requires a supported Codex desktop App; check its connection status after installation. Windows retains its official app-server adapter and platform-specific Harness setup. Existing protocol/version guards and task confirmation remain enforced.

### Evidence and publication

`npm run test:setup` uses synthetic keys/audio and local HTTP. After setup, try the service with your own account and devices. The known Windows ACL/runner-identity issue is still awaiting a fix.

Keep `.local/`, external key files, databases, reference/sample audio, dependencies, builds, private models and SDKs out of Git. Use `python3 tools/check-release.py` on a clean release copy and preserve licensing. No credentials, private history, cloned voice material or external executor installations are bundled.
