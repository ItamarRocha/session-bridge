import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';

const run = promisify(execFile);
const sessionId = '11111111-2222-4333-8444-555555555555';
const entry = resolve('dist/cli.js');
const launch = [entry];
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

function fakeCodex(home: string, exit = 0) {
  const command = join(home, 'fake-codex');
  const capture = join(home, 'native-queue.jsonl');
  writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))+'\\n');process.exit(${exit});\n`, { mode: 0o700 });
  return { command, capture };
}

async function client(home: string, host: 'codex' | 'claude', command: string) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [...launch, 'mcp', '--legacy-tools', '--host', host, '--home', home, '--codex-command', command],
    env, stderr: 'pipe', cwd: process.cwd(),
  });
  const connection = new Client({ name: `test-${host}`, version: '1.0.0' });
  await connection.connect(transport);
  return connection;
}

async function tool<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(Array.isArray(result.content));
  const text = result.content.find((item: any) => item.type === 'text');
  assert.ok(text && typeof text.text === 'string');
  if (result.isError) throw new Error(text.text);
  return JSON.parse(text.text);
}

test('real MCP clients and monitor complete one request/reply in the original Codex UUID', { timeout: 20_000 }, async t => {
  const home = mkdtempSync("/tmp/sb-'$-");
  const cleanups: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });
  const fake = fakeCodex(home);
  const monitor = spawn(process.execPath, [...launch, 'monitor', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  const reader = createInterface({ input: monitor.stdout });
  reader.on('line', line => { lines.push(line); for (const wake of waiters) wake(); });
  cleanups.push(async () => {
    if (monitor.exitCode === null && monitor.signalCode === null) {
      const exited = new Promise<void>(resolve => monitor.once('exit', () => resolve()));
      monitor.kill('SIGTERM');
      await exited;
    }
    reader.close();
  });
  const notice = (predicate: (line: string) => boolean) => new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => { waiters.delete(check); reject(new Error('Monitor notice did not arrive')); }, 5_000);
    const check = () => {
      const found = lines.find(predicate);
      if (found) { clearTimeout(deadline); waiters.delete(check); resolve(found); }
    };
    waiters.add(check);
    check();
  });
  const bootstrap = await notice(line => line.includes('monitor ready'));
  const ticket = JSON.parse(bootstrap.match(/\{"ticket":"[^"]+"\}/)![0]).ticket;
  const codex = await client(home, 'codex', fake.command);
  const claude = await client(home, 'claude', fake.command);
  cleanups.push(async () => { await claude.close(); await codex.close(); });
  const tools = await claude.listTools();
  assert.ok(tools.tools.some(tool => tool.name === 'bridge_receive'));
  const a = await tool(codex, 'bridge_attach', { sessionId, label: 'Original Codex task' });
  const b = await tool(claude, 'bridge_attach', { ticket });
  assert.equal(b.host, 'claude');
  await tool(codex, 'bridge_pair', { peerId: b.id });
  const body = 'Review this code; selected context is $(touch SHOULD_NOT_EXIST). Return findings only.';
  const request = await tool(codex, 'bridge_send', { peerId: b.id, body, idempotencyKey: 'review-1' });
  assert.equal(request.delivery, 'submitted');
  assert.equal(request.acknowledgedAt, null);
  const incoming = await notice(line => line.includes(request.id));
  assert.ok(!incoming.includes(body));
  assert.ok(!incoming.includes(ticket));
  const received = await tool(claude, 'bridge_receive', { messageId: request.id });
  assert.equal(received.message.body, body);
  assert.equal(received.alreadyClaimed, false);
  const repeated = await tool(claude, 'bridge_receive', { messageId: request.id });
  assert.equal(repeated.claimId, received.claimId);
  assert.equal(repeated.alreadyClaimed, true);
  const reply = await tool(claude, 'bridge_reply', { messageId: request.id, claimId: received.claimId, body: 'One actionable finding.' });
  assert.equal(reply.delivery, 'submitted');
  assert.equal(reply.to, a.id);
  const sameReply = await tool(claude, 'bridge_reply', { messageId: request.id, claimId: received.claimId, body: 'One actionable finding.' });
  assert.equal(sameReply.id, reply.id);
  const nativeCalls = readFileSync(fake.capture, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(nativeCalls.length, 1, 'retry must not queue a duplicate native turn');
  assert.deepEqual(nativeCalls[0].slice(0, 4), ['queue', '--thread', sessionId, '--message']);
  assert.ok(nativeCalls[0][4].includes(reply.id));
  assert.ok(!nativeCalls[0][4].includes('One actionable finding.'));
  const fallback = nativeCalls[0][4].split('If that tool is unavailable, run: ')[1].split('. Use this session')[0];
  const fallbackReceipt = JSON.parse((await run('/bin/sh', ['-c', fallback], {env: {...env, CODEX_THREAD_ID: sessionId}})).stdout);
  assert.equal(fallbackReceipt.messages[0].messageId, reply.id, 'native notice must point at the sender-selected custom ledger');
  assert.equal(fallbackReceipt.messages[0].previouslyRead, false);
  assert.equal((await tool(codex, 'bridge_receive', { messageId: reply.id })).alreadyClaimed, true);
  await assert.rejects(tool(codex, 'bridge_reply', { messageId: reply.id, claimId: 'no-loop', body: 'Thanks!' }), /Only a request/);
  const status = await tool(codex, 'bridge_status', { messageId: request.id });
  assert.ok(status.message.acknowledgedAt);
  assert.equal(status.message.answeredBy, reply.id);
  const sameRequest = await tool(codex, 'bridge_send', { peerId: b.id, body, idempotencyKey: 'review-1' });
  assert.equal(sameRequest.id, request.id);
  assert.equal(lines.filter(line => line.includes(request.id)).length, 1);
  await tool(claude, 'bridge_detach');
  await assert.rejects(tool(codex, 'bridge_send', { peerId: b.id, body: 'new work', idempotencyKey: 'review-2' }), /closed/);
});

test('unknown and interrupted submissions survive reopen without automatically retrying', async t => {
  const home = mkdtempSync('/tmp/sb-ambiguous-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fake = fakeCodex(home, 9);
  let store = new Store(home);
  const a = store.createPeer({ host: 'claude', label: 'Caller' }).peer;
  const b = store.createPeer({ host: 'codex', label: 'Target', nativeSessionId: sessionId }).peer;
  store.pair(a.id, b.id);
  let bridge = new Bridge(store, 'claude', fake.command);
  bridge.bindLocalPeer(a.id);
  const input = { to: b.id, body: 'Review only', idempotencyKey: 'ambiguous' };
  const message = await bridge.send(input);
  assert.equal(message.delivery, 'unknown');
  const interrupted = store.send(a.id, { ...input, idempotencyKey: 'crashed' });
  assert.ok(store.beginDelivery(interrupted.id));
  store.close();
  store = new Store(home);
  t.after(() => store.close());
  bridge = new Bridge(store, 'claude', fake.command);
  bridge.bindLocalPeer(a.id);
  assert.equal((await bridge.send(input)).delivery, 'unknown');
  assert.equal((await bridge.send({ ...input, idempotencyKey: 'crashed' })).delivery, 'dispatching');
  assert.equal(readFileSync(fake.capture, 'utf8').trim().split('\n').length, 1);
});

test('existing-session CLI works without installing an MCP server', async t => {
  const home = mkdtempSync('/tmp/sb-cli-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = async (...args: string[]) => {
    const result = await run(process.execPath, [...launch, ...args, '--home', home]);
    return JSON.parse(result.stdout);
  };
  const a = await cli('attach', '--host', 'codex', '--session-id', sessionId);
  assert.equal(a.nativeSessionId, sessionId);
  const store = new Store(home);
  const b = store.createPeer({ host: 'claude', label: 'Offline monitor fixture' }).peer;
  store.close();
  await cli('pair', '--self', a.id, '--peer', b.id);
  const bodyFile = join(home, 'request.txt');
  writeFileSync(bodyFile, 'A multiline request\nwith quotes " and shell $() syntax.');
  const sent = await cli('send', '--self', a.id, '--peer', b.id, '--body-file', bodyFile, '--key', 'cli-1');
  assert.equal(sent.delivery, 'stored');
  const received = await cli('receive', '--self', b.id, '--message', sent.id);
  assert.equal(received.message.body, readFileSync(bodyFile, 'utf8'));
  await cli('cancel', '--self', a.id, '--message', sent.id);
  await cli('stop', '--self', a.id);
  const stopped = await cli('status', '--self', a.id, '--message', sent.id);
  assert.ok(stopped.message.cancelledAt);
});
