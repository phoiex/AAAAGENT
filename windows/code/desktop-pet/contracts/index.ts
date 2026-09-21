/** Provider-neutral boundary. JSON values cross native/process boundaries; AbortSignal does not. */
export const CONTRACT_VERSION = '0.9.0' as const;
/** Production voice capture: audio is required; camera contributes at most three actual frames. */
export const MAX_CAPTURE_IMAGES = 3 as const;
import type { WorkInputBinding } from './desktop-work.js';
import type { CharacterId } from './character.js';
export type { CharacterId } from './character.js';
export { COMPANION_ID, COMPANION_LABEL, PRODUCT_CHARACTERS, isCharacterId, isProductCharacter } from './character.js';
export type InputKind = 'text' | 'voice';
export interface TurnScope {
  readonly characterId: CharacterId;
  readonly sessionId: string;
  readonly turnId: string;
  readonly generation: number;
}
export interface TurnInput {
  readonly scope: TurnScope;
  readonly kind: InputKind;
  readonly startedAt: string;
  readonly text?: string;
  /** Echo of a desktop voice-start intent; scope remains the backend authority. */
  readonly clientRequestId?: string;
  /** Set by the backend only after consuming a current local KWS hit. */
  readonly wakeKeyword?: string;
}
export interface Scoped { readonly scope: TurnScope }
export interface Timed { readonly at: string }
export interface MediaAsset {
  readonly id: string;
  readonly uri: string;
  readonly mimeType: string;
  readonly temporary: true;
}
export interface CapturedInput extends Scoped {
  readonly audio: MediaAsset;
  /** Actual frames available at release (0..MAX_CAPTURE_IMAGES); never synthesized or awaited to fill a quota. */
  readonly images: readonly MediaAsset[];
  readonly inputEndedAt: string;
  readonly captureStoppedAt: string;
}
export type Modality = 'text' | 'audio' | 'image';
export interface ModalityEvidence {
  readonly modality: Modality;
  readonly status: 'used' | 'missing' | 'failed' | 'not_requested';
  readonly inputIds: readonly string[];
  readonly detail?: string;
}
export interface EmotionCue {
  readonly label: string;
  readonly evidence: readonly Modality[];
  readonly confidence: number | null;
  readonly uncertainty: string;
  readonly expiresAt: string;
}
/** Predicted class, not proof that the model used any particular supplied modality. */
export type PerceivedEmotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'fear' | 'disgust' | 'surprise';
export interface PerceptionResult extends Scoped {
  readonly emotion?: PerceivedEmotion;
  readonly audioEmotion?: PerceivedEmotion;
  readonly visualEmotion?: PerceivedEmotion;
  readonly transcript: string;
  readonly modalities: readonly ModalityEvidence[];
  readonly cues: readonly EmotionCue[];
  readonly status: 'complete' | 'partial' | 'failed';
}
/** Manual means an explicit local management edit, never a historical utterance. */
export type RecordOrigin = 'conversation' | 'automatic' | 'manual';
export interface MemoryReference {
  readonly origin?: RecordOrigin;
  readonly characterId: CharacterId;
  readonly id: string;
  readonly version: number;
  readonly text: string;
  readonly sourceIds: readonly string[];
}
export interface ConversationMessage {
  readonly emotionObservations?: readonly import('./emotion-state.js').EmotionObservation[];
  readonly emotionSnapshot?: import('./emotion-state.js').EmotionMessageSnapshot;
  readonly origin?: RecordOrigin;
  readonly characterId: CharacterId;
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: string;
}
export interface DialogueContext extends Scoped {
  readonly emotionBackground?: import('./emotion-state.js').EmotionBackground;
  readonly characterPrompt: string;
  readonly recent: readonly ConversationMessage[];
  readonly summary: string;
  readonly memories: readonly MemoryReference[];
  readonly perception: PerceptionResult | null;
  readonly inputTokenBudget: number;
}
export interface ExpressionIntent {
  /** Optional reviewed primary visual preset. null explicitly selects no primary preset. */
  readonly presetId?: string | null;
  readonly emotion: string;
  readonly intensity: number;
  readonly delivery: string;
  readonly gesture: string | null;
}
export interface DialogueRequest extends Scoped {
  readonly text: string;
  readonly context: DialogueContext;
  readonly memoryOutcome?: import('./memory-lifecycle.js').MemoryTurnOutcome;
  readonly memoryPending?: import('./memory-lifecycle.js').MemoryTurnPending;
}
export interface DialogueReply extends Scoped {
  readonly emotionAssessment?: import('./emotion-state.js').EmotionAssessment;
  /** Spoken words shared unchanged by display, assistant storage and TTS; stage directions belong in expression. */
  readonly text: string;
  readonly expression: ExpressionIntent;
}
export interface TtsRequest extends DialogueReply { readonly voiceId?: string }
export interface TtsResult extends Scoped {
  readonly audio: MediaAsset;
  readonly expression: ExpressionIntent;
  readonly durationMs: number | null;
  readonly synchronization: 'amplitude' | 'visemes' | 'none';
}
export type PlaybackEvent = Scoped & Timed & (
  | { readonly type: 'started'; readonly audioId: string; readonly timingBasis?: 'audio_output_timestamp' | 'audio_context_estimate' | 'device_observed' }
  | { readonly type: 'amplitude'; readonly value: number }
  | { readonly type: 'progress'; readonly positionMs: number; readonly durationMs: number | null }
  | { readonly type: 'ended' | 'stopped' }
  | { readonly type: 'error'; readonly message: string }
);
export interface PetPresentation extends Scoped {
  readonly state: 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
  readonly expression: ExpressionIntent;
  readonly mouth: number;
}
export type MemoryOperation =
  | { readonly type: 'add'; readonly id: string; readonly text: string; readonly sourceIds: readonly string[] }
  | { readonly type: 'update'; readonly id: string; readonly expectedVersion: number; readonly text: string; readonly sourceIds: readonly string[] }
  | { readonly type: 'merge'; readonly targets: readonly {readonly id: string; readonly expectedVersion: number}[]; readonly replacement: {readonly id: string; readonly text: string; readonly sourceIds: readonly string[]} }
  | { readonly type: 'soft_delete' | 'restore'; readonly id: string; readonly expectedVersion: number };
