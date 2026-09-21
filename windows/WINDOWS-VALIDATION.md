# Windows validation

<a id="2026-09-19-windows-update"></a>
## 2026-09-19 Windows update — 0.1.2

Tested locally on Windows 11 x64, Node 22.14.0, npm 10.9.2 and Electron 44.4.1. This update ports the Mac emotion feature and exercises the upstream chat-import and self-service setup changes while retaining the Windows transport, ACL and shutdown fixes.

| Check | Observed result |
| --- | --- |
| `build:windows` and resource doctor | Passed; all local resource checks true |
| Core memory/provider suite | 563 passed, 0 failed |
| `test:release` (including past-chat import) | 138 passed, 0 failed |
| `test:windows` | 22 passed, 0 failed |
| `test:setup` | 49 passed, 0 failed; four Unix-specific checks skipped |
| `test:emotion` | 27 passed, 0 failed |
| `test:emotion:ui` | One Electron/Chromium test passed, covering six scenarios; browser screenshot inspected |
| Connection, desktop-work, forwarding, native-work and HTTP relay | 64 passed, 0 failed |
| Windows stress suite | 5 passed, 0 failed |
| Real configured backend | HTTP 200; 20-character Chinese reply, 231,316 bytes of generated TTS; no runtime errors |
| Real emotion API after dialogue | HTTP 200; two persisted message snapshots, separate user/companion subjects, schema version 0.1.1 |
| Configured Electron lifecycle | Two launches ready; both clean exits left no backend lock; Live2D screenshot inspected |

The six UI scenarios cover empty/null state, independent subjects with frozen historical snapshots, rejected stale/invalid responses, escaped labels, pagination and inactive-section behavior, and refresh without polling or mutations. Tests run with the project's installed Electron and a local synthetic HTTP fixture; they need no WebKit installation, credentials or private assets.

Windows-specific test fixes close SQLite connections before deleting fixture files, use directory junctions without requiring symlink privileges, assert private-file ACLs rather than POSIX mode bits, and update provider-catalog expectations for the new voice setup. The four skips concern Unix file/directory permission or ownership behavior; Windows ACL checks run separately. Suite counts overlap and must not be added as distinct cases. The existing Windows CI workflow is retained; setup, emotion backend and Chromium checks are available as npm commands and were run locally for this release.

