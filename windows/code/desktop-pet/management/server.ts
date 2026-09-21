import { emotionRoute } from './emotion-routes.js';
import type { EmotionManagement } from '../contracts/emotion-state.js';
import type { SelfSetupManagement } from '../contracts/self-setup.js';
import { selfSetupRoute } from './self-setup-routes.js';
import type { MemoryImportManagement } from '../contracts/memory-import.js';
import { memoryImportRoute } from './memory-import-routes.js';
import type {BalanceManagement} from '../contracts/balances.js';
import {balanceRoute} from './balance-routes.js';
import type { WakeManagement } from '../contracts/wake.js';
import { wakeRoute } from './wake-routes.js';
import type { WeChatManagement } from '../contracts/wechat.js';
import { wechatRoute } from './wechat-routes.js';
import { isProductCharacter } from '../contracts/character.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CharacterId } from '../contracts/index.js';
import { ManagementError, type ManagementMemoryPort, type ManagementSnapshot, type RecordQuery, type RecordEdit } from '../contracts/management.js';
import type { PresentationControls } from '../contracts/presentation-presets.js';
import type { ManagementSettingsStore } from './settings-store.js';
import { memoryDynamicsRoute } from './memory-dynamics-routes.js';
import type {PendingMemoryManagement} from './pending-memory.js';
import type { ProjectIndexPort } from '../contracts/projects.js';
import { projectRoute } from './project-routes.js';
import { taskRoute, type TaskManagement } from './task-routes.js';

