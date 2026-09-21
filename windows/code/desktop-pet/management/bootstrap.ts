import type { EmotionManagement } from '../contracts/emotion-state.js';
import { createSelfSetup } from './self-setup.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MemoryImportManagement } from '../contracts/memory-import.js';
import {ProviderBalances,readBalanceKey} from './balances.js';
import {FinanceCredentials} from './balance-credentials.js';
import {effectiveTrialConfiguration} from './settings.js';
import type { WakeManagement } from '../contracts/wake.js';
import type { WeChatManagement } from '../contracts/wechat.js';
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PresentationControls } from '../contracts/presentation-presets.js';
import { presentationAssetRoutes } from './presentation-assets.js';
import type { ManagementMemoryPort } from '../contracts/management.js';
import type { TrialConfiguration } from '../app/trial-config.js';
import { ManagementSettingsStore } from './settings-store.js';
import { availableAdapters } from './settings.js';
import { credentialRegistry } from './credentials.js';
import { ManagementRuntime } from './runtime.js';
import { startManagementServer } from './server.js';
import type {PendingMemoryManagement} from './pending-memory.js';
import {accountingSnapshot} from './accounting.js';
import { SqliteProjectIndex } from '../projects/sqlite-project-index.js';
import { homedir } from 'node:os';
import { HarnessForwarding } from '../harness/forwarding.js';
import { ForwardReceipts } from '../harness/receipts.js';
import { HarnessConnection } from '../harness/connection.js';
import { CodexAppConnection, verifyCodexAppBuild } from '../harness/codex-app.js';
import { CodexWindowsConnection } from '../harness/codex-windows.js';
import { harnessLaunchUrl, relayPresetReady, workPresetReady, RELAY_PRESET_ID } from '../harness/preset.js';
import { harnessAccounting } from '../harness/accounting.js';
import { EvaluationBudget } from '../core/evaluation-budget.js';

export async function startRuntimeManagement(base: TrialConfiguration, configFile: string, settings: ManagementSettingsStore,
  runtime: ManagementRuntime, memory: ManagementMemoryPort, presentation?: PresentationControls, pendingMemory?:PendingMemoryManagement, wechat?:WeChatManagement, wake?:WakeManagement, memoryImport?:MemoryImportManagement, emotion?:EmotionManagement) {
  const effective=effectiveTrialConfiguration(base,settings.effective);
  const selfSetup=createSelfSetup({base,settings,instanceId:runtime.instanceId,mode:'runtime',runtimeReady:()=>{
    try{const raw=readFileSync(configFile,'utf8'),activation=JSON.parse(readFileSync(resolve(dirname(configFile),'activation.json'),'utf8'));
      return activation.status==='active'&&activation.phaseId===base.phaseId&&activation.configSha256===createHash('sha256').update(raw).digest('hex')&&JSON.stringify(JSON.parse(raw))===JSON.stringify(base);
    }catch{return false;}
  }});

  const deepseek=Object.values(effective.models).find(m=>m.provider==='deepseek'&&new URL(m.endpoint).hostname==='api.deepseek.com');
  const balances=new ProviderBalances({credentials:new FinanceCredentials(base.projectRoot),deepseekKey:()=>readBalanceKey(deepseek?.credentialFile)});
  let projects: SqliteProjectIndex | undefined;
  try { projects = new SqliteProjectIndex(resolve(base.projectRoot, '.local/data/project-index.sqlite')); }
  catch { process.stderr.write('Project index unavailable; companion data unchanged.\n'); }
  const descriptorFile = resolve(dirname(configFile), 'management-session.json');
  const location = { dshHome: resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh')), projectRoot: base.projectRoot, nodeExecutable: process.execPath, managementDescriptor: descriptorFile };
  let tasks: HarnessForwarding | undefined;
  let receipts: ForwardReceipts | undefined;
  const harnessDirectory = process.env.PET_HARNESS_HOME || (process.platform === 'win32' ? resolve(process.env.APPDATA || homedir(), 'DeepSeek Harness') : resolve(homedir(), 'Library/Application Support/DeepSeek Harness'));
  const windowsCodex = process.platform === 'win32' ? new CodexWindowsConnection(resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'))) : undefined;
  const makeForwarding = (receipts: ForwardReceipts) => {
    const harness = new HarnessConnection(() => harnessLaunchUrl(resolve(harnessDirectory, 'web.log')));
    return new HarnessForwarding({ receipts, projects:projects!,
      codex: windowsCodex ?? new CodexAppConnection(resolve(homedir(), '.codex')), compatible: windowsCodex ? () => windowsCodex.compatible() : verifyCodexAppBuild,
      harness, nativeWork: harness, workPresetReady: () => workPresetReady(location),
      presetReady: () => relayPresetReady(location), presetId: RELAY_PRESET_ID,
      workspace: resolve(harnessDirectory, 'workspace'),
      recordMetrics: harnessAccounting(new EvaluationBudget(base.budgetFile, base.budgetBatchId, base.limitMicros)),
    });
  };
  if (projects) try {
    receipts = new ForwardReceipts(resolve(base.projectRoot, '.local/data/harness-relay.sqlite'));
    tasks = makeForwarding(receipts);
  } catch { process.stderr.write('Task relay unavailable; companion data unchanged.\n'); }
  let server: Awaited<ReturnType<typeof startManagementServer>>;
  try { server = await startManagementServer({ ...(emotion?{emotion}:{}), selfSetup, ...(memoryImport?{memoryImport}:{}), balances, ...(wake?{wake}:{}), uiRoot: resolve(base.projectRoot, 'code/desktop-pet/management/ui'), settings, memory, ...(wechat?{wechat}:{}), ...(projects ? { projects } : {}), ...(tasks ? { tasks } : {}), ...(pendingMemory?{pendingMemory}:{}), ...(presentation ? { presentation, presentationAssets: await presentationAssetRoutes(base.projectRoot) } : {}),
    snapshot: async () => ({ apiVersion: 1, balances:balances.snapshot(), accounting:await accountingSnapshot(base), runtime: runtime.identity(), modules: runtime.modules(), events: runtime.recentEvents(),
      settings: settings.snapshot(), adapters: availableAdapters(base, settings.registeredVoices), credentials: credentialRegistry(base).list(), characters: memory.characters() }) });
  } catch (error) { await selfSetup.close(); await tasks?.close(); await projects?.close(); throw error; }
  const file = resolve(dirname(configFile), 'management-session.json');
  const descriptor = { version: 1, pid: process.pid, instanceId: runtime.instanceId, sourceRevision: base.sourceRevision, url: server.url };
  const temporary = file + '.' + runtime.instanceId + '.next';
  try {
    await writeFile(temporary, JSON.stringify(descriptor) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (error) { try { balances.close(); await selfSetup.close(); await server.close(); await memoryImport?.close(); } finally { await tasks?.close(); await projects?.close(); } throw error; }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  tasks?.startUsageObservation();
  return { ...server, tasks, projects, receipts, createWorkChannel(directory: string) {
    if(!projects)throw Error('Project index unavailable');
    const channelReceipts=new ForwardReceipts(resolve(directory,'harness-relay.sqlite'));
    const forwarding=makeForwarding(channelReceipts);forwarding.startUsageObservation();
    return {receipts:channelReceipts,forwarding,projects};
  }, async close() {
    try { balances.close(); await selfSetup.close(); await server.close(); await memoryImport?.close(); } finally { await tasks?.close(); await windowsCodex?.close(); await projects?.close(); }
    try { const current = JSON.parse(await readFile(file, 'utf8')); if (current.instanceId === runtime.instanceId) await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}