The first GitHub Actions run exposed an additional elevated-runner case: newly created files were owned by the Administrators token owner rather than the user SID. The Windows policy now admits that exact owner only when the current token is elevated and its default owner matches. Other owners and broad access grants remain rejected. The existing Windows tests cover this on the hosted runner. After the fix, both the 22-case Windows suite and 138-case release suite passed on GitHub Actions with Windows Server / Node 24.19.0: [verified run for 0ec5193](https://github.com/phoiex/AAAAGENT/actions/runs/35441556331). Both suites were also rerun successfully on the local machine.

An initial desktop check encountered a stale backend lock from an exited process. The PID was verified absent and the lock was backed up before retrying; personal data was retained. The subsequent real backend and both normal desktop exits succeeded. An abnormal termination can still require the documented lock recovery.

Emotion API schema version 0.1.1 is independent of application version 0.1.2. Existing data and local model appearance overrides were retained. New tables do not fabricate emotion history for earlier conversations. Runtime text assessments reuse the dialogue request; no extra background inference model is configured. These checks verify persistence and integration, not the accuracy of emotion understanding.

Reproduce from `windows/code/desktop-pet/`:

```powershell
npm.cmd run build:windows
npm.cmd test
npm.cmd run test:release
npm.cmd run test:windows
npm.cmd run test:setup
npm.cmd run test:emotion
npm.cmd run test:emotion:ui
npm.cmd run test:stress
node --test dist/tests/harness/connection.test.js dist/tests/harness/desktop-work.test.js dist/tests/harness/forwarding.test.js dist/tests/harness/native-work.test.js dist/tests/harness/relay-http.test.js
```

Live Codex and Harness dispatch results remain dated **2026-09-17** below; this update reran their 64 automated work/relay cases, not a new real executor task. Paid voice cloning was not invoked; setup uses synthetic keys/audio and local HTTP. Physical microphone/camera, live ASR, actual speaker output, wake accuracy, WeChat login/delivery and Windows ARM64 remain unverified. Private keys, model/SDK files, audio, screenshots and databases are excluded from Git.


<a id="2026-09-17-windows-reproduction"></a>
## 2026-09-17 Windows reproduction — 0.1.1

Independently reproduced on the user's Windows x64 machine using Windows Node 22.14.0, npm 10.9.2, Electron 44.4.1 and native SQLite. The external DeepSeek Harness was installed separately as `@deepseek-ai/dsh@0.1.5-rc.2` and run with Node 24.19.0. Codex was the locally installed `0.155.0-alpha.2.6` executable with the user's existing login.

| Check | Observed result |
| --- | --- |
| `build:windows` and resource doctor | Passed; all resource checks true |
| Windows suite | 22 passed, 0 failed |
| Core memory/provider suite | 525 passed, 0 failed |
| Release suite | 116 passed, 0 failed |
| Windows stress suite | 5 passed, 0 failed |
| Connection, desktop-work, forwarding and native-work suites | 63 passed, 0 failed |
| HTTP + SQLite + stdio MCP integration | 1 passed, 0 failed after restoring the missing bridge and correcting Windows cleanup |
| Configured Electron lifecycle | Two launches ready; both exits left no backend lock |
| Real configured backend | Management HTTP 200, 16-character Chinese reply and 167,786 bytes of TTS audio; no runtime errors |
| Real Codex dispatch | Confirmed task accepted; exact turn completed with `AAAAGENT_CODEX_FORWARD_OK` |
| Real DeepSeek Harness dispatch | Confirmed task accepted in a Windows project directory; exact request completed with `AAAAGENT_HARNESS_FORWARD_OK` |
| Live2D | Rendered and screenshot inspected; local rig's native appearance switch hides its watermark |

The two real task tests used the production `HarnessForwarding` prepare/confirm/receipt path, real SQLite receipts and the installed executors. They requested a short exact reply in an isolated test workspace with no tools or delegation. The Codex test exercised the official app-server JSONL transport, not a mock or Mac IPC. Harness was authenticated with the user's configured DeepSeek service. Private credentials, model assets, absolute personal paths, screenshots and runtime databases are not published.

Reproduce the work regressions after building:

```powershell
node --test dist/tests/harness/connection.test.js dist/tests/harness/desktop-work.test.js dist/tests/harness/forwarding.test.js dist/tests/harness/native-work.test.js dist/tests/harness/relay-http.test.js
```

An exploratory wildcard run also selected the retained `codex-app.test.ts` Mac Unix-socket tests. Its 12 cases cannot run on Windows (`/tmp` socket fixtures); these are not counted as passing or silently skipped. Windows transport behavior is covered separately by `tests/windows/codex.test.mjs`. No Mac source or tests outside the Windows copy were changed. Suite counts overlap and should not be added as a count of distinct tests.

Limitations: physical microphone/camera, live ASR, actual speaker playback, wake-word accuracy, WeChat login/delivery, Windows ARM64 and complex tool/approval workflows were not validated. The Windows Codex bridge declines interactive command/file approvals; continue such work in Codex. The real TTS test verified generated audio bytes, not audible output. Harness is an external engine, not bundled in the repository. See [setup and dispatch instructions](README-WINDOWS.md).

## Earlier source-author report (historical)

The following report describes the original archive before the 0.1.1 fixes. Its unsupported-Codex, remaining-test-failure and untested-provider statements are superseded by the measured results above; it is retained as provenance.

> Source-author report: the Windows-specific runtime results below were supplied with the Windows source archive. The integration review has not independently reproduced them on Windows. macOS is currently the most mature platform; report Windows problems through this repository’s Issues.


Validated locally on 17 September 2026, on Windows 11 x64 with Node 24.19.0, Electron 44.4.1 and the package's locked dependencies.

| Check | Result |
| --- | --- |
| TypeScript backend build | Passed |
| Desktop renderer and management preview build, using supplied local model/SDK | Passed |
| SQLite native module | Loaded; real database tests passed |
| Windows wake native module | Packaged and loaded; `KeywordSpotter` available |
| Windows-specific tests | 11 passed, 0 failed |
| Existing release suite | 115 passed, 0 failed |
| Existing broader suite | 520 passed, 4 existing failures |
| Actual Electron UI smoke test | Passed: Live2D load, sandboxed preload, backend ready, text round trip, visible chat panel, shutdown |
| Local resource doctor | All reported resources present in the prepared working folder |
| Follow-up synthetic stress suite | 5 passed; 2,000 requests, 250 mock conversations, 300 projects, 20,000 cancellations, 10,000 layout transitions |
| Additional task, runtime, playback and retry checks | 116 passed after Windows permission and test-fixture fixes |
| Follow-up software-rendered Electron preview | Passed; SwiftShader verified, model loaded, text round trip completed, screenshot inspected |

The Windows-specific tests cover credential DACLs (including rejecting an Everyone read grant), real credential save/reopen, drive-qualified paths, traversal and junction rejection, SQLite project persistence, multi-monitor window geometry, management-session identity checks, launch fingerprints, split UTF-8 transport, stale generations, reconnection, bounded messages, timeout and graceful backend EOF.

The four remaining broader-suite failures match the original source package's documented failures:

1. Manual-assistant evidence retention assertion.
2. Legacy combined-Omni adapter audio/image assertion.
3. Legacy combined-Omni adapter model/emotion assertion.
4. Legacy Qwen-summary format assertion.

No test was removed or skipped to make these results pass. Test fixtures now close their additional SQLite handles before deleting files on Windows. The voice-registry permission assertion checks actual file privacy on each platform, and the interleaving test uses real files so Windows ACL operations remain exercised.

Not verified: physical microphone/camera capture, live ASR/TTS, wake-word detection accuracy, authenticated cloud chat, WeChat login/delivery, external Harness dispatch, or Windows Codex task dispatch. The Mac-specific Codex IPC adapter remains unsupported on Windows. No archived credentials, chats or account sessions were activated for validation.

The local preview uses the supplied private model without changing its watermark or redistributing it. The source ZIP excludes the private rig, SDK, credentials, runtime data and dependency/build directories. See [README-WINDOWS.md](README-WINDOWS.md) for setup and development commands.

The follow-up review corrected Windows permissions on newly created task-receipt databases. Tests now verify the real Windows ACL, use directory junctions for escape checks without administrator privileges, and wait for the actual cancellation checkpoint instead of a fixed count of event-loop ticks. See [WINDOWS-STRESS-RESULTS.md](WINDOWS-STRESS-RESULTS.md). Passing application tests does not establish GPU/NPU driver stability; the follow-up preview deliberately used software rendering after the laptop's recurring driver timeouts.
