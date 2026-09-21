import type { DialogueContext, PerceptionResult, TurnScope } from '../contracts/index.js';
import type { EmotionAssessment, EmotionInferenceInput, EmotionInferenceProvider, EmotionObservation, EmotionStatePort, EmotionTurnPort } from '../contracts/emotion-state.js';
import { normalizeUserEmotion } from '../providers/emotion-inference.js';
import type { SourceVersion } from '../contracts/memory-lifecycle.js';
import type { SqliteMemoryStore } from '../memory/sqlite-store.js';

/** Existing foreground result first; optional stronger inference is detached and disabled unless injected. */
export class EmotionTurns implements EmotionTurnPort {
  private closed=false;
  private readonly jobs=new Map<string,{scope:TurnScope;controller:AbortController}>();
  constructor(private readonly state:EmotionStatePort,private readonly store:SqliteMemoryStore,
    private readonly backgroundProvider?:EmotionInferenceProvider) {}
  observations(scope:TurnScope,message:SourceVersion,text:string,perception:PerceptionResult|null):readonly EmotionObservation[] {
    const sources=[{...message}],out:EmotionObservation[]=[];
    if(perception?.scope.turnId===scope.turnId && perception.scope.sessionId===scope.sessionId && perception.scope.characterId===scope.characterId && perception.scope.generation===scope.generation){
      for(const [field,modality,provenance] of [['audioEmotion','audio','audio'],['visualEmotion','image','video']] as const){
        const label=perception[field];
        if(label&&perception.modalities.some(m=>m.modality===modality&&m.status==='used'))out.push({subject:'user',label,intensity:null,confidence:null,provenance,sources});
      }
    }
    // Only a short explicit first-person present-state statement; inference handles complex language.
    const explicit=/^(?:我|我现在|我今天|我这会儿)(?:真的|有点|很|挺|特别)?(难过|伤心|开心|高兴|生气|害怕|惊讶|平静|烦躁)[。！!，,\s]*$/.exec(text.trim());
    const labels:Record<string,string>={难过:'sad',伤心:'sad',开心:'happy',高兴:'happy',生气:'angry',害怕:'fear',惊讶:'surprise',平静:'neutral',烦躁:'angry'};
    if(explicit)out.push({subject:'user',label:labels[explicit[1]!]!,intensity:null,confidence:null,provenance:'user_explicit',sources});
    else if(/^(?:我|我现在)(?:并|真的)?不(?:难过|伤心|生气|害怕|开心|高兴)(?:了)?[。！!，,\s]*$/.test(text.trim()))out.push({subject:'user',label:'unknown',intensity:null,confidence:null,provenance:'user_explicit',sources});
    return out;
  }
  prepare(context:DialogueContext,message:SourceVersion,text:string):EmotionInferenceInput|null {
    if(this.closed || !context.emotionBackground || this.store.pending.has(context.scope.characterId))return null;
    const current=this.store.inspect(context.scope,message.id);
    if(!current||current.version!==message.version||current.state!=='active'||current.text!==text)return null;
    // Reuse exact issued selections: summaries/memories may influence the same foreground model.
    // Keeping their source versions also prevents emotional state from surviving their correction.
    const evidence=this.store.lifecycle.contextSources(context);
    const ticket=this.state.prepare(context.scope,{id:current.id,version:current.version},evidence);
    return structuredClone({ticket,text,recent:context.recent,background:ticket.background,perception:context.perception});
  }
  complete(input:EmotionInferenceInput,assessment:EmotionAssessment|undefined):void {
    if(this.closed)return;
    // Source identity comes from the frozen host ticket, never from provider-supplied IDs.
    const bind=(value:EmotionAssessment):EmotionAssessment=>({
      user:value.user&&normalizeUserEmotion(value.user.label)?{...value.user,label:normalizeUserEmotion(value.user.label)!,subject:'user',provenance:'text_recent_context',sources:input.ticket.evidence}:null,
      companion:value.companion?{...value.companion,subject:'companion',provenance:'companion_inference',sources:input.ticket.evidence}:null});
    try {
      if(assessment?.user||assessment?.companion||!this.backgroundProvider){this.state.apply(input.ticket,bind(assessment??{user:null,companion:null}),'dialogue');return;}
      const controller=new AbortController();this.jobs.set(input.ticket.id,{scope:input.ticket.scope,controller});
      const frozen=structuredClone(input);
      void Promise.resolve().then(()=>{if(this.closed||controller.signal.aborted)throw Error('cancelled');return this.backgroundProvider!.infer(frozen,controller.signal);}).then(result=>{
        if(!this.closed&&!controller.signal.aborted)this.state.apply(input.ticket,bind(result),'background');
      }).catch(()=>{if(!this.closed&&!controller.signal.aborted)this.state.cancel(input.ticket.scope);}).finally(()=>this.jobs.delete(input.ticket.id));
    } catch { this.state.cancel(input.ticket.scope); /* Optional assessment cannot fail a foreground reply. */ }
  }
  cancel(scope:TurnScope):void {
    for(const [id,job] of this.jobs)if(job.scope.characterId===scope.characterId&&job.scope.sessionId===scope.sessionId&&job.scope.turnId===scope.turnId&&job.scope.generation===scope.generation){job.controller.abort();this.jobs.delete(id);}
    if(!this.closed)this.state.cancel(scope);
  }
  async close():Promise<void> {
    if(this.closed)return;
    for(const job of this.jobs.values()){job.controller.abort();this.state.cancel(job.scope);}
    this.jobs.clear();this.closed=true;
  }
}
