import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { doctor } from '../src/doctor.js';

test('doctor runs Codex probes in the selected profile and keeps Claude in its inherited environment', async t => {
  const dir = await mkdtemp('/tmp/sb-doctor-');
  t.after(() => rm(dir, {recursive: true, force: true}));
  const command = join(dir, 'codex');
  const script = `#!${process.execPath}\nprocess.stdout.write(process.env.CODEX_HOME + ' --thread --message');\n`;
  await writeFile(command, script, {mode: 0o700});
  await writeFile(join(dir, 'claude'), script, {mode: 0o700});
  const env = {
    PATH: dir, CODEX_HOME: '/inherited/account', SESSION_BRIDGE_CODEX_HOME: '/destination/codex',
    CODEX_SQLITE_HOME: '/explicit/sqlite',
  };
  const result = await doctor(dir, command, env);
  assert.equal(result.codex.output, '/destination/codex --thread --message');
  assert.equal(result.codex.queueAvailable, true);
  assert.equal(result.claude.output, '/inherited/account --thread --message');
  assert.deepEqual(result.codex.routing, {
    home: '/destination/codex', homeSource: 'bridge_override', sqliteHomeOverride: '/explicit/sqlite',
  });
  assert.equal(env.CODEX_HOME, '/inherited/account');
});