export interface MemoryChange extends Scoped {
  readonly operationId: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly operation: MemoryOperation;
}
export interface MemoryChangeResult {
  readonly characterId: CharacterId;
  readonly operationId: string;
  readonly status: 'applied' | 'conflict' | 'rejected';
  readonly affectedIds: readonly string[];
  readonly retrievalInvalidated: boolean;
  readonly reason?: string;
}
export interface MemoryMaintenanceInput extends Scoped {
  readonly messages: readonly ConversationMessage[];
  readonly relevantMemories: readonly MemoryReference[];
}
export interface ProactiveInvitation {
  readonly characterId: CharacterId;
  readonly id: string;
  readonly eventId: string;
  readonly text: string;
  readonly gesture: string;
  readonly eligibleAt: string;
  readonly expiresAt: string;
  readonly status: 'eligible' | 'shown' | 'ignored' | 'clicked' | 'expired';
}
/** Required explicit product configuration; no silent per-character or shared quota default. */
export interface RetentionPolicy { readonly transcriptQuotaScope: 'all_characters' | 'per_character'; readonly transcriptMaxBytes: number; readonly transcriptDays: number; readonly deletedMemoryDays: number }
export interface InvitationPolicy { readonly quotaScope: 'all_characters' | 'per_character'; readonly dailyMax: number; readonly minIntervalMs: number; readonly timezone: string }
export interface ProviderCapabilities {
  readonly id: string;
  readonly capabilities: readonly ('asr' | 'acoustic_emotion' | 'visual_emotion' | 'dialogue' | 'emotional_tts' | 'memory_maintenance' | 'embedding')[];
  readonly evidence: 'declared' | 'official_docs' | 'live_verified';
}
/** Dedicated ASR owns the original-language input text; never apply assistant spoken-text filters. */
export interface AsrInput extends Scoped { readonly audio: MediaAsset }
export interface AsrResult extends Scoped { readonly transcript: string; readonly audioEmotion?: PerceivedEmotion; readonly language?: string }
export interface AsrProvider { transcribe(input: AsrInput, signal: AbortSignal): Promise<AsrResult> }
/** No audio or transcript may cross the visual provider boundary. */
export interface VisualPerceptionInput extends Scoped { readonly images: readonly MediaAsset[] }
export interface VisualPerceptionResult extends Scoped {
  readonly emotion?: PerceivedEmotion;
  readonly modalities: readonly ModalityEvidence[];
  readonly status: 'complete' | 'partial' | 'failed';
}
export interface VisualPerceptionProvider { perceive(input: VisualPerceptionInput, signal: AbortSignal): Promise<VisualPerceptionResult> }
export interface PerceptionProvider { perceive(input: CapturedInput, signal: AbortSignal): Promise<PerceptionResult> }
export interface DialogueProvider { reply(input: DialogueRequest, signal: AbortSignal): Promise<DialogueReply> }
export interface TtsProvider { synthesize(input: TtsRequest, signal: AbortSignal): Promise<TtsResult> }
export interface MemoryMaintenanceProvider { propose(input: MemoryMaintenanceInput, signal: AbortSignal): Promise<readonly MemoryChange[]> }
export interface CapturePort {
  start(scope: TurnScope, signal: AbortSignal): Promise<void>;
  finish(scope: TurnScope): Promise<CapturedInput>;
  stop(scope: TurnScope): Promise<void>;
}
export interface PlaybackPort {
  play(input: TtsResult, emit: (event: PlaybackEvent) => void, signal: AbortSignal): Promise<void>;
  stop(scope: TurnScope): Promise<void>;
}
export interface MemoryPort {
  context(scope: TurnScope, text: string, perception: PerceptionResult | null, signal: AbortSignal): Promise<DialogueContext>;
  append(scope: TurnScope, messages: readonly ConversationMessage[]): Promise<void>;
  maintain(input: MemoryMaintenanceInput, signal: AbortSignal): Promise<readonly MemoryChangeResult[]>;
}
export type DesktopCommand =
  | { readonly type: 'submit_text'; readonly text: string; readonly clientRequestId?: string; readonly workBinding?: WorkInputBinding }
  | { readonly type: 'acknowledge_introduction'; readonly introductionId: string }
  | { readonly type: 'start_voice'; readonly clientRequestId?: string; readonly workBinding?: WorkInputBinding; readonly wakeKeyword?: string }
  | { readonly type: 'finish_voice' | 'cancel' }
  | { readonly type: 'click_invitation'; readonly invitationId: string };
export type DesktopEvent =
  | { readonly type: 'turn'; readonly input: TurnInput }
  /** Actual recognized voice text, emitted only after perception and current-scope validation. */
  | { readonly type: 'transcript'; readonly scope: TurnScope; readonly text: string }
  | { readonly type: 'presentation'; readonly presentation: PetPresentation }
  | { readonly type: 'reply'; readonly reply: DialogueReply }
  | { readonly type: 'playback'; readonly playback: PlaybackEvent }
  | { readonly type: 'invitation'; readonly invitation: ProactiveInvitation }
  | { readonly type: 'error'; readonly scope: TurnScope | null; readonly message: string };

/** Ephemeral scoped media; release on success/failure/cancel, including unused TTS results. */
export interface MediaStorePort {
  put(scope: TurnScope, bytes: Uint8Array, mimeType: string): Promise<MediaAsset>;
  read(scope: TurnScope, asset: MediaAsset): Promise<Uint8Array>;
  releaseScope(scope: TurnScope): Promise<void>;
}

export * from './memory-import.js';

export type * from './self-setup.js';

export type * from './emotion-state.js';
