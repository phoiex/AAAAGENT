# AAAAGENT Windows 0.1.2

[中文](README.md) · [Project home](../README.en.md) · [Platform differences](../docs/PLATFORMS.md#english)

The Windows development version uses Electron with a separate Node.js backend. Its source is in `windows/code/desktop-pet/`; install dependencies and build there.

- [Windows installation, upgrades and task dispatch](README-WINDOWS.md)
- [Web-based key, model and voice setup](docs/SETUP.md#english)
- [Memory, chat import and emotion state](docs/MEMORY.md#english)
- [Windows validation and limitations](WINDOWS-VALIDATION.md#2026-09-19-windows-update)
- [Windows changelog](CHANGELOG-WINDOWS.md)

Version 0.1.2 ports independent user emotion and companion mood, frozen message snapshots, source invalidation and the **Memory → Current emotion** page. Text assessments use the existing dialogue request. No additional background model is enabled. Unknown intensity remains unknown; model predictions still require real-use evaluation.

Past-chat import and self-service key/model/voice setup are also covered by Windows regressions. Setup tests use synthetic credentials and audio; they do not register a paid cloud voice. Codex uses the Windows app-server transport, and DeepSeek Harness is installed separately. Both engines require their own configuration/login. Their real dispatch results from 0.1.1 and this update's regression results are dated separately in the validation report.

For offline preview, double-click `Start-Windows.cmd`. Bring your own licensed Live2D model and Cubism SDK; the preview echoes input. After configuring real services, use `npm.cmd start` from the Windows code directory.

To upgrade an existing configured installation, exit the pet, run `npm.cmd run build:windows`, then `npm.cmd run refresh:runtime`, and start again. Keep your existing `.local/` data, external credential files and local assets. The update adds emotion storage without inventing emotion snapshots for old chats.

Original project content is noncommercial and requires attribution to AAAAGENT, its authors and [the source project](https://github.com/phoiex/AAAAGENT). See [LICENSE](../LICENSE).
