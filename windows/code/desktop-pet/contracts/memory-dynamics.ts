import type { CharacterId, TurnScope } from './index.js';
import type { SourceVersion } from './memory-lifecycle.js';
import type { ManagedRecord } from './management.js';

export const MEMORY_DYNAMICS_VERSION = '0.1.0' as const;
export const MEMORY_DAY_TIME_ZONE = 'Asia/Shanghai' as const;
export type MemoryImportance = 0 | 0.5 | 1;

/** Engineering limits for small edits, not user-specified numeric limits. */
export const MEMORY_POLICY_LIMITS = Object.freeze({
  baseHalfLifeDays: [15, 60] as const,
  emotionHalfLifeDays: [3.5, 14] as const,
  baselineWeight: [0.50, 0.60] as const,
  activationWeight: [0.20, 0.30] as const,
  importanceWeight: [0.10, 0.20] as const,
  emotionWeight: [0, 0.10] as const,
});
export interface MemoryDynamicsPolicy {
  readonly baseHalfLifeDays: number;
  readonly emotionHalfLifeDays: number;
  readonly baselineWeight: number;
  readonly activationWeight: number;
  readonly importanceWeight: number;
  readonly emotionWeight: number;
}
/** Fixed algorithm: H=base*(1+2*S); reinforcement=.2; P>=.35; at most six. */
export const DEFAULT_MEMORY_DYNAMICS_POLICY: Readonly<MemoryDynamicsPolicy> = Object.freeze({
  baseHalfLifeDays: 30, emotionHalfLifeDays: 7,
  baselineWeight: .55, activationWeight: .25, importanceWeight: .15, emotionWeight: .05,
});
export interface MemoryPolicyVersion {
  readonly revision: number;
  readonly effectiveAt: string;
  readonly policy: MemoryDynamicsPolicy;
  readonly restoredFromRevision: number | null;
}
/** Missing/invalid numeric fallback is zero, without claiming a neutral observation. */
export interface MemoryEmotionEvidence {
  readonly status: 'missing' | 'invalid' | 'observed';
  readonly intensity: number | null;
  readonly sources: readonly SourceVersion[];
  readonly observation: string | null;
}
/** Optional proposed extraction. Storage must validate evidence before accepting it. */
export interface MemoryDynamicsTraits {
  readonly category: 'event' | 'stable_profile' | 'unassessed';
  readonly importance: MemoryImportance;
  readonly evidenceSources: readonly SourceVersion[];
  readonly emotion: MemoryEmotionEvidence;
}
export interface MemoryDynamicsPlan {
  readonly traits: readonly {
    readonly recordId: string;
    /** Resulting record version after this plan's structural changes. */
    readonly expectedVersion: number;
    readonly traits: MemoryDynamicsTraits;
  }[];
  readonly reinforcements: readonly {
    readonly recordId: string;
    readonly expectedVersion: number;
    readonly source: SourceVersion;
    readonly kind: 'reiteration' | 'confirmation';
  }[];
}
export interface MemoryDynamicsState {
  readonly recordId: string;
  readonly recordVersion: number;
  readonly lineageIds: readonly string[];
  readonly traits: MemoryDynamicsTraits;
  readonly activation: number;
  readonly emotion: number;
  readonly halfLifeDays: number | null;
  readonly anchorAt: string;
  readonly evaluatedAt: string;
  readonly lastReinforcedDay: string | null;
  readonly policyRevision: number;
}
export interface MemoryDynamicsItem {
  readonly record: Omit<ManagedRecord, 'kind'> & { readonly kind: ManagedRecord['kind'] | 'emotion' };
  readonly dynamics: MemoryDynamicsState | null;
  readonly relatedIds: readonly string[];
}
export interface MemoryDynamicsPageQuery {
  readonly characterId: CharacterId;
  readonly query: string;
  readonly state: 'active' | 'all';
  readonly offset: number;
  readonly limit: number;
}
export interface MemoryDynamicsSnapshot {
  readonly characterId: CharacterId;
  readonly dataRevision: number;
  readonly evaluatedAt: string;
  readonly policy: MemoryPolicyVersion;
  readonly policyHistory: readonly MemoryPolicyVersion[];
  readonly items: readonly MemoryDynamicsItem[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly timeZone: typeof MEMORY_DAY_TIME_ZONE;
}
export type MemoryRecallOmission = 'hard_gate' | 'no_cue' | 'below_threshold' | 'limit' | 'budget' | null;
export interface MemoryRecallCandidate {
  readonly emotionAffinity?: 0 | 1;
  readonly source: SourceVersion;
  readonly activation: number;
  readonly importance: MemoryImportance;
  readonly emotion: number;
  readonly relevance: number;
  readonly priority: number;
  readonly matchedTerms: readonly string[];
  readonly cueKind: 'keywords' | 'phrase' | 'supported_relation' | 'none';
  readonly selected: boolean;
  readonly omission: MemoryRecallOmission;
}
/** Store source references, not a second copy of user text. Filter forgotten sources on read. */
export interface MemoryRecallTrace {
  readonly id: string;
  readonly kind: 'actual';
  readonly scope: TurnScope;
  readonly dataRevision: number;
  readonly policyRevision: number;
  readonly evaluatedAt: string;
  readonly candidates: readonly MemoryRecallCandidate[];
  readonly countedInputTokens: number;
  readonly recentContext?: { readonly messageIds: readonly string[]; readonly omittedIds: readonly string[]; readonly policy: 'normal' | 'post_privacy_boundary' };
  readonly inputTokenBudget: number;
  readonly status: 'assembled' | 'consumed' | 'invalidated';
}
export interface MemoryRecallTracePage {
  readonly characterId: CharacterId;
  readonly records: readonly MemoryRecallTrace[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}
export interface MemoryPolicyPreviewInput {
  readonly characterId: CharacterId;
  readonly query: string;
  /** ISO future instant, or 'now' resolved once inside the store's read transaction. */
  readonly evaluatedAt: string;
  readonly expectedDataRevision: number;
  readonly expectedPolicyRevision: number;
  readonly policy: MemoryDynamicsPolicy;
}
/** Pure preview at a frozen revision; never persists a trace, strengthens or calls a model. */
export interface MemoryPolicyPreview {
  readonly kind: 'preview';
  readonly characterId: CharacterId;
  readonly dataRevision: number;
  readonly policyRevision: number;
  readonly evaluatedAt: string;
  readonly effectiveFrom: string;
  readonly before: readonly MemoryRecallCandidate[];
  readonly after: readonly MemoryRecallCandidate[];
}
export interface MemoryPolicySave {
  readonly characterId: CharacterId;
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly policy: MemoryDynamicsPolicy;
}
export interface MemoryPolicyRollback {
  readonly characterId: CharacterId;
  readonly expectedRevision: number;
  readonly targetRevision: number;
  readonly operationId: string;
}
export interface MemoryRecordAction {
  readonly characterId: CharacterId;
  readonly id: string;
  readonly expectedVersion: number;
  readonly operationId: string;
  readonly reason: string;
}
export interface MemoryRecordActionResult {
  readonly characterId: CharacterId;
  readonly revision: number;
  readonly affectedIds: readonly string[];
  readonly status: 'applied';
}
export interface MemoryDynamicsManagementPort {
  snapshot(query: MemoryDynamicsPageQuery): MemoryDynamicsSnapshot | Promise<MemoryDynamicsSnapshot>;
  traces(query: { characterId: CharacterId; offset: number; limit: number }): MemoryRecallTracePage | Promise<MemoryRecallTracePage>;
  preview(input: MemoryPolicyPreviewInput): MemoryPolicyPreview | Promise<MemoryPolicyPreview>;
  savePolicy(input: MemoryPolicySave): MemoryPolicyVersion | Promise<MemoryPolicyVersion>;
  rollbackPolicy(input: MemoryPolicyRollback): MemoryPolicyVersion | Promise<MemoryPolicyVersion>;
  forget(input: MemoryRecordAction): MemoryRecordActionResult | Promise<MemoryRecordActionResult>;
  restore(input: MemoryRecordAction): MemoryRecordActionResult | Promise<MemoryRecordActionResult>;
}
