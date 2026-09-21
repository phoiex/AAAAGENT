import { userFacingError } from './user-facing-error.js';
import type { CapturePort, CapturedInput, DesktopCommand, DesktopEvent, TurnInput, TurnScope } from '../contracts/index.js';
import { DialoguePipeline, type DialoguePorts } from './dialogue-pipeline.js';
import { TurnController } from './turn-controller.js';

type Active = { input: TurnInput; signal: AbortSignal; ready?: Promise<void>; finishing: boolean };
export interface RuntimePorts extends DialoguePorts { capture: CapturePort; onForegroundIdle?(): void }
/** Serializes short UI commands; device permission and model waits never block cancellation. */
export class DesktopRuntime {
  private readonly controller = new TurnController();
  private readonly pipeline: DialoguePipeline;
  private active: Active | undefined;
  private lastEmotionScope: TurnScope | undefined;
  private cleanupPending: TurnScope | undefined;
  private commands = Promise.resolve();
  private readonly jobs = new Set<Promise<void>>();
  private closed = false;
  attachWork(work: import('../contracts/desktop-work.js').DesktopWorkPort) { this.ports.work = work; }
  identity() { return this.controller.identity(); }
  isBusy(): boolean { return !!this.active || !!this.cleanupPending; }
  constructor(private readonly ports: RuntimePorts, private readonly emit: (event: DesktopEvent) => void, afterConversationSaved?: (scope: TurnScope, text: string) => void) {
    this.pipeline = new DialoguePipeline(ports, this.controller, emit, afterConversationSaved);
  }
  private presentation(): void {
    const presentation = this.controller.snapshot();
    if (presentation) this.emit({ type: 'presentation', presentation });
  }
  private track(job: Promise<void>): void {
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job));
  }
  private async stopCurrent(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    this.ports.work?.onInput();
    this.controller.cancel();
    this.presentation();
    const scope = active?.input.scope ?? this.cleanupPending;
    const emotionScope=scope??this.lastEmotionScope;
    if(emotionScope)this.ports.emotion?.cancel(emotionScope);
    this.lastEmotionScope=undefined;
    if (!scope) return;
    this.cleanupPending = scope;
    const results = await Promise.allSettled([
      this.ports.capture.stop(scope),
      this.ports.playback.stop(scope),
      this.ports.mediaStore.releaseScope(scope),
    ]);
    if (results.some(result => result.status === 'rejected')) {
      this.emit({ type: 'error', scope, message: '这一轮的清理尚未完成，请稍后再试。' });
      throw new Error('Unable to complete turn cleanup');
    }
    if (this.cleanupPending === scope) this.cleanupPending = undefined;
  }
  private async fail(active: Active, error: unknown): Promise<void> {
    if (this.active !== active || active.signal.aborted) return;
    const message = error instanceof Error ? error.message : 'Turn failed';
    this.controller.playback({ type: 'error', scope: active.input.scope, at: new Date().toISOString(), message });
    this.emit({ type: 'error', scope: active.input.scope, message });
    this.presentation();
    this.active = undefined;
    this.cleanupPending = active.input.scope;
    const cleanup = await Promise.allSettled([this.ports.capture.stop(active.input.scope), this.ports.playback.stop(active.input.scope), this.ports.mediaStore.releaseScope(active.input.scope)]);
    if (cleanup.every(result => result.status === 'fulfilled') && this.cleanupPending === active.input.scope) this.cleanupPending = undefined;
  }
  private run(active: Active, captured?: CapturedInput): void {
    this.track((async () => {
      try { await this.pipeline.run(active.input, active.signal, captured); }
      catch (error) { await this.fail(active, error); }
      finally { if (this.active === active) this.active = undefined; this.ports.onForegroundIdle?.(); }
    })());
  }
  dispatch(command: DesktopCommand): Promise<void> {
    const commandJob = this.commands.then(async () => {
      if (this.closed) throw new Error('Desktop runtime is closed');
      switch (command.type) {
        case 'cancel': await this.stopCurrent(); return;
        case 'acknowledge_introduction':
          throw new Error('Introduction acknowledgements belong to the profile boundary');
        case 'click_invitation':
          // Invitation ownership, expiry and quota must be resolved by the persisted invitation service.
          throw new Error('Invitation service is not connected');
        case 'finish_voice': {
          const active = this.active;
          if (!active || active.input.kind !== 'voice' || active.finishing) return;
          active.finishing = true;
          this.track((async () => {
            try {
              await active.ready;
              if (this.active !== active || active.signal.aborted) return;
              const captured = await this.ports.capture.finish(active.input.scope);
              if (this.active !== active || active.signal.aborted) { await this.ports.mediaStore.releaseScope(active.input.scope); return; }
              this.run(active, captured);
            } catch (error) { await this.fail(active, error); }
          })());
          return;
        }
        case 'submit_text': case 'start_voice': {
          if (command.type === 'submit_text' && !command.text.trim()) throw new Error('Text must not be empty');
          await this.stopCurrent();
          const turn = this.controller.begin(command.type === 'start_voice' ? 'voice' : 'text', command.type === 'submit_text' ? command.text : undefined);
          const input: TurnInput = { ...turn.input, ...(command.clientRequestId !== undefined ? { clientRequestId: command.clientRequestId } : {}), ...(command.type==='start_voice'&&command.wakeKeyword?{wakeKeyword:command.wakeKeyword}:{}) };
          const active: Active = { input, signal: turn.signal, finishing: false };
          this.active = active;
          this.lastEmotionScope=input.scope;
          this.ports.work?.beginInput?.(input.scope, command.workBinding);
          this.emit({ type: 'turn', input }); this.presentation();
          if (turn.input.kind === 'text') { this.run(active); return; }
          active.ready = this.ports.capture.start(turn.input.scope, turn.signal);
          this.track(active.ready.catch(error => this.fail(active, error)));
          return;
        }
      }
    });
    // A rejected command must not poison later cancellation or recovery commands.
    this.commands = commandJob.catch(() => {});
    return commandJob;
  }
  async drain(): Promise<void> {
    await this.commands;
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
  async close(): Promise<void> {
    await this.commands;
    this.closed = true;
    await this.stopCurrent();
    await this.ports.emotion?.close();
  }
}
