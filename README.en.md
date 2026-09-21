## Changelog

[View all updates](CHANGELOG.md#english) · Times: UTC+8

| Time | Change |
| --- | --- |
| 2026-09-21 20:31 | Added API key connection tests on Mac and Windows, running once after saving and showing each credential’s result or provider error. |
| 2026-09-21 18:46 | Fixed rejection of new-format API keys on Mac and Windows, preserving dotted keys through saving, reading and request headers. |
| 2026-09-19 19:58 | Fixed default file-owner checks for elevated Windows processes; Windows and release suites pass on GitHub Actions. |
| 2026-09-19 19:52 | Released Windows 0.1.2 with emotion state and web queries, Windows regressions for chat import, self-service setup and task dispatch, and updated documentation. |
| 2026-09-19 19:15 | Added text and recent-dialogue emotion inference, separate user and companion states, frozen message snapshots and a web view on macOS. |

## Planned development

Local model integration is being planned:

| Capability | Planned approach | Status |
| --- | --- | --- |
| Dialogue | Local dialogue models through Ollama | Planned |
| Speech synthesis | Local speech synthesis with GPT-SoVITS | Planned |
| Emotion recognition | Small Qwen-Omni family models for local audio/video emotion recognition | Planned |

---

<div align="center">
  <img src="assets/original-design/whale-avatar.png" width="144" alt="AAAAGENT whale-girl character concept" />
  <h1>AAAAGENT</h1>
  <p><strong><a href="https://www.bilibili.com/video/BV1cueG6sE85/">▶ Watch the full demo on Bilibili</a></strong></p>
  <p>A desktop companion that talks, remembers, and connects your ideas to working agents.</p>
  <p><a href="README.md">简体中文</a> · <strong>English</strong></p>
  <p><a href="docs/PLATFORMS.md#english">Mac / Windows</a> · <a href="docs/SETUP.md">Setup</a> · <a href="docs/MEMORY.md#english">Memory and context</a> · <a href="docs/PROMPT_REFERENCES.md#english">Prompt references</a> · <a href="docs/LIVE2D.md#english">Bring your own Live2D</a> · <a href="assets/original-design/README.md#english">Whale-girl artwork</a></p>
</div>

> [!IMPORTANT]
> **We will release our own “Big Whale DeepSeek” Live2D model in two days, on September 19, 2026.**
>
> The model currently used and shown in the demo is a **purchased third-party stock Live2D model** ([search stock Live2D models on Bilibili](https://search.bilibili.com/all?vt=35099468&amp;keyword=live2d%E9%87%8F%E8%B4%A9&amp;search_source=1&amp;from_source=web_recommend_search)). Its original license prohibits redistribution, so its model files, textures, expressions and motions are not included in this project.
>
> You can also choose a free Live2D model whose license permits your intended use and adapt it locally using the [integration guide](docs/LIVE2D.md#english). Please follow each model's usage and redistribution terms.

## Watch the demo

https://github.com/user-attachments/assets/f499c069-4a13-4f79-b705-ce332d7b06f2

**Play the full demo above (about 9m 21s).** This is a 720p web playback version; [watch on Bilibili](https://www.bilibili.com/video/BV1cueG6sE85/) · [download the original-quality 1080p60 video](https://github.com/phoiex/AAAAGENT/releases/tag/demo-video-20260917).

---

> **Noncommercial only · Attribution required.** All commercial use of original project material is prohibited. Credit AAAAGENT, its authors and [the source repository](https://github.com/phoiex/AAAAGENT) when using, citing, reproducing or adapting it. See [LICENSE](LICENSE).

AAAAGENT is a desktop companion developed primarily for macOS, with a separate Windows development version, offering text and voice conversation, a WeChat entry point, and task forwarding. Describe a job, review the proposed task card, and confirm before it is sent to DeepSeek Harness or an existing Codex task. **[▶ Watch the full demo on Bilibili](https://www.bilibili.com/video/BV1cueG6sE85/)**

[Download the final demo in original quality (1080p60, corrected subtitles)](https://github.com/phoiex/AAAAGENT/releases/tag/demo-video-20260917). To meet GitHub's per-file size limit, it is split losslessly into two parts, with no re-encoding or quality reduction.

## Platforms and feedback

**macOS is currently the most complete version and the recommended starting point. The Windows version is still being improved. If you encounter a problem, please report it in this repository's Issues; we will follow up in the corresponding issue.**

| Platform | Status and entry point |
| --- | --- |
| **macOS** | The primary version, with source in the root `code/desktop-pet/`. See [Mac setup](docs/SETUP.md#english). |
| **Windows** | A separate Electron development version in `windows/code/desktop-pet/`. See [Windows setup](windows/README-WINDOWS.md). Version 0.1.2 includes emotion states, message snapshots and web queries, with Windows regressions for chat import, self-service setup and task dispatch. See the [dated validation](windows/WINDOWS-VALIDATION.md#2026-09-19-windows-update). |

See [platform differences and issue reporting](docs/PLATFORMS.md#english). Include your OS version, reproduction steps and sanitized errors. Install dependencies separately for each platform; do not mix configuration or build outputs.

Companion conversation and work share an entry point without loading every project's engineering history into personal memory. Recent turns preserve continuity; long-term memories provide relevant recollections; project references locate work-specific context when needed.

**This is a source distribution.** It does not include credentials, private conversations or memory databases, WeChat login state, cloned-voice material, wake-model weights, third-party Live2D characters, or the Cubism SDK. The image above is project-produced fan artwork; Live2D rigging is still in progress.

New: **Memory → Import past chats** imports explicitly selected local history with pause, deduplication and forgetting protection. Review model and cost settings before starting; see the [guide](docs/MEMORY.md#import-past-chats).

## Features

The overview below primarily describes the macOS version. Windows 0.1.2 now includes emotion states, message snapshots and the emotion page; see [Windows memory documentation](windows/docs/MEMORY.md#english) for usage and data boundaries.

| Capability | What the code provides |
| --- | --- |
| Voice conversation | Push-to-talk, live level feedback, interruption by new input, and separate transcription and dialogue services. |
| Local wake detection | Opt-in keyword detection, wake-word removal, and silence-based recording completion. Compatible local weights must be supplied separately. |
| Emotion-aware responses | Text and recent dialogue inform separate user and companion states, alongside available audio/video observations; message snapshots and sources are visible in the web console. Unknown intensity remains empty. |
| Speech and animation | TTS playback drives lip sync; thinking, work and interaction states feed character presentation. Available motions depend on the model. |
| WeChat | Text and voice input; configurable text or audio-file replies. Native voice bubbles are currently unreliable. |
| Agent forwarding | Harness for appropriate smaller search/organization jobs, Codex for planning and engineering. Explicit executor choices are preserved and dispatch requires confirmation. |
| Web management | Persona prompts, stored memories, recall traces, context settings, speech configuration, presentation presets, and connection status. |

Everyday questions should stay in conversation instead of creating engineering tasks. Task requests can be supplemented, confirmed or cancelled by voice. A normal progress query selects the most recently arranged task; listing everything requires an explicit request.

## Persona prompts and community references

**Prompts for more natural conversation are not yet ready.** The web console supports customizing the persona to suit your conversational preferences.

If you want a different conversational style, personality or emotional response, explore community resources and adjust the prompt under **Memory and conversation → Character Prompt** in the web console, then try it in conversation. Our [references and acknowledgements](docs/PROMPT_REFERENCES.md#english) link to MaiBot, SillyTavern, ChatHaruhi, Hume, Alice_methodology, **[AI-Vtuber](https://github.com/Ikaros-521/AI-Vtuber)** and **[Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber)**. Thank you to their authors and contributors for sharing their work; the guide links to each original source.

## Architecture

```mermaid
flowchart LR
    U[Desktop / WeChat] --> I[Text / dedicated ASR]
    V[Optional video frames] --> E[Limited emotion classification]
    I --> R{Chat or work}
    E --> C[Recent turns + summaries + relevant memory]
    R -->|Chat| C
    C --> L[DeepSeek dialogue]
    L --> O[Text / speech / presentation]
    R -->|Work| P[Complete task card]
    P --> A[User confirmation]
    A --> W[Harness / Codex]
    W --> F[Status and result feedback]
    L -.Background processing.-> M[Local memory store]
    M --> C
```

DeepSeek handles text dialogue and structured processing. Dedicated ASR supplies the transcript, Qwen multimodal adapters process images, and the MiniMax adapter generates speech. Users supply service configurations and credentials. The application connects to existing Harness and Codex services rather than bundling another agent platform.

## How memory works

1. **Recent conversation comes first.** Within the input budget, the assembler selects a contiguous suffix of complete turns before adding summaries and relevant long-term memory.
2. **Maintenance runs in the background.** Ordinary memory-processing failures should not block subsequent chat. Forgetting and correction requests have separate privacy safeguards.
3. **Emotion keeps its provenance.** Each message freezes its observation and the separate user/companion states at that time. Recent turns and relevant memories take priority; emotion provides supporting context. See **Memory → Current emotion**. The existing long-term memory formula is unchanged.
4. **Project details are retrieved on demand.** Project names, short abstracts and references stay separate from full task bodies, receipts and execution history.
5. **Users can inspect and edit.** The web interface exposes source records, edits, selected recall parameters, actual recall traces and failed processing items.

See [Memory and context](docs/MEMORY.md#english) for formulas and code references. Current retrieval uses keyword and phrase matching.

## Getting started

**Self-service setup:** after building, run `npm run configure-local` (Windows: `npm.cmd`) to save DeepSeek/Bailian keys, choose adapted models and upload your own reference audio. Enable the relevant Bailian models first: saving a Key does not prove access. Harness and Codex must be installed, launched and authenticated separately; missing executors cannot receive tasks. See [setup](docs/SETUP.md#english).

Mac users should read [Setup](docs/SETUP.md#english); Windows users should start with [Windows setup](windows/README-WINDOWS.md). The commands below target the root Mac source tree. This is a developer-oriented source package. A complete animated desktop setup requires your own authorized Live2D model and SDK.

```sh
cd code/desktop-pet
npm ci
npm run build
```

Compilation does not log in to WeChat, call models or open the microphone. Follow the setup document for runtime configuration, launch steps and missing-resource checks.

| Component | Bring your own |
| --- | --- |
| Text dialogue | Supported provider configuration and credentials |
| ASR / image understanding | Service access and API configuration |
| Speech output | MiniMax configuration and a voice you are authorized to use |
| Live2D | Licensed model, Cubism SDK, parameter mappings and presentation presets |
| Wake detection | Compatible keyword-spotting weights and local settings |
| Work agents | Local Harness / Codex services and the intended projects and tasks |
| WeChat | Your own account login and binding |

## Live2D and character artwork

**Different Cubism Live2D models can be integrated with local adaptation.** Parameter IDs, expression files, motion ranges and physics differ between characters. Replacing an image or copying a single model file is not sufficient. See [Live2D integration](docs/LIVE2D.md#english).

The currently available [DeepSeek whale-girl design resources](assets/original-design/README.md#english) contain static artwork and separated layers; Live2D rigging is still in progress.

## Repository layout

```text
README.md / README.en.md   Chinese and English home pages
code/desktop-pet/          Primary macOS source
windows/                  Windows development version and validation notes
tools/                    Release checks and configuration helpers
docs/                     Setup, memory and model integration
assets/original-design/   Project-produced whale-girl fan artwork
```

## Privacy and current limits

- Conversations, memories, project references and settings are stored locally. Selected cloud services still receive the text, audio or images needed for their calls.
- Publish only this clean release directory. Do not add private runtime directories, databases, credentials, token-bearing links, server configurations or conversation logs.
- Wake detection is opt-in and local; it does not continuously call a cloud recognizer. ASR, dialogue and TTS after wake-up may incur charges.
- macOS is currently the most complete version. Windows 0.1.2 has a [dated local validation report](windows/WINDOWS-VALIDATION.md#2026-09-19-windows-update), separating automated regressions, real-service checks and untested devices. Linux desktop behavior is not validated. Phone delivery, voices and new model animations require device testing.
- Original project material is under the [Noncommercial and Attribution License](LICENSE): **all commercial use is prohibited; use or citation requires credit to the project and authors, with a source link**. Third-party dependencies, SDKs and artwork retain their separate terms; see the [artwork notice](assets/original-design/README.md#english) and third-party notices in the source tree.

When reporting an issue, provide a minimal reproduction without private data. Never attach credentials, a full conversation database or a login QR code to a public issue.

## Citation and credit

Credit the project in applications, demos, videos, articles and papers, and retain copyright notices:

> AAAAGENT — phoiex and project contributors. https://github.com/phoiex/AAAAGENT (include the version or commit and access date)

Use GitHub’s “Cite this repository” entry for citation metadata. Mark modifications and retain the license when redistributing. Credit third-party materials separately.
