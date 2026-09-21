import { normalizeApiKey } from '../core/api-key.js';
import { isPrivateFileSync, restrictPrivatePathSync } from '../core/platform-files.js';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ManagementError } from '../contracts/management.js';

export type ManagedCredentialProvider = 'dashscope' | 'deepseek';
export interface ManagedCredentialEntry { readonly id:string; readonly provider:ManagedCredentialProvider; readonly file:string; readonly createdAt:string; readonly operationId:string }
interface StoredEntry { id:string; provider:ManagedCredentialProvider; name:string; createdAt:string; operationId:string }
interface State { version:1; revision:number; entries:StoredEntry[] }
const fail=(code:'invalid_request'|'version_conflict'|'unavailable',message:string):never=>{throw new ManagementError(code,message);};
const outside=(parent:string,target:string)=>{const part=relative(resolve(parent),resolve(target));return part==='..'||part.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(part);};
export const managedCredentialId=(file:string,provider:ManagedCredentialProvider)=>provider+'-'+createHash('sha256').update(file).digest('hex').slice(0,12);
/** Per-install metadata and immutable key files. Nothing is created by viewing the page. */
export function managedCredentialDirectory(projectRoot:string, home=homedir()):string {
  return resolve(home,'.aaaagent','credentials',createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0,24));
}
function assertOwned(path:string,directory=false):void {
  const stat=lstatSync(path);
  if(stat.isSymbolicLink() || (directory?!stat.isDirectory():!stat.isFile()) || (process.platform==='win32' ? !directory&&!isPrivateFileSync(path) : (stat.mode&0o077)!==0 || process.getuid&&stat.uid!==process.getuid()))
    fail('unavailable','本机凭据存储权限不符合要求。');
}
function readOwned(path:string):string {
  assertOwned(path);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const opened=fstatSync(fd),current=lstatSync(path);if(!isPrivateFileSync(path,opened)||opened.size>256*1024)fail('unavailable','本机凭据存储状态不可用。');return readFileSync(fd,'utf8');}
  finally{closeSync(fd);}
}
/** Conservative local recovery: never displace a live/reused PID or an unidentifiable owner.
 * This follows the existing single-writer file protocol, not a distributed lease guarantee. */