interface RuntimeServerOptions { emotion?: EmotionManagement; mode?: 'runtime'; selfSetup?:SelfSetupManagement; memoryImport?: MemoryImportManagement; balances?: BalanceManagement; wake?: WakeManagement; wechat?: WeChatManagement; uiRoot: string; memory: ManagementMemoryPort; settings: ManagementSettingsStore; snapshot(): ManagementSnapshot | Promise<ManagementSnapshot>; token?: string; presentation?: PresentationControls; presentationAssets?: ReadonlyMap<string, string>; pendingMemory?:PendingMemoryManagement; projects?: ProjectIndexPort; tasks?: TaskManagement }
type ServerOptions = RuntimeServerOptions | { mode:'setup'; selfSetup:SelfSetupManagement; uiRoot:string; token?:string; presentationAssets?:undefined };
const character = (value: unknown): CharacterId => { if (!isProductCharacter(value)) throw new ManagementError('invalid_request', '仅可访问当前陪伴角色。'); return value; };
const integer = (value: unknown, fallback: number, min: number, max: number) => { const n = value === null || value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw new ManagementError('invalid_request', '数值范围无效。'); return n; };
const str = (value: unknown, max = 20000): string => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new ManagementError('invalid_request', '文本字段无效。'); return value; };
async function body(req: IncomingMessage, limit=256*1024): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new ManagementError('invalid_request', '请求需要JSON格式。');
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const part of req) { const buffer = Buffer.from(part); bytes += buffer.length; if (bytes > limit) throw new ManagementError('invalid_request', '请求内容过大。'); chunks.push(buffer); }
  try { const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new ManagementError('invalid_request', '请求格式无效。'); }
}
/** Actual backend-owned loopback server. No CORS, proxy, arbitrary files or raw SQL. */
export async function startManagementServer(options: ServerOptions) {
  const token = options.token ?? randomBytes(32).toString('hex'); if (token.length < 32) throw new Error('Management token too short');
  let origin = '';
  const json = (res: ServerResponse, status: number, value: unknown) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value)); };
  const server = createServer({ requestTimeout: 10000, headersTimeout: 10000, keepAliveTimeout: 1000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; media-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    void (async () => {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin)) throw new ManagementError('forbidden', '仅接受本机管理页面的同源请求。');
      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin) throw new ManagementError('forbidden', '无效来源。');
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new ManagementError('not_found', '没有这个页面。');
        const asset = options.presentationAssets?.get(decodeURIComponent(url.pathname));
        if (asset) {
          const data = await readFile(asset);
          const type = asset.endsWith('.png') ? 'image/png' : asset.endsWith('.json') ? 'application/json' : asset.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
          res.setHeader('Content-Type', type); res.end(req.method === 'HEAD' ? undefined : data); return;
        }
        const names = new Map([['/emotion-view.mjs','emotion-view.mjs'],['/self-setup-view.mjs','self-setup-view.mjs'],['/memory-import-view.mjs','memory-import-view.mjs'],['/balances-view.mjs','balances-view.mjs'],['/wake-view.mjs','wake-view.mjs'],['/wechat-view.mjs','wechat-view.mjs'],['/', 'index.html'], ['/index.html', 'index.html'], ['/app.mjs', 'app.mjs'], ['/pending-memory-view.mjs','pending-memory-view.mjs'], ['/api.mjs', 'api.mjs'], ['/projects-view.mjs', 'projects-view.mjs'], ['/tasks-view.mjs', 'tasks-view.mjs'], ['/dom.mjs', 'dom.mjs'], ['/views.mjs', 'views.mjs'], ['/style.css', 'style.css'], ['/presentation-view.mjs', 'presentation-view.mjs'], ['/memory-dynamics-view.mjs','memory-dynamics-view.mjs'], ['/presentation-preview.js', 'presentation-preview.js']]);
        const name = names.get(url.pathname); if (!name) throw new ManagementError('not_found', '没有这个页面。');
        let data: Buffer; try { data = await readFile(resolve(options.uiRoot, name)); } catch { throw new ManagementError('unavailable', '管理页面文件尚未就绪。'); }
        res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'); res.end(req.method === 'HEAD' ? undefined : data); return;
      }
      const expected = Buffer.from('Bearer ' + token), provided = Buffer.from(req.headers.authorization ?? '');
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) throw new ManagementError('unauthorized', '请从本机管理入口重新打开此页面。');
      if (req.method !== 'GET' && req.headers.origin !== origin) throw new ManagementError('forbidden', '写入必须来自当前管理页面。');
      if(await selfSetupRoute(req,url,options.selfSetup,limit=>body(req,limit),value=>json(res,200,value),(bytes,mime)=>{res.setHeader('Content-Type',mime);res.end(bytes);}))return;
      if(options.mode==='setup')throw new ManagementError('unavailable','当前为首次设置，桌宠尚未运行。');
      const q = url.searchParams;
      if(url.pathname==='/api/emotion' && await emotionRoute(req,url,options.emotion,(await options.snapshot()).runtime.instanceId,value=>json(res,200,value)))return;
      if (await memoryImportRoute(req,url,options.memoryImport,()=>body(req),value=>json(res,200,value))) return;
      if(await balanceRoute(req,url,options.balances,()=>body(req),value=>json(res,200,value)))return;
      if (await taskRoute(req, url, options.tasks, () => body(req), value => json(res, 200, value))) return;
      if (await projectRoute(req, url, options.projects, () => body(req), value => json(res, 200, value))) return;
      if(url.pathname==='/api/memory-pending'&&req.method==='GET'){json(res,200,options.pendingMemory?.list()??{instanceId:(await options.snapshot()).runtime.instanceId,requests:[],busy:false});return;}
      if(['/api/memory-pending/retry','/api/memory-pending/cancel'].includes(url.pathname)&&req.method==='POST'){
        if(!options.pendingMemory)throw new ManagementError('unavailable','当前版本尚未接入未完成请求管理。');
        const b=await body(req),instanceId=str(b.instanceId,100),id=str(b.id,200);
        json(res,200,url.pathname.endsWith('/retry')?options.pendingMemory.retry(instanceId,id):await options.pendingMemory.cancel(instanceId,id));return;
      }
      if (await memoryDynamicsRoute(req, url, options.memory.dynamics, () => body(req), value => json(res, 200, value))) return;
      if (url.pathname === '/api/presentation' && options.presentation) {
        if (req.method === 'GET') { json(res, 200, { catalog: options.presentation.catalog, policy: options.presentation.snapshot() }); return; }
        if (req.method === 'PUT') { const b = await body(req); json(res, 200, { catalog: options.presentation.catalog, policy: await options.presentation.save(str(b.modelId, 100), integer(b.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER), b.enabledIds) }); return; }
      }
      if (url.pathname === '/api/wake' && options.wake) { json(res, 200, await wakeRoute(req.method, options.wake, () => body(req))); return; }
      if (url.pathname === '/api/wechat' && options.wechat) { json(res, 200, await wechatRoute(req.method, options.wechat, () => body(req))); return; }
      if (req.method === 'GET' && url.pathname === '/api/snapshot') { json(res, 200, await options.snapshot()); return; }
      if (req.method === 'GET' && url.pathname === '/api/records') {
        const kind = q.get('kind'); if (!['memory', 'transcript', 'summary', 'keyword_index', 'vector_index', 'context_cache'].includes(kind ?? '')) throw new ManagementError('invalid_request', '记录类型无效。');
        const state = q.get('state') ?? 'active'; if (state !== 'all' && state !== 'active') throw new ManagementError('invalid_request', '记录状态无效。');
        const query: RecordQuery = { characterId: character(q.get('characterId')), kind: kind as RecordQuery['kind'], state, query: str(q.get('query') ?? '', 1000), offset: integer(q.get('offset'), 0, 0, 1000000), limit: integer(q.get('limit'), 30, 1, 100) };
        json(res, 200, await options.memory.list(query)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/context') { json(res, 200, await options.memory.context(character(q.get('characterId')), str(q.get('query') ?? '', 1000))); return; }
      if (req.method === 'GET' && url.pathname === '/api/prompt') { json(res, 200, await options.memory.prompt(character(q.get('characterId')))); return; }
      if (req.method === 'POST' && url.pathname === '/api/records/edit') {
        const b = await body(req); const input: RecordEdit = { characterId: character(b.characterId), id: str(b.id, 200), expectedVersion: integer(b.expectedVersion, -1, 1, Number.MAX_SAFE_INTEGER), operationId: str(b.operationId, 200), text: str(b.text), reason: str(b.reason, 1000) };
        if (!input.text.trim() || !input.operationId.trim() || !input.reason.trim()) throw new ManagementError('invalid_request', '请填写修改内容与原因。');
        json(res, 200, await options.memory.edit(input)); return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/prompt') {
        const b = await body(req); const text = str(b.text), operationId = str(b.operationId, 200);
        if (!text.trim() || !operationId.trim()) throw new ManagementError('invalid_request', '角色设定和操作编号不能为空。');
        json(res, 200, await options.memory.savePrompt({ characterId: character(b.characterId), expectedRevision: integer(b.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER), text, operationId })); return;
      }
      if (req.method === 'PUT' && url.pathname === '/api/settings') { const b = await body(req); json(res, 200, await options.settings.save(integer(b.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER), b.settings)); return; }
      if (req.method === 'POST' && url.pathname === '/api/settings/rollback') { const b = await body(req); json(res, 200, await options.settings.rollback(integer(b.expectedRevision, -1, 0, Number.MAX_SAFE_INTEGER), integer(b.targetRevision, -1, 0, Number.MAX_SAFE_INTEGER))); return; }
      throw new ManagementError('not_found', '没有这个管理操作。');
    })().catch(error => {
      if (res.headersSent || res.destroyed) return;
      const safe = error instanceof ManagementError ? error : new ManagementError('internal_error', '这次管理操作未完成，原始内容和内部错误未对外输出。');
      const status = { unauthorized: 401, forbidden: 403, invalid_request: 400, not_found: 404, version_conflict: 409, unavailable: 503, internal_error: 500 }[safe.code];
      json(res, status, { error: { code: safe.code, message: safe.message } });
    });
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { reject(new Error('No local address')); return; } origin = 'http://127.0.0.1:' + address.port; done(); }); });
  return { origin, token, url: origin + '/#token=' + token,
    async close() { server.closeIdleConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); if(options.mode!=='setup')await options.settings.drain(); } };
}
