import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { claudeContextHook } from '../src/context-hook.js';
import type { Sessions } from '../src/sessions.js';
import { Store } from '../src/store.js';
import type { Host } from '../src/types.js';

type Listed = ReturnType<Sessions['list']>;
type Received = ReturnType<Sessions['read']>;
type Sent = Awaited<ReturnType<Sessions['send']>>;
type Connected = Awaited<ReturnType<Sessions['connect']>>;

const CODEX_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_CODEX_ID = '77777777-7777-4777-8777-777777777777';
const CLAUDE_ID = '66666666-6666-4666-8666-666666666666';
const CLEARED_CLAUDE_ID = '88888888-8888-4888-8888-888888888888';
const STALE_ID = '99999999-9999-4999-8999-999999999999';
const entry = resolve('dist/cli.js');
const publicMethods = [
  'bridge_connect', 'bridge_sessions_list', 'bridge_status_update',
  'bridge_message_send', 'bridge_messages_read', 'bridge_disconnect',
].sort();

async function tool<T>(client: Client, name: string, args: Record<string, unknown> = {}, threadId?: string): Promise<T> {
  const result = await client.callTool({ name, arguments: args, ...(threadId ? { _meta: { threadId } } : {}) });
  assert.ok(Array.isArray(result.content));
  const content = result.content.find(item => item.type === 'text');
  assert.ok(content && typeof content.text === 'string');
  if (result.isError) throw new Error(content.text);
  return JSON.parse(content.text);
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string, timeoutMs = 6_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (ready(value)) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}.`);
}

function currentClaudeInput(name: string, args: Record<string, unknown>, sessionId: string | undefined = CLAUDE_ID) {
  const result = claudeContextHook({
    hook_event_name: 'PreToolUse', tool_name: `mcp__plugin_session-bridge_session-bridge__${name}`,
    session_id: sessionId, tool_input: { ...args, _sessionId: STALE_ID },
  });
  assert.ok(result);
  assert.equal(result.hookSpecificOutput.updatedInput._sessionId, sessionId ?? null);
  return result.hookSpecificOutput.updatedInput;
}

function fixture(t: TestContext) {
  const home = mkdtempSync('/tmp/sb-mcp-native-');
  writeFileSync(join(home, 'ipc'), 'No socket directory is available to this sender or receiver.', { mode: 0o600 });
  const capture = join(home, 'native-queue.jsonl');
  const command = join(home, 'fake-codex');
  writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o700 });
  const cleanups: Array<() => void | Promise<void>> = [];
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDE_SESSION_ID;
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });
  const client = async (host: Host, staleStartup = false) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry, 'mcp', '--host', host, '--home', home, '--codex-command', command],
      env: staleStartup ? { ...env, CODEX_THREAD_ID: STALE_ID, CLAUDE_SESSION_ID: STALE_ID } : env,
      stderr: 'pipe', cwd: process.cwd(),
    });
    const connection = new Client({ name: `six-method-${host}`, version: '1.0.0' });
    cleanups.push(() => connection.close());
    await connection.connect(transport);
    return connection;
  };
  const monitor = async () => {
    const child = spawn(process.execPath, [entry, 'monitor', '--home', home, '--session-id', CLAUDE_ID], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const reader = createInterface({ input: child.stdout });
    const lines: string[] = [];
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const waiters = new Set<() => void>();
    reader.on('line', line => { lines.push(line); for (const wake of waiters) wake(); });
    const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Monitor did not stop.')); }, 3_000);
          child.once('close', () => { clearTimeout(deadline); resolve(); });
          child.kill(signal);
        });
      }
      reader.close();
    };
    cleanups.push(() => stop());
    const notice = (predicate: (line: string) => boolean) => new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => { waiters.delete(check); reject(new Error(`Native-session monitor notice did not arrive: ${stderr.trim()}`)); }, 5_000);
      const check = () => {
        const found = lines.find(predicate);
        if (found) { clearTimeout(deadline); waiters.delete(check); resolve(found); }
      };
      waiters.add(check);
      check();
    });
    const ready = await notice(line => line.includes('receiver ready'));
    assert.ok(ready.includes(CLAUDE_ID));
    assert.ok(!ready.includes('ticket'));
    assert.ok(!ready.includes('sb_'));
    return { lines, notice, stop };
  };
  return {
    home, client, monitor,
    queued: (): string[][] => existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}

test('default stdio MCP exposes six methods and refuses missing current-session context', { timeout: 15_000 }, async t => {
  const f = fixture(t);
  const codex = await f.client('codex');
  const claude = await f.client('claude', true);
  for (const client of [codex, claude]) {
    assert.deepEqual((await client.listTools()).tools.map(method => method.name).sort(), publicMethods);
    await assert.rejects(tool(client, 'bridge_sessions_list'), /native session context is unavailable/);
    await assert.rejects(tool(client, 'bridge_attach', { sessionId: CODEX_ID }), /not found/i);
  }
  const dormant = await tool<Listed>(codex, 'bridge_sessions_list', {}, CODEX_ID);
  assert.equal(dormant.activationRequired, true);
  assert.deepEqual(dormant.sessions, []);
  const store = new Store(f.home);
  try { assert.deepEqual(store.peers(), []); } finally { store.close(); }
  assert.deepEqual(f.queued(), []);
});

test('two real MCP clients and native-ID monitor exchange requests using fresh per-call identity and simulated Claude hooks', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const receiver = await f.monitor();
  const codex = await f.client('codex', true);
  await assert.rejects(tool(codex, 'bridge_sessions_list'), /native session context is unavailable/);
  const claude = await f.client('claude', true);
  const claudeTool = <T>(name: string, args: Record<string, unknown> = {}, id = CLAUDE_ID) =>
    tool<T>(claude, name, currentClaudeInput(name, args, id));
  const connected = await claudeTool<Connected>('bridge_connect', { sessionId: `codex:${CODEX_ID}` });
  assert.equal(connected.state, 'pending');
  assert.equal((await tool<Listed>(codex, 'bridge_sessions_list', {}, CODEX_ID)).activationRequired, true);
  assert.deepEqual(f.queued(), []);
  const input = { sessionId: CODEX_ID, text: 'Review selected commit abc123. Return findings only.', idempotencyKey: 'native-review' };
  const request = await claudeTool<Sent>('bridge_message_send', input);
  assert.equal(request.delivery, 'submitted');
  assert.equal(request.from.sessionId, CLAUDE_ID);
  assert.equal(request.to.sessionId, CODEX_ID);
  assert.equal(request.acknowledgedAt, null);
  assert.deepEqual(f.queued()[0]!.slice(0, 4), ['queue', '--thread', CODEX_ID, '--message']);
  assert.ok(f.queued()[0]![4]!.includes(request.messageId));
  assert.ok(!f.queued()[0]![4]!.includes(input.text));
  const read = await tool<Received>(codex, 'bridge_messages_read', { messageId: request.messageId }, CODEX_ID);
  assert.equal(read.messages[0]!.previouslyRead, false);
  assert.equal(read.messages[0]!.text, input.text);
  assert.equal((await tool<Listed>(codex, 'bridge_sessions_list', {}, CODEX_ID)).self!.sessionId, CODEX_ID);
  assert.equal((await claudeTool<Sent>('bridge_message_send', input)).messageId, request.messageId);
  assert.equal(f.queued().length, 1);
  const resultInput = { sessionId: CLAUDE_ID, replyTo: request.messageId, text: 'One finding at parser.ts:12.', idempotencyKey: 'native-result' };
  const result = await tool<Sent>(codex, 'bridge_message_send', resultInput, CODEX_ID);
  assert.equal(result.acknowledgedAt, null);
  const notice = await receiver.notice(line => line.includes(result.messageId));
  assert.ok(notice.includes('bridge_messages_read'));
  assert.ok(!notice.includes(result.text));
  const notified = await waitFor(
    () => tool<Received>(codex, 'bridge_messages_read', { messageId: result.messageId }, CODEX_ID),
    value => value.messages[0]!.delivery === 'submitted', 'Claude notification evidence',
  );
  assert.equal(typeof notified.messages[0]!.notifiedAt, 'number');
  assert.equal(notified.messages[0]!.acknowledgedAt, null, 'Writing a native notice does not record model receipt.');
  assert.equal((await tool<Sent>(codex, 'bridge_message_send', resultInput, CODEX_ID)).messageId, result.messageId);
  const answer = await claudeTool<Received>('bridge_messages_read', { messageId: result.messageId });
  assert.equal(answer.messages[0]!.from.sessionId, CODEX_ID);
  assert.equal(answer.messages[0]!.previouslyRead, false);
  assert.equal(answer.messages[0]!.actionable, false);
  await assert.rejects(claudeTool('bridge_message_send', {
    sessionId: CODEX_ID, text: 'Acknowledged.', idempotencyKey: 'reply-loop', replyTo: result.messageId,
  }), /Only a request accepts a reply/);
  assert.equal((await claudeTool<Received>('bridge_messages_read', { messageId: request.messageId })).messages[0]!.answeredBy, result.messageId);
  const status = await claudeTool<ReturnType<Sessions['updateStatus']>>('bridge_status_update', { text: 'Review complete; inspecting the next checkpoint.' });
  const listed = await tool<Listed>(codex, 'bridge_sessions_list', {}, CODEX_ID);
  assert.equal(listed.sessions[0]!.status!.text, status.status!.text);
  assert.equal(listed.sessions[0]!.status!.source, 'self_report');
  assert.equal(f.queued().length, 1, 'Status and listing do not notify models.');
  assert.equal(receiver.lines.filter(line => line.includes(result.messageId)).length, 1);

  const nextContext = await tool<Listed>(codex, 'bridge_sessions_list', {}, OTHER_CODEX_ID);
  assert.equal(nextContext.activationRequired, true, 'A shared MCP connection cannot leak the last caller identity into another task.');
  await tool(codex, 'bridge_connect', { sessionId: CLAUDE_ID }, OTHER_CODEX_ID);
  const nextSelf = await tool<Listed>(codex, 'bridge_sessions_list', {}, OTHER_CODEX_ID);
  assert.equal(nextSelf.self!.sessionId, OTHER_CODEX_ID);
  assert.equal((await tool<Listed>(codex, 'bridge_sessions_list', {}, CODEX_ID)).self!.sessionId, CODEX_ID);
  assert.equal((await claudeTool<Listed>('bridge_sessions_list')).sessions.length, 2);
  await assert.rejects(tool(codex, 'bridge_messages_read', { messageId: request.messageId }, OTHER_CODEX_ID), /Not a participant/);
  const cleared = await claudeTool<Listed>('bridge_sessions_list', {}, CLEARED_CLAUDE_ID);
  assert.equal(cleared.activationRequired, true, 'A fresh /clear identity does not inherit the previous Claude mailbox.');
  assert.deepEqual(cleared.sessions, []);
  await assert.rejects(claudeTool('bridge_messages_read', { messageId: result.messageId }, CLEARED_CLAUDE_ID), /Activation required/);
  await assert.rejects(tool(claude, 'bridge_sessions_list'), /native session context is unavailable/);
  await assert.rejects(tool(codex, 'bridge_sessions_list'), /native session context is unavailable/);
  const store = new Store(f.home);
  try {
    assert.equal(store.findNativePeer(STALE_ID), null, 'Stale startup identity was never bound by any call.');
    assert.equal(store.findNativePeer(CLEARED_CLAUDE_ID), null);
  } finally { store.close(); }
  assert.equal(readFileSync(join(f.home, 'ipc'), 'utf8'), 'No socket directory is available to this sender or receiver.');
});

test('a killed receiver expires and explicit restart delivers durable unread messages without replaying receipts', { timeout: 25_000 }, async t => {
  const f = fixture(t);
  const firstReceiver = await f.monitor();
  const codex = await f.client('codex', true);
  const claude = await f.client('claude', true);
  const claudeTool = <T>(name: string, args: Record<string, unknown> = {}) => tool<T>(claude, name, currentClaudeInput(name, args));
  await tool(codex, 'bridge_connect', { sessionId: CLAUDE_ID }, CODEX_ID);
  await claudeTool('bridge_status_update', { text: 'Reviewing the selected snapshot.' });
  const before = await claudeTool<Listed>('bridge_sessions_list');
  assert.equal(before.activationRequired, false);
  assert.equal(before.self!.receiver.state, 'available');
  assert.equal(before.self!.receiver.transport, 'inbox');
  assert.equal(before.sessions[0]!.receiver.state, 'unknown', 'A Codex registration does not prove that its native client is loaded.');
  assert.equal(before.self!.sessionId, CLAUDE_ID);
  assert.equal(before.sessions.length, 1);
  const registration = () => {
    const store = new Store(f.home);
    try {
      const peer = store.findNativePeer(CLAUDE_ID, 'claude');
      assert.ok(peer);
      return { id: peer.id, pairings: store.pairings(peer.id).map(pair => pair.id) };
    } finally { store.close(); }
  };
  const originalRegistration = registration();
  const inspect = (messageId: string) => tool<Received>(codex, 'bridge_messages_read', { messageId }, CODEX_ID);
  const completed = await tool<Sent>(codex, 'bridge_message_send', {
    sessionId: CLAUDE_ID, text: 'Review the first snapshot.', idempotencyKey: 'completed-request',
  }, CODEX_ID);
  await firstReceiver.notice(line => line.includes(completed.messageId));
  const firstRead = await claudeTool<Received>('bridge_messages_read', { messageId: completed.messageId });
  assert.equal(firstRead.messages[0]!.previouslyRead, false);
  const resultInput = {
    sessionId: CODEX_ID, text: 'The first snapshot has no findings.', replyTo: completed.messageId, idempotencyKey: 'completed-result',
  };
  const result = await claudeTool<Sent>('bridge_message_send', resultInput);
  assert.equal(result.delivery, 'submitted');
  await tool(codex, 'bridge_messages_read', { messageId: result.messageId }, CODEX_ID);

  const unread = await tool<Sent>(codex, 'bridge_message_send', {
    sessionId: CLAUDE_ID, text: 'Review the next snapshot.', idempotencyKey: 'unread-request',
  }, CODEX_ID);
  await firstReceiver.notice(line => line.includes(unread.messageId));
  const firstNotice = await waitFor(
    () => inspect(unread.messageId), value => typeof value.messages[0]!.notifiedAt === 'number', 'the first durable notice',
  );
  assert.equal(firstNotice.messages[0]!.delivery, 'submitted');
  assert.equal(firstNotice.messages[0]!.acknowledgedAt, null);
  await firstReceiver.stop('SIGKILL');

  const offline = await waitFor(
    () => claudeTool<Listed>('bridge_sessions_list'), value => value.activationRequired, 'the killed receiver lease to expire', 7_000,
  );
  assert.equal(offline.self!.sessionId, CLAUDE_ID, 'Losing the receiver does not delete the logical session.');
  assert.equal(offline.self!.receiver.state, 'unavailable');
  assert.deepEqual(offline.self!.status, before.self!.status);
  assert.equal(offline.sessions[0]!.sessionId, CODEX_ID);
  assert.deepEqual(registration(), originalRegistration);
  const queued = await tool<Sent>(codex, 'bridge_message_send', {
    sessionId: CLAUDE_ID, text: 'Keep this request until the receiver returns.', idempotencyKey: 'offline-request',
  }, CODEX_ID);
  assert.equal(queued.delivery, 'stored');
  assert.equal(queued.notifiedAt, null);
  assert.equal(queued.acknowledgedAt, null);
  await assert.rejects(tool(claude, 'bridge_messages_read', { messageId: queued.messageId }), /native session context is unavailable/);

  const restarted = await f.monitor();
  await restarted.notice(line => line.includes(unread.messageId));
  await restarted.notice(line => line.includes(queued.messageId));
  const secondNotice = await waitFor(
    () => inspect(unread.messageId), value => value.messages[0]!.notifiedAt !== firstNotice.messages[0]!.notifiedAt,
    'the unread notification to be recorded by the replacement receiver',
  );
  assert.equal(secondNotice.messages[0]!.acknowledgedAt, null);
  const queuedNotice = await waitFor(
    () => inspect(queued.messageId), value => value.messages[0]!.delivery === 'submitted', 'the offline request notification',
  );
  assert.equal(queuedNotice.messages[0]!.acknowledgedAt, null);
  const after = await claudeTool<Listed>('bridge_sessions_list');
  assert.equal(after.activationRequired, false);
  assert.equal(after.self!.receiver.state, 'available');
  assert.equal(after.self!.sessionId, CLAUDE_ID);
  assert.deepEqual(registration(), originalRegistration, 'Explicit restart retains the original peer and connection.');
  assert.equal(restarted.lines.filter(line => line.includes(completed.messageId)).length, 0, 'An acknowledged request does not generate a restart notification.');
  assert.equal(restarted.lines.filter(line => line.includes(unread.messageId)).length, 1);
  assert.equal(restarted.lines.filter(line => line.includes(queued.messageId)).length, 1);

  const recovered = await claudeTool<Received>('bridge_messages_read', { messageId: unread.messageId });
  assert.equal(recovered.messages[0]!.messageId, unread.messageId);
  assert.equal(recovered.messages[0]!.previouslyRead, false, 'A prior native notification was not a receipt.');
  await claudeTool('bridge_messages_read', { messageId: queued.messageId });
  const history = await claudeTool<Received>('bridge_messages_read', { messageId: completed.messageId });
  assert.equal(history.messages[0]!.previouslyRead, true);
  assert.equal(history.messages[0]!.acknowledgedAt, firstRead.messages[0]!.acknowledgedAt);
  assert.equal(history.messages[0]!.answeredBy, result.messageId);
  assert.equal((await claudeTool<Sent>('bridge_message_send', resultInput)).messageId, result.messageId);
  assert.equal(f.queued().length, 1, 'Inspecting history or retrying a recorded result never sends a second terminal reply.');
  assert.equal(readFileSync(join(f.home, 'ipc'), 'utf8'), 'No socket directory is available to this sender or receiver.');
});
