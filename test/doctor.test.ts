import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { doctor } from '../src/doctor.js';

async function fakeCommand(dir: string, name: string, allowed = [['--version']], exitCode = 0) {
  const script = `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (!${JSON.stringify(allowed)}.some(value => JSON.stringify(value) === JSON.stringify(args))) process.exit(64);
appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify({command: ${JSON.stringify(name)}, args}) + '\\n');
process.stdout.write(process.env.CODEX_HOME + ' --thread --message');
process.exitCode = ${exitCode};
`;
  await writeFile(join(dir, name), script, {mode: 0o700});
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp('/tmp/sb-doctor-');
  t.after(() => rm(dir, {recursive: true, force: true}));
  const command = join(dir, 'codex');
  await fakeCommand(dir, 'codex', [['--version'], ['queue', '--help']]);
  await fakeCommand(dir, 'claude');
  const env = {
    PATH: dir, CODEX_HOME: '/inherited/account', SESSION_BRIDGE_CODEX_HOME: '/destination/codex',
    CODEX_SQLITE_HOME: '/explicit/sqlite',
  };
  return { dir, command, env };
}

test('doctor uses only version and help probes with Codex routing and inherited Claude and Devin environments', async t => {
  const { dir, command, env } = await fixture(t);
  await fakeCommand(dir, 'devin');
  const result = await doctor(dir, command, env);
  assert.equal(result.codex.output, '/destination/codex --thread --message');
  assert.equal(result.codex.queueAvailable, true);
  assert.equal(result.claude.output, '/inherited/account --thread --message');
  assert.deepEqual(result.devin, {
    available: true, output: '/inherited/account --thread --message', transport: 'hooks', idleWakeAvailable: false,
  });
  assert.deepEqual(result.codex.routing, {
    home: '/destination/codex', homeSource: 'bridge_override', sqliteHomeOverride: '/explicit/sqlite',
  });
  assert.equal(env.CODEX_HOME, '/inherited/account');
  const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n').sort();
  assert.deepEqual(calls, [
    {command: 'codex', args: ['--version']},
    {command: 'codex', args: ['queue', '--help']},
    {command: 'claude', args: ['--version']},
    {command: 'devin', args: ['--version']},
  ].map(value => JSON.stringify(value)).sort());
  const limitation = result.limitations.find(value => value.startsWith('Devin '));
  assert.ok(limitation);
  assert.match(limitation, /host support is unverified/);
  assert.match(limitation, /hook loading or model reception/);
  assert.match(limitation, /cannot wake an already-idle session/);
});

test('doctor reports a missing Devin binary without implying hook support or an idle wake capability', async t => {
  const { dir, command, env } = await fixture(t);
  const result = await doctor(dir, command, env);
  assert.deepEqual(result.devin, { available: false, output: 'ENOENT', transport: 'hooks', idleWakeAvailable: false });
  assert.equal(result.codex.available, true);
  assert.equal(result.claude.available, true);
});

test('doctor reports an unsupported Devin version probe as unavailable while retaining honest transport capabilities', async t => {
  const { dir, command, env } = await fixture(t);
  await fakeCommand(dir, 'devin', [['--version']], 2);
  const result = await doctor(dir, command, env);
  assert.deepEqual(result.devin, { available: false, output: '2', transport: 'hooks', idleWakeAvailable: false });
  const calls = (await readFile(join(dir, 'calls.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(calls.filter(value => value === JSON.stringify({command: 'devin', args: ['--version']})).length, 1);
});
