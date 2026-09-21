import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startEmotionUiFixture } from './emotion-ui-fixture.mjs';

test('Windows Chromium: state, history, stale responses, escaping, pagination and GET-only refresh', { timeout: 30_000 }, async t => {
  const fixture = await startEmotionUiFixture();
  t.after(() => fixture.close());
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(createRequire(import.meta.url)('electron'), [
    fileURLToPath(new URL('./emotion-ui-electron.mjs', import.meta.url)), fixture.url,
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => t.diagnostic(bytes.toString()));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Electron exited ' + code)));
  });
  const prefix = 'EMOTION_UI_RESULT=';
  const line = output.split(/\r?\n/).find(value => value.startsWith(prefix));
  assert.ok(line, 'Electron must return its UI scenario results');
  const result = JSON.parse(line.slice(prefix.length));
  assert.equal(result.error, undefined);
  assert.equal(result.passed, 6);
  assert.deepEqual(result.errors, []);
});
