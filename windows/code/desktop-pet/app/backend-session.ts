import { WorkSpeech, type WorkStatusNotice } from '../core/work-speech.js';
import type { DesktopWorkAction, DesktopWorkPort, WorkInputBinding } from '../contracts/desktop-work.js';
import { PRODUCT_CHARACTERS, type CompanionProfilePort } from '../contracts/character.js';
import { DESKTOP_BRIDGE_VERSION, type BackendToDesktop } from '../contracts/desktop-bridge.js';
import type { DesktopCommand, MemoryMaintenanceInput, MemoryPort, TurnScope } from '../contracts/index.js';
import type { DialoguePorts } from '../core/dialogue-pipeline.js';
import { DesktopRuntime } from '../core/desktop-runtime.js';
import { RoleMaintenanceQueue } from '../core/maintenance-queue.js';
import { RoleMemoryLifecycleQueue } from '../core/memory-lifecycle-queue.js';
import type { BackgroundMemoryPort, MemoryPendingObservation, MemoryTurnPort, SummaryPort, ForegroundMemoryRequest } from '../contracts/memory-lifecycle.js';
import { DesktopDeviceBridge } from './desktop-device-bridge.js';

export interface PersistentMemoryPort extends MemoryPort { maintenanceInput(scope: TurnScope, text: string): MemoryMaintenanceInput }
export interface BackendPorts extends Omit<DialoguePorts, 'playback' | 'memory' | 'memoryLifecycle' | 'backgroundMemory'> {
  memory: PersistentMemoryPort;
  createEmotion?: () => import('../contracts/emotion-state.js').EmotionTurnPort;
  companionProfile?: CompanionProfilePort;
  consumeWakeHit?: (hit: unknown) => string | undefined;
  lifecycleMemory?: PersistentMemoryPort & MemoryTurnPort & SummaryPort;
  backgroundMemory?: PersistentMemoryPort & BackgroundMemoryPort & SummaryPort;
  classifyMemoryRequest?: (scope: TurnScope, text: string, signal: AbortSignal) => ForegroundMemoryRequest | Promise<ForegroundMemoryRequest>;
  /** Trusted application policy only; desktop commands cannot opt themselves into this path. */
  isMemoryIndependent?: (scope: TurnScope, text: string, signal: AbortSignal, pending: MemoryPendingObservation) => boolean | Promise<boolean>;
}
export function parseWorkAction(value: unknown): DesktopWorkAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid work action');
  const a = value as Record<string, unknown>;
  const id = (v: unknown): string => { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(v)) throw Error('Invalid work identity'); return v; };
  const version = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 1) throw Error('Invalid work version'); return Number(v); };
  if(a.type==='clear_unknown_reminders'){
    if(!Array.isArray(a.records)||a.records.length>10000)throw Error('Invalid reminder selection');
    return {type:'clear_unknown_reminders',records:a.records.map(record=>{if(!record||typeof record!=='object'||Array.isArray(record))throw Error('Invalid reminder');const r=record as Record<string,unknown>;return {id:id(r.id),expectedVersion:version(r.expectedVersion)};})};
  }
  if(a.type==='open_native')return {type:'open_native',id:id(a.id)};
  if(a.type==='reprepare'||a.type==='replan'){
    if(typeof a.text!=='string'||!a.text.trim()||a.text.length>20000||a.text.includes('\\0'))throw Error('Invalid work text');
    const base={draftId:id(a.draftId),expectedVersion:version(a.expectedVersion),text:a.text};
    if(a.type==='replan')return {type:'replan',...base};
    if(!['codex','harness'].includes(String(a.executor))||(a.projectId===undefined)!==(a.projectVersion===undefined))throw Error('Invalid work executor');
    const target=a.target as Record<string,unknown>|undefined;
    if(a.executor==='codex'&&(!target||target.hostId!=='local')||a.executor==='harness'&&target!==undefined)throw Error('Invalid work target');
    return {type:'reprepare',...base,executor:a.executor as 'codex'|'harness',
      ...(target?{target:{hostId:'local',threadId:id(target.threadId)}}:{}),
      ...(a.projectId===undefined?{}:{projectId:id(a.projectId),projectVersion:version(a.projectVersion)})};
  }
  if (a.type === 'confirm') return { type: 'confirm', id: id(a.id), expectedVersion: version(a.expectedVersion) };
  if (a.type === 'refresh' || a.type === 'focus') return { type: a.type, ...(a.id === undefined ? {} : { id: id(a.id) }) };
  if (a.type === 'dismiss') return { type: 'dismiss', ...(a.draftId === undefined ? {} : { draftId: id(a.draftId) }) };
  if (a.type === 'revise') {
    if (typeof a.text !== 'string' || !a.text.trim() || a.text.length > 20000 || a.text.includes('\0')) throw Error('Invalid work text');
    return { type: 'revise', draftId: id(a.draftId), expectedVersion: version(a.expectedVersion), text: a.text };
  }
  if (a.type === 'select') {
    const target = a.target as Record<string, unknown> | undefined;
    if (!target || target.hostId !== 'local' || (a.projectId === undefined) !== (a.projectVersion === undefined)) throw Error('Invalid work target');
    return { type: 'select', draftId: id(a.draftId), expectedVersion: version(a.expectedVersion), target: { hostId: 'local', threadId: id(target.threadId) },
      ...(a.projectId === undefined ? {} : { projectId: id(a.projectId), projectVersion: version(a.projectVersion) }) };
  }
  throw Error('Unknown work action');
}
function parseWorkBinding(value: unknown): WorkInputBinding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid work binding');
  const b = value as Record<string, unknown>;
  const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v);
  const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
  if (!id(b.draftId) || !version(b.draftVersion) || (b.requestId === undefined) !== (b.requestVersion === undefined)
    || b.requestId !== undefined && (!id(b.requestId) || !version(b.requestVersion))) throw Error('Invalid work binding');
  return {draftId:b.draftId,draftVersion:b.draftVersion,...(b.requestId===undefined?{}:{requestId:b.requestId as string,requestVersion:b.requestVersion as number})};
}
export function parseDesktopCommand(value: unknown): DesktopCommand {
  if (!value || typeof value !== 'object') throw new Error('Invalid desktop command');
  const command = value as Record<string, unknown>;
  const binding = command.type === 'submit_text' || command.type === 'start_voice' ? parseWorkBinding(command.workBinding) : undefined;
  switch (command.type) {
    case 'submit_text': if (typeof command.text !== 'string' || !command.text.trim()) throw new Error('Text must not be empty'); if (command.clientRequestId !== undefined && (typeof command.clientRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.clientRequestId))) throw new Error('Invalid text request ID'); return { type: 'submit_text', text: command.text, ...(binding ? {workBinding:binding}:{}), ...(command.clientRequestId === undefined ? {} : { clientRequestId: command.clientRequestId as string }) };
    case 'acknowledge_introduction':
      if (typeof command.introductionId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(command.introductionId)) throw new Error('Invalid introduction ID');
      return { type: 'acknowledge_introduction', introductionId: command.introductionId };
    case 'start_voice': {
      if (command.clientRequestId !== undefined && (typeof command.clientRequestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(command.clientRequestId))) throw new Error('Invalid voice request ID');
      return { type: 'start_voice', ...(binding ? {workBinding:binding}:{}), ...(command.clientRequestId === undefined ? {} : { clientRequestId: command.clientRequestId as string }) };
    }
    case 'finish_voice': case 'cancel': return { type: command.type };
    case 'click_invitation': if (typeof command.invitationId !== 'string' || !command.invitationId) throw new Error('Missing invitation ID'); return { type: command.type, invitationId: command.invitationId };
    default: throw new Error('Unsupported desktop command');
  }
}
/** Trusted Node-side session. The shell only sends commands and device responses. */
export class BackendSession {
  private readonly devices: DesktopDeviceBridge;
  private readonly maintenance: RoleMaintenanceQueue | RoleMemoryLifecycleQueue;
  private readonly runtime: DesktopRuntime;
  private work?: DesktopWorkPort;
  private readonly workSpeech: WorkSpeech;
  notifyWork(notice: WorkStatusNotice) { this.workSpeech.notify(notice); }
  attachWork(work: DesktopWorkPort) { this.work = work; this.runtime.attachWork(work); }
  private readonly profile: CompanionProfilePort | undefined;
  private readonly consumeWakeHit: BackendPorts['consumeWakeHit'];
  constructor(ports: BackendPorts, private readonly send: (message: BackendToDesktop) => void, private readonly closeStore: () => void, reportBackgroundFailure: (scope: TurnScope, kind: 'memory' | 'summary') => void = () => {}) {
    this.profile = ports.companionProfile;
    this.consumeWakeHit = ports.consumeWakeHit;
    this.devices = new DesktopDeviceBridge(ports.mediaStore, send);
    if (ports.lifecycleMemory && ports.lifecycleMemory !== ports.memory) throw new Error('Lifecycle and dialogue must share the same memory port');
    if (ports.backgroundMemory && ports.backgroundMemory !== ports.memory) throw new Error('Background and dialogue must share the same memory port');
    if (ports.isMemoryIndependent && !ports.backgroundMemory) throw new Error('Independent scheduling requires the background memory capability');
    const lifecyclePort = ports.backgroundMemory ?? ports.lifecycleMemory;
    const lifecycle = lifecyclePort ? new RoleMemoryLifecycleQueue(lifecyclePort, (scope, _error, kind) => reportBackgroundFailure(scope, kind ?? 'summary')) : undefined;
    this.maintenance = lifecycle ?? new RoleMaintenanceQueue(ports.memory, (scope, text) => ports.memory.maintenanceInput(scope, text), scope => reportBackgroundFailure(scope, 'memory'));
    const { backgroundMemory: _background, isMemoryIndependent, classifyMemoryRequest, createEmotion, ...runtimePorts } = ports;
    const emotion=createEmotion?.()??ports.emotion;
    this.runtime = new DesktopRuntime({ ...runtimePorts, ...(emotion?{emotion}:{}), ...(lifecycle ? { memoryLifecycle: lifecycle } : {}),
      ...(ports.backgroundMemory && lifecycle ? { backgroundMemory: {
        isIndependent: async (scope: TurnScope, text: string, signal: AbortSignal) => {
          const pending = lifecycle.observePending(scope.characterId);
          const independent = await isMemoryIndependent?.(scope, text, signal, pending) === true;
          signal.throwIfAborted();
          try { pending.assertCurrent(); } catch { return false; }
          return independent;
        },
        ...(classifyMemoryRequest ? {classifyRequest:classifyMemoryRequest} : {}),
        beginPendingMutation:lifecycle.beginPendingMutation.bind(lifecycle),
        enqueueTurn: lifecycle.enqueueTurn.bind(lifecycle), foregroundContext: lifecycle.foregroundContext.bind(lifecycle),
        appendForegroundAssistant: lifecycle.appendForegroundAssistant.bind(lifecycle), assertContextCurrent: lifecycle.assertContextCurrent.bind(lifecycle),
      } } : {}), onInputRoute: (scope, route) => send({ channel: 'input_route', scope, route }), onForegroundIdle: () => this.workSpeech.flush(), capture: ports.outputMode==='text'?{start:async()=>{throw Error('Text channel cannot capture');},finish:async()=>{throw Error('Text channel cannot capture');},stop:async()=>{}}:this.devices.capture, playback: ports.outputMode==='text'?{play:async()=>{throw Error('Text channel cannot play');},stop:async()=>{}}:this.devices.playback }, event => send({ channel: 'event', event }), (scope, text) => {
      if (this.maintenance instanceof RoleMemoryLifecycleQueue) this.maintenance.afterConversationSaved(scope);
      else this.maintenance.enqueue(scope, text);
    });
    this.workSpeech = new WorkSpeech({ identity: () => this.runtime.identity(), busy: () => this.runtime.isBusy(), tts: ports.tts, playback: this.devices.playback, media: ports.mediaStore, emit: event => send({channel:'work_speech',event}) });
    const introduction = this.profile?.introduction();
    send({ channel: 'backend_ready', bridgeVersion: DESKTOP_BRIDGE_VERSION, ...this.runtime.identity(), ...(introduction ? { introduction } : {}) });
  }
  async receiveLine(line: string): Promise<void> {
    try {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid desktop message');
      const message = raw as Record<string, unknown>;
      if (message.channel === 'command') {
        let command = parseDesktopCommand(message.command);
        if(command.type==='start_voice'){
          const hit=(message.command as Record<string,unknown>).wakeHit;
          if(hit!==undefined){
            const keyword=this.consumeWakeHit?.(hit);
            if(!keyword)throw Error('Expired local wake hit');
            command={...command,wakeKeyword:keyword};
          }
        }
        if (['cancel','submit_text','start_voice','click_invitation'].includes(command.type)) this.workSpeech.onInput();
        if (command.type === 'acknowledge_introduction') {
          if (!this.profile) throw new Error('Companion profile unavailable');
          this.profile.acknowledgeIntroduction(command.introductionId);
        } else await this.runtime.dispatch(command);
      }
      else if (message.channel === 'work_action') { if (!this.work) throw Error('Work routing unavailable'); await this.work.action(parseWorkAction(message.action)); }
      else this.devices.receive(raw);
    } catch {
      // Never echo untrusted command bodies, transient media or provider errors to logs/UI.
      this.send({ channel: 'event', event: { type: 'error', scope: null, message: '这次操作没有完成，可以停止后重试。' } });
    }
  }
  async drainForeground(): Promise<void> { await this.runtime.drain(); }
  async drain(): Promise<void> { await this.runtime.drain(); await this.workSpeech.drain(); await this.maintenance.drain(); }
  retryPendingMemory(scope:TurnScope,id:string,text:string) {
    if(!(this.maintenance instanceof RoleMemoryLifecycleQueue))throw new Error('Background memory is unavailable');
    return this.maintenance.enqueueTurn(scope,id,text);
  }
  pendingMemoryJobs() {
    const queue = this.maintenance;
    return queue instanceof RoleMemoryLifecycleQueue
      ? PRODUCT_CHARACTERS.map(({ id }) => queue.observePending(id).snapshot) : [];
  }
  async close(): Promise<void> {
    // EOF means no more device acknowledgements are possible. Reject waits before cleanup.
    this.devices.close();
    await this.workSpeech.close();
    try { await this.runtime.close(); } catch { /* Device teardown belongs to the closing native shell. */ }
    await this.work?.close();
    await this.maintenance.close(); await this.runtime.drain(); this.closeStore();
  }
}
