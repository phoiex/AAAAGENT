import type { CredentialInfo, ManagedSettings, ProviderAdapterInfo, SettingsSnapshot } from './management.js';
export const SELF_SETUP_VERSION = '0.3.0' as const;
export type SetupProvider = 'deepseek' | 'dashscope';
export type SetupVoiceModel = 'MiniMax/speech-2.8-turbo' | 'MiniMax/speech-2.8-hd';
export interface SetupIdentity { readonly instanceId:string }
export interface SetupCredential extends CredentialInfo { readonly provider:SetupProvider; readonly managed:boolean }
export interface SetupReference { readonly id:string; readonly format:'wav'|'mp3'|'m4a'; readonly bytes:number; readonly sha256:string; readonly durationMs:number; readonly createdAt:string }
/** Only local safe metadata. Never serialize provider responses, signed URLs or filesystem paths. */
export interface SetupVoiceOperation {
  readonly operationId:string; readonly revision:number;
  readonly phase:'prepared'|'cloning'|'clone_ready'|'activating'|'registered'|'failed'|'unknown'|'cancelled';
  readonly referenceId:string; readonly label:string; readonly targetModel:SetupVoiceModel; readonly credentialRef:string;
  readonly endpoint:string; readonly configRevision:number; readonly voiceId:string; readonly text:string;
  readonly cloneUpperBoundMicros:number; readonly activationUpperBoundMicros:number;
  readonly createdAt:string; readonly updatedAt:string; readonly errorCode:string|null;
  readonly retryAvailable?:boolean; // Only explicit, proven zero-charge refusal; never unknown outcomes.
  readonly demoAvailable:boolean; readonly activationAvailable:boolean;
}
export interface SelfSetupSnapshot {
  readonly apiVersion:1; readonly instanceId:string; readonly mode:'first-run'|'runtime';
  readonly credentialRevision:number; readonly credentials:readonly SetupCredential[];
  readonly adapters:readonly ProviderAdapterInfo[]; readonly settings:SettingsSnapshot;
  readonly references:readonly SetupReference[]; readonly operations:readonly SetupVoiceOperation[];
  readonly budget:{readonly mode:'bounded'|'unlimited';readonly limitMicros:number|null;readonly currency:'CNY'};
  readonly initialization:{readonly completed:boolean;readonly blockers:readonly string[]};
  readonly links:{readonly dashscopeConsole:string;readonly dashscopeKeys:string;readonly voiceClone:string;readonly voicePricing:string;readonly deepseekKeys:string;readonly harness:string;readonly codex:string};
}
export interface SaveSetupCredential extends SetupIdentity { readonly provider:SetupProvider; readonly key:string; readonly expectedRevision:number; readonly operationId:string }
export interface TestSetupCredential extends SetupIdentity { readonly provider:SetupProvider; readonly credentialRef:string; readonly operationId:string }
export interface CredentialTestResult { readonly provider:SetupProvider; readonly credentialRef:string; readonly ok:boolean; readonly error:string|null; readonly httpStatus:number|null; readonly checkedAt:string; readonly scope:'model-list-authentication' }
export interface UploadSetupReference extends SetupIdentity { readonly operationId:string; readonly filename:string; readonly audioBase64:string }
export interface PrepareSetupVoice extends SetupIdentity { readonly referenceId:string; readonly label:string; readonly targetModel:SetupVoiceModel; readonly credentialRef:string; readonly configRevision:number; readonly text:string }
export interface ConfirmSetupVoice extends SetupIdentity { readonly operationId:string; readonly expectedRevision:number; readonly costConsent:true }
export interface SelfSetupManagement {
  snapshot():SelfSetupSnapshot|Promise<SelfSetupSnapshot>;
  saveCredential(input:SaveSetupCredential):Promise<{credentialRef:string;revision:number;provider:SetupProvider}>;
  testCredential(input:TestSetupCredential):Promise<CredentialTestResult>;
  saveSettings(input:SetupIdentity&{expectedRevision:number;settings:ManagedSettings}):Promise<SettingsSnapshot>;
  uploadReference(input:UploadSetupReference,signal:AbortSignal):Promise<SetupReference>;
  prepareVoice(input:PrepareSetupVoice,signal:AbortSignal):Promise<SetupVoiceOperation>;
  confirmVoice(input:ConfirmSetupVoice,signal:AbortSignal):Promise<SetupVoiceOperation>;
  retryVoice(input:SetupIdentity&{operationId:string;expectedRevision:number}):Promise<SetupVoiceOperation>;
  cancelVoice(input:SetupIdentity&{operationId:string}):Promise<SetupVoiceOperation>;
  sample(input:SetupIdentity&{operationId:string;kind:'demo'|'activation'}):Promise<{bytes:Uint8Array;mimeType:string}>;
  finish(input:SetupIdentity&{expectedRevision:number}):Promise<{status:'prepared';requiresRestart:true}>;
  close():Promise<void>;
}
/* Same-origin/Bearer required for every request, including samples. No requests on selection alone.
 GET /api/self-setup -> SelfSetupSnapshot (works before a runtime exists)
 POST /api/self-setup/credentials SaveSetupCredential -> {credentialRef,revision,provider}; never echo key
 POST /api/self-setup/credentials/test TestSetupCredential -> CredentialTestResult; upstream failures remain HTTP200 results
 PUT /api/self-setup/settings {instanceId,expectedRevision,settings} -> SettingsSnapshot
 POST /api/self-setup/reference UploadSetupReference -> SetupReference; decoded audio <=20MiB, request<=28MiB
 POST /api/self-setup/voice/prepare PrepareSetupVoice -> SetupVoiceOperation; no cloud request
 POST /api/self-setup/voice/confirm ConfirmSetupVoice -> SetupVoiceOperation
   prepared -> cloning -> clone_ready; next explicit consent/revision -> activating -> registered.
   Unknown outcomes never automatically retry. Registered does not select/replace the active voice.
 POST /api/self-setup/voice/retry {instanceId,operationId,expectedRevision} -> new prepared operation, zero network; explicit refusal only
 POST /api/self-setup/voice/cancel {instanceId,operationId} -> SetupVoiceOperation
 GET /api/self-setup/voice/sample?instanceId=&operationId=&kind=demo|activation -> authenticated audio
 POST /api/self-setup/finish {instanceId,expectedRevision} -> {status:'prepared',requiresRestart:true}
 Runtime model/voice changes still require existing save + restart; no automatic app launch. Key-save UI tests authentication once; metadata refresh never tests.
 Browser secrets/audio stay in memory only; clear key field after save, never echo/localStorage/log.
 */
