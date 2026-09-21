import type { CharacterId, ConversationMessage, DialogueContext, PerceptionResult, TurnScope } from './index.js';
import type { SourceVersion } from './memory-lifecycle.js';

export const EMOTION_STATE_VERSION = '0.1.1' as const;
export type EmotionSubject = 'user' | 'companion';
export type EmotionProvenance = 'user_explicit' | 'text_recent_context' | 'audio' | 'video' | 'companion_inference';
/** Observation and intensity are distinct; a class or expression amplitude never supplies intensity. */
export interface EmotionObservation {
  readonly subject: EmotionSubject;
  readonly label: string;
  readonly intensity: number | null;
  readonly confidence: number | null;
  readonly provenance: EmotionProvenance;
  readonly sources: readonly SourceVersion[];
}
export interface SustainedEmotion {
  readonly subject: EmotionSubject;
  readonly revision: number;
  readonly observation: EmotionObservation | null;
  readonly updatedAt: string | null;
  readonly sourceMessage: SourceVersion | null;
  readonly logicalOrder: number | null;
  readonly sessionId: string | null;
}
export interface EmotionBackground {
  readonly user: SustainedEmotion;
  readonly companion: SustainedEmotion;
}
/** Frozen when a real transcript is saved. Ordinary state updates never rewrite this payload. */
export interface EmotionMessageSnapshot {
  readonly role: 'user' | 'assistant';
  readonly message: SourceVersion;
  readonly scope: TurnScope;
  readonly logicalOrder: number;
  readonly recordedAt: string;
  readonly observations: readonly EmotionObservation[];
  readonly background: EmotionBackground;
}
/** Issued against the current user message, evidence versions and current U/M revisions. No raw text. */
export interface EmotionTicket {
  readonly background: EmotionBackground;
  readonly id: string;
  readonly scope: TurnScope;
  readonly message: SourceVersion;
  readonly logicalOrder: number;
  readonly evidence: readonly SourceVersion[];
  readonly userRevision: number;
  readonly companionRevision: number;
}
export interface EmotionAssessment {
  readonly user: EmotionObservation | null;
  readonly companion: EmotionObservation | null;
}
export interface EmotionAnalysis {
  readonly id: string;
  readonly message: SourceVersion;
  readonly scope: TurnScope;
  readonly completedAt: string;
  readonly origin: 'dialogue' | 'background';
  readonly assessment: EmotionAssessment | null;
  readonly appliedSubjects: readonly EmotionSubject[];
  readonly status: 'applied' | 'stale' | 'cancelled' | 'invalid';
}
export interface EmotionStateSnapshot extends EmotionBackground {
  readonly characterId: CharacterId;
  readonly revision: number;
  readonly pending: number;
  readonly messages: readonly EmotionMessageSnapshot[];
  /** Only analyses associated with this page of messages; invalid payloads are null. */
  readonly analyses: readonly EmotionAnalysis[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
/** Local store boundary. Privacy filtering removes invalid evidence, including inherited backgrounds. */
export interface EmotionStatePort {
  captureMessage(scope: TurnScope, message: SourceVersion, observations: readonly EmotionObservation[]): EmotionMessageSnapshot;
  background(scope: TurnScope): EmotionBackground;
  message(scope: TurnScope, messageId: string): EmotionMessageSnapshot | null;
  prepare(scope: TurnScope, message: SourceVersion, evidence: readonly SourceVersion[]): EmotionTicket;
  /** U/M CAS independently; failed subjects carry no payload. Sources/turn invalidation rejects both. */
  apply(ticket: EmotionTicket, assessment: EmotionAssessment, origin: EmotionAnalysis['origin']): EmotionAnalysis;
  cancel(scope: TurnScope): void;
  snapshot(characterId: CharacterId, offset: number, limit: number): EmotionStateSnapshot;
  /** Called after source changes/forgetting/expiry; ordinary updates do not touch memory revision/epoch. */
  invalidate(): void;
  /** Binary tie aid only after unchanged existing relevance/priority; never bypasses privacy/cue gates. */
  /** 1 iff valid current U label matches a valid user observation under candidate source lineage; otherwise0. */
  affinity(scope: TurnScope, sources: readonly SourceVersion[]): number;
}
/** Frozen at the original turn. Providers receive no live store or callback to fetch future messages. */
export interface EmotionInferenceInput {
  readonly ticket: EmotionTicket;
  readonly text: string;
  readonly recent: readonly ConversationMessage[];
  readonly background: EmotionBackground;
  readonly perception: PerceptionResult | null;
}
export interface EmotionInferenceProvider {
  infer(input: EmotionInferenceInput, signal: AbortSignal): Promise<EmotionAssessment>;
}
/** Optional host hook. Background scheduling must return immediately and owns cancel/close. */
export interface EmotionTurnPort {
  observations(scope: TurnScope, message: SourceVersion, text: string, perception: PerceptionResult | null): readonly EmotionObservation[];
  prepare(context: DialogueContext, message: SourceVersion, text: string): EmotionInferenceInput | null;
  complete(input: EmotionInferenceInput, assessment: EmotionAssessment | undefined): void;
  cancel(scope: TurnScope): void;
  close(): Promise<void>;
}
export interface EmotionManagement {
  snapshot(characterId: CharacterId, offset: number, limit: number): EmotionStateSnapshot | Promise<EmotionStateSnapshot>;
}
export interface EmotionManagementResponse extends EmotionStateSnapshot {
  readonly instanceId: string;
  readonly version: typeof EMOTION_STATE_VERSION;
}
