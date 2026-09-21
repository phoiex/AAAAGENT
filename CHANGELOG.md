# 修改记录 / Changelog

[中文首页](README.md) · [English home](README.en.md) · [English history](#english)

按新到旧记录公开仓库每次修改，一次修改一句话。时间取 Git 提交时间，统一为北京时间（UTC+8）；历史条目按当时的修改内容保留，具体实现见对应提交。

| 修改时间（北京时间） | 一句话说明 | 提交 |
| --- | --- | --- |
| 2026-09-21 18:46 | 修复 Mac 和 Windows 对新格式 API Key 的误拒，完整保留含点号的密钥并统一保存、读取与请求传递。 | [8c3069b](https://github.com/phoiex/AAAAGENT/commit/8c3069b12161b388017a9fd5f857c223a31e4e1d) |
| 2026-09-19 19:15 | Mac版新增文字与近期对话的情绪推测，分别保存用户情绪、桌宠心情和消息快照，并提供网页查询。 | [14e0be5](https://github.com/phoiex/AAAAGENT/commit/14e0be53d88a4d09821e9cba6cef4703ab669093) |
| 2026-09-19 14:12 | 补充人格提示词参考与 AI-Vtuber 致谢；拟人化优化提示词尚未完成。 | [c49c0b8](https://github.com/phoiex/AAAAGENT/commit/c49c0b88d625c3b821334da073266f2a2f64d564) |
| 2026-09-18 23:03 | 为 Mac 和 Windows 增加网页自助配置 Key、模型选择与参考音频音色设置。 | [7f24304](https://github.com/phoiex/AAAAGENT/commit/7f243042d228236c2c739b23af9edd825ac126a0) |
| 2026-09-18 21:52 | 在首页模型公告中补充当前量贩式 Live2D 模型的来源说明。 | [622728d](https://github.com/phoiex/AAAAGENT/commit/622728dce651663e583faeee1eddfb918150176e) |
| 2026-09-18 21:45 | 为 Mac 和 Windows 增加旧聊天导入与长期记忆整理入口。 | [b475707](https://github.com/phoiex/AAAAGENT/commit/b4757071af71d0194ac0ac91518a19b81a6ebb55) |
| 2026-09-17 23:40 | 发布 Windows 0.1.1，更新 Codex 与 Harness 任务转交及相关运行说明。 | [697e7f6](https://github.com/phoiex/AAAAGENT/commit/697e7f629bccee15efa5273f41d5c9f575ea9e5b) |
| 2026-09-17 23:15 | 将 Live2D 开发公告和第三方模型使用条款移到首页演示前。 | [914ed22](https://github.com/phoiex/AAAAGENT/commit/914ed22ff2900609b29a5f22338ac7788b348562) |
| 2026-09-17 22:58 | 在 GitHub 首页加入完整演示视频的原生播放器。 | [e3c4ab5](https://github.com/phoiex/AAAAGENT/commit/e3c4ab5b87115d54153c796c625b32817744c971) |
| 2026-09-17 22:26 | 更新并核对首页的最终原画演示视频下载链接。 | [1f50607](https://github.com/phoiex/AAAAGENT/commit/1f50607d0264fb0b9e08b75187e1865862c5cba4) |
| 2026-09-17 22:19 | 说明演示模型的分发限制与自制鲸鱼 Live2D 发布计划。 | [71a377e](https://github.com/phoiex/AAAAGENT/commit/71a377e7d9efd17ec07cc4913af6a919f2948b00) |
| 2026-09-17 22:03 | 在中英文首页前部加入哔哩哔哩完整演示入口。 | [e5d6087](https://github.com/phoiex/AAAAGENT/commit/e5d6087b22449c0f8f1e3a0162609b0d26c6fcac) |
| 2026-09-17 19:56 | 在中英文首页加入最终 1080P60 演示视频下载入口。 | [d824a41](https://github.com/phoiex/AAAAGENT/commit/d824a4130dd8dc45e4ba1659bded1c7be33cff7b) |
| 2026-09-17 19:37 | 补充项目原创内容禁止商用及使用、引用须署名的许可说明。 | [aa785d0](https://github.com/phoiex/AAAAGENT/commit/aa785d0ae6c3de45eba89c0ec8d6e3d19c654c75) |
| 2026-09-17 18:52 | 增加 Windows 私有文件权限问题的诊断信息，未修复该权限问题。 | [30c380a](https://github.com/phoiex/AAAAGENT/commit/30c380a6feb5d6ece2ad82e008871a2bd1a5d4e3) |
| 2026-09-17 18:18 | 首次公开发布 macOS 源码与独立 Windows 移植源码。 | [6d5badf](https://github.com/phoiex/AAAAGENT/commit/6d5badf490a77f17f5a67a0d3e78a7c01f5c5f36) |

后续每次公开更新同步维护本记录及首页最近条目，保留修改时间、一句话说明和可用的提交链接。

## English

Each public repository update is listed newest first, with one sentence per change. Timestamps use Git commit times in UTC+8. Historical entries describe each change at the time; follow the commit links for implementation details.

| Time (UTC+8) | One-sentence summary | Commit |
| --- | --- | --- |
| 2026-09-21 18:46 | Fixed rejection of new-format API keys on Mac and Windows, preserving dotted keys through saving, reading and request headers. | [8c3069b](https://github.com/phoiex/AAAAGENT/commit/8c3069b12161b388017a9fd5f857c223a31e4e1d) |
| 2026-09-19 19:15 | Added text and recent-dialogue emotion inference, separate user and companion states, frozen message snapshots and a web view on macOS. | [14e0be5](https://github.com/phoiex/AAAAGENT/commit/14e0be53d88a4d09821e9cba6cef4703ab669093) |
| 2026-09-19 14:12 | Added persona-prompt references and AI-Vtuber credits; prompts for more natural conversation are not yet ready. | [c49c0b8](https://github.com/phoiex/AAAAGENT/commit/c49c0b88d625c3b821334da073266f2a2f64d564) |
| 2026-09-18 23:03 | Added web-based key, model and reference-voice setup for Mac and Windows. | [7f24304](https://github.com/phoiex/AAAAGENT/commit/7f243042d228236c2c739b23af9edd825ac126a0) |
| 2026-09-18 21:52 | Clarified the source of the current stock Live2D model beside the homepage announcement. | [622728d](https://github.com/phoiex/AAAAGENT/commit/622728dce651663e583faeee1eddfb918150176e) |
| 2026-09-18 21:45 | Added past-chat import and long-term memory organization for Mac and Windows. | [b475707](https://github.com/phoiex/AAAAGENT/commit/b4757071af71d0194ac0ac91518a19b81a6ebb55) |
| 2026-09-17 23:40 | Released Windows 0.1.1 with Codex and Harness dispatch updates and runtime documentation. | [697e7f6](https://github.com/phoiex/AAAAGENT/commit/697e7f629bccee15efa5273f41d5c9f575ea9e5b) |
| 2026-09-17 23:15 | Moved the Live2D announcement and third-party model terms ahead of the demo. | [914ed22](https://github.com/phoiex/AAAAGENT/commit/914ed22ff2900609b29a5f22338ac7788b348562) |
| 2026-09-17 22:58 | Added a native player for the complete demo to the GitHub homepage. | [e3c4ab5](https://github.com/phoiex/AAAAGENT/commit/e3c4ab5b87115d54153c796c625b32817744c971) |
| 2026-09-17 22:26 | Updated and verified the original-quality final demo download links. | [1f50607](https://github.com/phoiex/AAAAGENT/commit/1f50607d0264fb0b9e08b75187e1865862c5cba4) |
| 2026-09-17 22:19 | Documented demo-model redistribution limits and the planned whale Live2D release. | [71a377e](https://github.com/phoiex/AAAAGENT/commit/71a377e7d9efd17ec07cc4913af6a919f2948b00) |
| 2026-09-17 22:03 | Added the full Bilibili demo link near the top of both homepages. | [e5d6087](https://github.com/phoiex/AAAAGENT/commit/e5d6087b22449c0f8f1e3a0162609b0d26c6fcac) |
| 2026-09-17 19:56 | Added final 1080p60 demo download links to both homepages. | [d824a41](https://github.com/phoiex/AAAAGENT/commit/d824a4130dd8dc45e4ba1659bded1c7be33cff7b) |
| 2026-09-17 19:37 | Added noncommercial-use and attribution terms for original project material. | [aa785d0](https://github.com/phoiex/AAAAGENT/commit/aa785d0ae6c3de45eba89c0ec8d6e3d19c654c75) |
| 2026-09-17 18:52 | Added diagnostics for Windows private-file permission failures; the underlying issue remained unresolved. | [30c380a](https://github.com/phoiex/AAAAGENT/commit/30c380a6feb5d6ece2ad82e008871a2bd1a5d4e3) |
| 2026-09-17 18:18 | Published the initial macOS source and separate Windows port. | [6d5badf](https://github.com/phoiex/AAAAGENT/commit/6d5badf490a77f17f5a67a0d3e78a7c01f5c5f36) |

Keep this history and the recent entries at the top of both homepages current with each public update. Include the time, a one-sentence summary and a commit link when available.
