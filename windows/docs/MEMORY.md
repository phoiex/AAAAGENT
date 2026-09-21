# 记忆与上下文 / Memory and context

[项目首页](../README.md) · [English](#english)

## 先分清三种信息

| 层次 | 保存什么 | 怎样进入聊天 |
| --- | --- | --- |
| 最近对话 | 按角色、会话和轮次保存的用户与助手原文 | 在预算内优先取连续的完整轮次，保持上一句与下一句衔接 |
| 陪伴长期记忆 | 有来源的事实、偏好、事件和有效的情绪相关记录 | 通过相关性、活跃度、重要性和情绪强度排序，选少量补入 |
| 项目与工作记录 | 项目名称、短摘要、详情引用；独立的任务正文与回执 | 工作路由时按需读取，不把全部项目全文放入陪伴记忆 |

原始对话经后台整理后形成长期记忆，再根据当前问题的相关性参与召回。

## 一轮对话的数据流

1. 文字输入或 ASR 原文先成为这一轮的用户消息。有效的多模态观察绑定到相同的角色、会话、轮次与 generation。
2. 必要的请求识别和本地隐私状态检查完成后，长期记忆整理进入后台队列。前台不用等待完整的长期整理过程。
3. 前台依据当前有效版本组装上下文：角色 Prompt、当前输入与观察是基础；最近几轮先占预算，然后是摘要，最后是相关长期记忆。
4. 对话模型生成回复，回复连同其使用的上下文身份保存。异步结果按所属轮次保存。
5. 后台提出结构化变更，校验来源、版本、角色和操作边界后提交；失败会保留状态供排查。

前台仍需完成输入识别、上下文读取和模型推理；长期记忆整理在后台异步执行。

## 最近对话不会与旧记忆争同一个优先级

`memory/context.ts` 按时间从最新的完整用户轮次向前选取，再恢复时间顺序。若某一轮放不进预算，会停止向更老的轮次取内容，不会跳过最近的大段对话去拼接几条不相邻的旧话，也不单独取一个没有用户起点的助手回复。

摘要和长期记忆只能使用剩余预算。当前输入也参与预算计算，超出预算的历史会被省略。

普通后台处理失败不应隐藏后续历史。涉及忘记或纠正的待处理请求有独立保护：旧个人信息可能暂时被排除，避免尚未完成的遗忘操作被下一轮重新引用。这个保护与普通模型整理失败不同。

## 长期记忆的召回公式

以下是当前代码默认值，网页中的策略修改可调整规定范围内的部分参数。

| 符号 | 含义 |
| --- | --- |
| `C` | 当前问题与记忆的相关性，范围 0–1 |
| `A` | 活跃度，范围 0–1 |
| `I` | 重要性，取 0、0.5 或 1 |
| `E` | 有效情绪强度的动态值，范围 0–1 |
| `t` | 距锚点经过的天数 |

```text
活跃度半衰期 H = 30 × (1 + 2 × I) 天
普通事件活跃度 A(t) = A₀ × 2^(-t / H)
稳定档案类活跃度 A(t) = 1
情绪强度 E(t) = E₀ × 2^(-t / 7)
召回优先级 P = C × (0.55 + 0.25A + 0.15I + 0.05E)
有效强化 A' = A + 0.2 × (1 - A)
```

只有有效、具备合格来源和动态状态的候选才参与。默认相关性必须大于 0，`P ≥ 0.35`，最终至多补入 6 条，并受剩余输入预算限制。重要性改变半衰期；较强的情绪观察会轻微影响排序，但不会让无关记录越过 `C = 0`。

`C` 当前来自明确的关键词与短语规则。中文按规则分词并匹配，英文进行规范化匹配；少量已实现的关系规则提供补充。

自然淡化只改变活跃度和召回机会，**不自动删除长期记忆**。用户明确重提或确认、且来源与去重校验通过，才可能触发强化；仅浏览、搜索或试算不会把记忆越看越重要。

## 情绪记录怎样使用

Windows 0.1.2 在 **管理页 → 记忆 → 当前情绪** 展示三个层次：每条消息的观察 O、用户持续情绪 U、桌宠持续心情 M。用户与桌宠状态分别维护；消息保存当时快照，后续推测单独显示，不改写历史。升级自动创建所需表；不会为旧消息补造情绪快照。

文字及近期对话通过现有对话请求提供情绪推测；有效音频标注、视频观察及用户明确说明也可作为来源。页面保留来源和置信度，未知强度为空（null），不等于零；缺少或损坏的模型字段不更新状态，聊天正文仍正常处理。视频保留有限七类判断，音频只采用合法返回标注。

最近完整问答和相关记忆优先占用输入预算，情绪背景只使用剩余空间；长期记忆公式、E 与原半衰期保持。普通状态更新不会使当前回复失效；纠正、删除或屏蔽来源时，依赖它的状态和后续引用也受来源校验约束。

后台增强推测接口已预留，生产中的增强模型与 thinking 尚未配置。合成测试验证了接线、持久化、隐私失效和并发保护，真实情绪理解效果仍需使用中确认。

## 网页里可以管理什么

| 页面能力 | 意义 |
| --- | --- |
| 原文、摘要、长期记忆及来源查看 | 确认保存的内容、来源与处理状态 |
| 纠正与遗忘 | 对指定记录及相关来源执行受版本约束的变更 |
| 实际召回记录 | 查看哪些记忆参与候选、被选中或因预算等原因省略 |
| 策略试算与保存 | 对比新旧参数；正式保存向后生效，回退参数不复活已遗忘内容 |
| 处理失败查看 | 区分原文保存成功、后台整理失败、隐私处理未完成等情况 |
| 角色 Prompt 与上下文设置 | 调整角色提示词和容量范围；角色之间保持数据边界 |

编辑时会同步检查来源、摘要、缓存与旧版本的关联，避免已删除的内容被再次引用。

## 导入旧聊天

在管理页选择 **记忆 → 导入旧聊天**，填写来源名称和本地绝对路径。支持指定 Codex 项目的用户主任务历史（含归档会话），或带说话人与日期的 JSONL / JSON 数组。普通聊天窗口里描述一个项目不会自动导入。

```json
{"role":"user","text":"那年我开始学水彩。","createdAt":"2020-05-01T10:00:00+08:00"}
```

每条需有 `role`（`user` / `assistant`）、`text` 和带时区的日期 `createdAt`；也接受 `speaker` 与 `timestamp` / `date`。开始前查看页面显示的模型、端点、输入/输出限额、超时与费用配置。**点击开始后，所选对话会发送到已配置的记忆模型服务，并可能产生费用**；本地源文件保持只读。

整理从较新的内容向前进行，助手回复只作语境，不能单独证明用户事实；历史指令不会触发任务或语音。原日期保留，导入内容与当前最近对话分开；跨文件副本、JSON 格式和等价时区的重复记录会去重，已遗忘内容不会因再次导入相同来源而复活。

任务可暂停，重启后保持暂停；模型或费用配置变化时，旧任务不能直接续跑，页面允许按当前配置显式新建任务，已处理记录继续去重。导入任务与来源证据是本地产品数据，升级时保留，不随普通近期聊天清理；请连同自己的其他数据妥善保管。自动检查使用合成数据，实际提炼质量与召回效果仍需自行核验。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| [`core/dialogue-pipeline.ts`](../code/desktop-pet/core/dialogue-pipeline.ts) | 前台对话与后台任务衔接 |
| [`core/memory-lifecycle-queue.ts`](../code/desktop-pet/core/memory-lifecycle-queue.ts) | 后台生命周期与角色范围 |
| [`memory/context.ts`](../code/desktop-pet/memory/context.ts) | 最近轮次优先、摘要和记忆的预算装配 |
| [`memory/dynamics.ts`](../code/desktop-pet/memory/dynamics.ts) | 衰减、强化和优先级公式 |
| [`memory/dynamics-cues.ts`](../code/desktop-pet/memory/dynamics-cues.ts) | 相关性规则 |
| [`memory/sqlite-recall.ts`](../code/desktop-pet/memory/sqlite-recall.ts) | 候选筛选与实际召回记录 |
| [`projects/sqlite-project-index.ts`](../code/desktop-pet/projects/sqlite-project-index.ts) | 独立项目索引 |
| [`harness/receipts.ts`](../code/desktop-pet/harness/receipts.ts) | 工作卡、确认状态和转发回执 |

<a id="english"></a>

## English

### Three distinct stores

**Recent conversation** holds verbatim user and assistant turns, scoped to a character and session. **Companion memory** holds sourced facts, preferences, events and valid emotional observations. **Work context** holds project names, abstracts and references, with separate task bodies and receipts. Engineering histories are not loaded wholesale into companion chat.

A saved transcript is not automatically a successfully extracted long-term memory. Nor does a stored record guarantee selection on the next turn.

### Foreground and background

The application saves the current input, performs necessary request/privacy checks, and queues long-term maintenance in the background. The foreground assembles a valid context and requests a reply without waiting for the full maintenance job. Background proposals are committed only after checking role, source, version and operation boundaries.

Context assembly reserves the base prompt and current input, then selects a **contiguous suffix of complete recent turns**, followed by summaries and relevant memories. It does not skip a large recent turn to pick isolated older messages. Budget exhaustion can still omit history.

Ordinary maintenance failure should not hide newer turns. Pending forgetting/correction requests are different: a privacy boundary may temporarily exclude older personal information so it is not reintroduced before the operation completes. Background processing does not eliminate all foreground latency: request classification, reads and inference still take time.

### Default recall mathematics

```text
H = 30 × (1 + 2I) days
A(t) = A₀ × 2^(-t/H)       for ordinary events
A(t) = 1                   for stable-profile records
E(t) = E₀ × 2^(-t/7)
P = C × (0.55 + 0.25A + 0.15I + 0.05E)
A' = A + 0.2 × (1 - A)     for eligible reinforcement
```

`C` is query relevance, `A` activation, `I` importance, and `E` emotional intensity. Values are bounded to 0–1; importance takes 0, 0.5 or 1. Eligible active records need `C > 0` and `P ≥ 0.35`. At most six memories are included, subject to the remaining input budget. Importance extends activation half-life; emotion adjusts ranking modestly and cannot make an unrelated record relevant.

Relevance uses keyword and phrase matching, with a small set of relation rules. Decay changes recall priority without automatically deleting long-term memory. Eligible user reiteration or confirmation can reinforce a record; viewing, searching and previews do not.

### Emotional context

On Windows 0.1.2, **Management → Memory → Current emotion** shows each message's observation (O), sustained user emotion (U) and sustained companion mood (M). User and companion states are independent. Each message freezes the states at that time; later analyses are displayed separately and never rewrite the original snapshot. The required tables are created on upgrade; old messages receive no invented snapshots.

Text and recent dialogue provide emotion assessments through the existing dialogue request. Valid audio annotations, video observations and explicit user statements can also provide evidence. Sources and confidence remain visible; unknown intensity is null, not zero. Missing or malformed model fields leave state unchanged without breaking the reply. Video retains limited seven-category classification, and only valid returned audio annotations are used.

Recent complete turns and relevant memories take input-budget priority, with emotion context using remaining space. The existing long-term memory formula, E and half-lives are unchanged. Ordinary emotion updates do not invalidate an in-flight reply; corrections, deletion and blocked sources still invalidate dependent states and later references.

The stronger background-inference interface is available, but no stronger model or thinking configuration is enabled. Synthetic tests cover wiring, persistence, privacy invalidation and concurrency; real emotional understanding still requires use-based validation.

### Import past chats

Open **Memory → Import past chats** in management and enter a source label and absolute local path. Choose a Codex project (user-started main tasks, including archived sessions) or a JSONL / JSON array export. Describing a project in ordinary chat does not start an import. Each export entry needs `role` (`user` / `assistant`), `text` and a dated `createdAt` with timezone; `speaker` and `timestamp` / `date` aliases are also accepted.

Review the displayed model, endpoint, input/output limits, timeout and cost settings before starting. **Starting sends selected conversation content to your configured memory-model provider and may incur charges.** Source files remain read-only. Processing works backward from newer records, preserves original dates and keeps imported history outside current recent turns. Assistant replies provide context rather than evidence of user facts; old instructions never dispatch tasks or play speech. Copies, equivalent timestamps and JSON reformatting do not duplicate records or restore forgotten sources.

Jobs can pause and remain paused after restart. A changed configuration requires explicitly starting a new job with the current settings; completed records still deduplicate. Import state and source evidence are persistent local product data, preserved across upgrades and separate from ordinary recent-chat cleanup. Keep them with your other personal data. Automated checks use synthetic content; extraction and recall quality still require your own verification.

### User control and evidence

Web management exposes raw records, summaries, long-term memories, source links, corrections, forgetting, processing failures, recall traces and bounded policy tuning. Changes are versioned and account for dependent sources/caches. Policy rollback does not restore forgotten content. Recall traces show the context assembled for each model request.

The source map in the table above links directly to the implementation. Models, retrieval quality, emotional predictions and actual device behavior remain distinct validation concerns.