export function acquireSetupLock(file:string,scope:string):()=>void {
  let fd:number;
  try{fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const before=lstatSync(file),raw=readOwned(file);let owner;
    try{owner=JSON.parse(raw);}catch{return fail('unavailable','设置锁缺少可核对的进程信息，请保留文件并检查；未自动删除。');}
    if(owner.host!==hostname()||owner.scope!==scope||!Number.isSafeInteger(owner.pid)||owner.pid<=1||typeof owner.instanceId!=='string')return fail('unavailable','设置锁身份不匹配，未自动删除。');
    try{process.kill(owner.pid,0);return fail('version_conflict','另一个设置进程仍存在，请使用原窗口。');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    const after=lstatSync(file);if(after.ino!==before.ino||after.dev!==before.dev||readOwned(file)!==raw)return fail('version_conflict','设置锁已变化，请刷新后重试。');
    unlinkSync(file);fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  }
  const identity={host:hostname(),scope,pid:process.pid,instanceId:randomUUID()};
  try{restrictPrivatePathSync(file);writeFileSync(fd,JSON.stringify(identity)+'\n');}catch(error){closeSync(fd);throw error;}
  const opened=fstatSync(fd);let released=false;
  return()=>{if(released)return;released=true;closeSync(fd);const current=lstatSync(file);if(!isPrivateFileSync(file,opened))throw Error('setup_lock_changed');unlinkSync(file);};
}
/** File policy remains the existing restricted-local-file policy, not an OS Keychain claim. */
export class ManagedCredentialStore {
  readonly directory:string;
  constructor(readonly projectRoot:string,directory=managedCredentialDirectory(projectRoot)) {
    this.directory=resolve(directory);
    if(!isAbsolute(projectRoot)||!isAbsolute(directory)||!outside(projectRoot,this.directory))throw new Error('Credential directory must be outside the project');
  }
  private state():State {
    try {
      assertOwned(this.directory,true);
      if(realpathSync(this.directory)!==this.directory)throw new Error();
      const value=JSON.parse(readOwned(join(this.directory,'registry.json'))) as State;
      if(value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<0||!Array.isArray(value.entries)||value.entries.length!==value.revision||value.entries.length>1000)throw new Error();
      const ids=new Set<string>(),operations=new Set<string>();
      for(const x of value.entries){
        if(!x||!['dashscope','deepseek'].includes(x.provider)||!/^credential-[a-f0-9-]{36}\.key$/.test(x.name)||x.id!==managedCredentialId(join(this.directory,x.name),x.provider)||ids.has(x.id)||operations.has(x.operationId)||!/^[a-zA-Z0-9_-]{8,100}$/.test(x.operationId)||!Number.isFinite(Date.parse(x.createdAt)))throw new Error();
        ids.add(x.id);operations.add(x.operationId);
      }
      return value;
    } catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,revision:0,entries:[]};return fail('unavailable','本机凭据目录不可用，请检查本地访问权限。');}
  }
  entries():readonly ManagedCredentialEntry[]{return this.state().entries.map(({name,...x})=>({...x,file:join(this.directory,name)}));}
  revision():number{return this.state().revision;}
  private ensureDirectory():void {
    const missing:string[]=[];let path=this.directory;
    for(;;){try{const s=lstatSync(path);if(s.isSymbolicLink()||!s.isDirectory())throw new Error();break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')fail('unavailable','本机凭据目录不可用。');missing.push(path);const parent=dirname(path);if(parent===path)throw new Error('Invalid credential parent');path=parent;}}
    if(realpathSync(path)!==path)fail('unavailable','本机凭据目录不能经过链接。');
    for(const next of missing.reverse()){mkdirSync(next,{mode:0o700});restrictPrivatePathSync(next);}
    assertOwned(this.directory,true);
  }
  save(input:{provider:ManagedCredentialProvider;key:string;expectedRevision:number;operationId:string}):{revision:number;credentialRef:string;provider:ManagedCredentialProvider} {
    const key = normalizeApiKey(input.key);
    if(!['dashscope','deepseek'].includes(input.provider)||key===undefined||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.operationId))fail('invalid_request','请选择对应服务商并填写完整 API Key。');
    this.ensureDirectory();const release=acquireSetupLock(join(this.directory,'write.lock'),'credentials:'+this.projectRoot);
    let created:string|undefined,temporary:string|undefined;
    try {
      const old=this.state(),prior=old.entries.find(x=>x.operationId===input.operationId);
      if(prior){if(prior.provider!==input.provider||readOwned(join(this.directory,prior.name))!==key)fail('version_conflict','这次保存编号已用于其他内容。');return {revision:old.revision,credentialRef:prior.id,provider:prior.provider};}
      if(old.revision!==input.expectedRevision)fail('version_conflict','凭据列表已变化，请刷新后再保存。');
      if(old.entries.length>=1000)fail('unavailable','本机凭据记录已达容量上限。');
      const name='credential-'+randomUUID()+'.key',file=join(this.directory,name),id=managedCredentialId(file,input.provider);
      const keyFd=openSync(file,'wx',0o600);created=file;try{restrictPrivatePathSync(file);writeFileSync(keyFd,key!);}finally{closeSync(keyFd);}assertOwned(file);
      const next:State={version:1,revision:old.revision+1,entries:[...old.entries,{id,provider:input.provider,name,createdAt:new Date().toISOString(),operationId:input.operationId}]};
      temporary=join(this.directory,'registry-'+randomUUID()+'.next');const registryFd=openSync(temporary,'wx',0o600);try{restrictPrivatePathSync(temporary);writeFileSync(registryFd,JSON.stringify(next)+'\n');}finally{closeSync(registryFd);}renameSync(temporary,join(this.directory,'registry.json'));temporary=undefined;created=undefined;
      return {revision:next.revision,credentialRef:id,provider:input.provider};
    } finally {
      if(temporary)try{unlinkSync(temporary);}catch{}
      if(created)try{unlinkSync(created);}catch{}
      release();
    }
  }
}
