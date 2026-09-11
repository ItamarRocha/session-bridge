import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { claudeContextHook, devinContextHook } from '../src/context-hook.js';
import type { Sessions } from '../src/sessions.js';
import { Store } from '../src/store.js';
import type { Host } from '../src/types.js';

type Listed = ReturnType<Sessions['list']>;
type Received = ReturnType<Sessions['read']>;
type NotificationReceived = Awaited<ReturnType<Sessions['readNotification']>>;
type Sent = Awaited<ReturnType<Sessions['send']>>;
type Connected = Awaited<ReturnType<Sessions['connect']>>;

const CODEX_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_CODEX_ID = '77777777-7777-4777-8777-777777777777';
const CLAUDE_ID = '66666666-6666-4666-8666-666666666666';
const CLEARED_CLAUDE_ID = '88888888-8888-4888-8888-888888888888';
const STALE_ID = '99999999-9999-4999-8999-999999999999';
const NATIVE_QUEUE_ID = '12345678-1234-4234-8234-123456789012';
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

function notificationToken(line: string): string {
  const match = /\{"notificationToken":"([^"\n]+)"\}/.exec(line);
  assert.ok(match, 'The native notice must identify its inbox notification.');
  assert.ok(!line.includes('msg_'), 'A native inbox notice does not identify individual messages.');
  assert.ok(!line.includes('sb_'), 'A native notice does not expose internal peer identities.');
  return match[1]!;
}

function assertPublic(value: unknown, token?: string) {
  const serialized = JSON.stringify(value);
  for (const privateField of ['sb_', 'ownerToken', 'claimId', 'claimExpiresAt']) assert.ok(!serialized.includes(privateField));
  if (token) assert.ok(!serialized.includes(token), 'Proactive results do not disclose the outstanding notification token.');
}

function fixture(t: TestContext) {
  const home = mkdtempSync('/tmp/sb-mcp-native-');
  writeFileSync(join(home, 'ipc'), 'No socket directory is available to this sender or receiver.', { mode: 0o600 });
  const capture = join(home, 'native-queue.jsonl');
  const command = join(home, 'fake-codex');
  writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args)+'\\n');console.log('Queued message ${NATIVE_QUEUE_ID} for thread '+args[2]+'.');\n`, { mode: 0o700 });
  const cleanups: Array<() => void | Promise<void>> = [];
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.CODEX_THREAD_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.DEVIN_SESSION_ID;
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });
  const client = async (host: Host, staleStartup = false) => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry, 'mcp', '--host', host, '--home', home, '--codex-command', command],
      env: staleStartup ? { ...env, CODEX_THREAD_ID: STALE_ID, CLAUDE_SESSION_ID: STALE_ID, DEVIN_SESSION_ID: 'Old-Session' } : env,
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
    const catalog = (await client.listTools()).tools;
    assert.deepEqual(catalog.map(method => method.name).sort(), publicMethods);
    const readSchema = catalog.find(method => method.name === 'bridge_messages_read')!.inputSchema;
    assert.ok(readSchema.properties?.notificationToken);
    assert.ok(readSchema.properties?.unreadOnly);
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

test('Devin MCP startup and passive reads leave the shared ledger absent or unchanged until explicit connection', {timeout: 15000}, async t => {
  const absent = fixture(t);
  const cold = await absent.client('devin');
  assert.deepEqual((await cold.listTools()).tools.map(method => method.name).sort(), publicMethods);
  assert.equal(existsSync(join(absent.home, 'bridge.sqlite')), false);
  const inactive = await tool<Listed>(cold, 'bridge_sessions_list', {_sessionId: 'Quiet-Devin'});
  assert.equal(inactive.activationRequired, true);
  assert.equal(existsSync(join(absent.home, 'bridge.sqlite')), false);
  await assert.rejects(tool(cold, 'bridge_connect', {sessionId: `codex:${CODEX_ID}`}), /native session context/);
  assert.equal(existsSync(join(absent.home, 'bridge.sqlite')), false);

  for (const version of [4, 6]) {
    const f = fixture(t);
    const existing = new Store(f.home);
    existing.ensureCodexPeer({nativeSessionId: CODEX_ID});
    existing.close();
    const file = join(f.home, 'bridge.sqlite');
    const database = new DatabaseSync(file);
    database.exec(`PRAGMA journal_mode=DELETE; PRAGMA user_version=${version}`);
    database.close();
    const before = readFileSync(file);
    const devin = await f.client('devin');
    await devin.listTools();
    assert.deepEqual(readFileSync(file), before);
    assert.equal((await tool<Listed>(devin, 'bridge_sessions_list', {_sessionId: 'Quiet-Devin'})).activationRequired, true);
    await assert.rejects(tool(devin, 'bridge_messages_read', {_sessionId: 'Quiet-Devin'}), /Activation required/);
    await assert.rejects(tool(devin, 'bridge_connect', {_sessionId: 'invalid/id', sessionId: `codex:${CODEX_ID}`}), /native session ID/);
    assert.deepEqual(readFileSync(file), before);
    if (version === 4) {
      const connected = await tool<Connected>(devin, 'bridge_connect', {_sessionId: 'Quiet-Devin', sessionId: `codex:${CODEX_ID}`});
      assert.equal(connected.self!.sessionId, 'Quiet-Devin');
      const upgraded = new Store(f.home);
      try { assert.equal(upgraded.findNativePeer('Quiet-Devin', 'devin')!.attachedAt !== null, true); }
      finally { upgraded.close(); }
    } else {
      await assert.rejects(tool(devin, 'bridge_connect', {_sessionId: 'Quiet-Devin', sessionId: `codex:${CODEX_ID}`}), /Unsupported store schema version: 6/);
      assert.deepEqual(readFileSync(file), before);
    }
  }
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
  assert.equal(request.delivery, 'stored');
  assert.equal(request.deliveryStage, 'queued');
  assert.equal(request.recipientInbox.notification!.state, 'submitted');
  assert.equal(request.recipientInbox.notification!.nativeQueueId, NATIVE_QUEUE_ID);
  assert.equal(request.from.sessionId, CLAUDE_ID);
  assert.equal(request.to.sessionId, CODEX_ID);
  assert.equal(request.acknowledgedAt, null);
  assert.deepEqual(f.queued()[0]!.slice(0, 4), ['queue', '--thread', CODEX_ID, '--message']);
  const requestToken = notificationToken(f.queued()[0]![4]!);
  assertPublic(request, requestToken);
  await assert.rejects(tool(codex, 'bridge_messages_read', { notificationToken: requestToken }), /native session context is unavailable/);
  await assert.rejects(claudeTool('bridge_messages_read', { notificationToken: requestToken }), /recipient|notification|token/i);
  assert.ok(!f.queued()[0]![4]!.includes(input.text));
  const read = await tool<NotificationReceived>(codex, 'bridge_messages_read', { notificationToken: requestToken }, CODEX_ID);
  assert.deepEqual(read.notification, { consumed: true, replayed: false, remaining: false });
  assert.equal(read.messages[0]!.previouslyRead, false);
  assert.equal(read.messages[0]!.text, input.text);
  assert.equal((await tool<Listed>(codex, 'bridge_sessions_list', {}, CODEX_ID)).self!.sessionId, CODEX_ID);
  assert.equal((await claudeTool<Sent>('bridge_message_send', input)).messageId, request.messageId);
  assert.equal(f.queued().length, 1);
  const resultInput = { sessionId: CLAUDE_ID, replyTo: request.messageId, text: 'One finding at parser.ts:12.', idempotencyKey: 'native-result' };
  const result = await tool<Sent>(codex, 'bridge_message_send', resultInput, CODEX_ID);
  assert.equal(result.acknowledgedAt, null);
  const notice = await receiver.notice(line => line.includes('notificationToken'));
  const resultToken = notificationToken(notice);
  assert.ok(notice.includes('bridge_messages_read'));
  assert.ok(!notice.includes(result.text));
  const notified = await waitFor(
    () => claudeTool<Listed>('bridge_sessions_list'),
    value => value.self!.inbox.notification?.state === 'submitted', 'Claude notification evidence',
  );
  assertPublic(notified, resultToken);
  const inspected = await tool<Received>(codex, 'bridge_messages_read', { messageId: result.messageId }, CODEX_ID);
  assert.equal(inspected.messages[0]!.delivery, 'stored');
  assert.equal(inspected.messages[0]!.acknowledgedAt, null, 'Writing a native notice does not record model receipt.');
  assert.equal((await tool<Sent>(codex, 'bridge_message_send', resultInput, CODEX_ID)).messageId, result.messageId);
  await assert.rejects(claudeTool('bridge_messages_read', { notificationToken: resultToken }, CLEARED_CLAUDE_ID), /Activation required/);
  const answer = await claudeTool<NotificationReceived>('bridge_messages_read', { notificationToken: resultToken });
  assert.equal(answer.notification.consumed, true);
  const replay = await claudeTool<NotificationReceived>('bridge_messages_read', { notificationToken: resultToken });
  assert.equal(replay.notification.replayed, true);
  assert.ok(replay.messages.every(message => !message.actionable));
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
  assert.equal(receiver.lines.filter(line => line.includes(resultToken)).length, 1);

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

test('receiver restart retains one outstanding notification and durable unread recovery without replaying receipts', { timeout: 25_000 }, async t => {
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
  assert.equal(before.sessions[0]!.receiver.state, 'unknown');
  const registration = () => {
    const store = new Store(f.home);
    try {
      const peer = store.findNativePeer(CLAUDE_ID, 'claude');
      assert.ok(peer);
      return { id: peer.id, pairings: store.pairings(peer.id).map(pair => pair.id) };
    } finally { store.close(); }
  };
  const originalRegistration = registration();
  const completed = await tool<Sent>(codex, 'bridge_message_send', {
    sessionId: CLAUDE_ID, text: 'Review the first snapshot.', idempotencyKey: 'completed-request',
  }, CODEX_ID);
  const completedToken = notificationToken(await firstReceiver.notice(line => line.includes('notificationToken')));
  const firstRead = await claudeTool<NotificationReceived>('bridge_messages_read', { notificationToken: completedToken });
  assert.equal(firstRead.messages[0]!.messageId, completed.messageId);
  assert.equal(firstRead.messages[0]!.previouslyRead, false);
  const resultInput = {
    sessionId: CODEX_ID, text: 'The first snapshot has no findings.', replyTo: completed.messageId, idempotencyKey: 'completed-result',
  };
  const result = await claudeTool<Sent>('bridge_message_send', resultInput);
  assert.equal(result.delivery, 'stored');
  assert.equal(result.recipientInbox.notification!.state, 'submitted');
  await tool(codex, 'bridge_messages_read', { notificationToken: notificationToken(f.queued()[0]![4]!) }, CODEX_ID);
  const unread = await tool<Sent>(codex, 'bridge_message_send', {
    sessionId: CLAUDE_ID, text: 'Review the next snapshot.', idempotencyKey: 'unread-request',
  }, CODEX_ID);
  const unreadToken = notificationToken(await firstReceiver.notice(line => line.includes('notificationToken') && !line.includes(completedToken)));
  const firstNotice = await waitFor(
    () => claudeTool<Listed>('bridge_sessions_list'), value => value.self!.inbox.notification?.state === 'submitted', 'the outstanding inbox notice',
  );
  assert.equal(firstNotice.self!.inbox.unreadCount, 1);
  await firstReceiver.stop('SIGKILL');
  const offline = await waitFor(
    () => claudeTool<Listed>('bridge_sessions_list'), value => value.activationRequired, 'the killed receiver lease to expire', 7_000,
  );
  assert.equal(offline.self!.sessionId, CLAUDE_ID);
  assert.equal(offline.self!.receiver.state, 'unavailable');
  assert.deepEqual(offline.self!.status, before.self!.status);
  assert.deepEqual(registration(), originalRegistration);
  const queued = await tool<Sent>(codex, 'bridge_message_send', {
    sessionId: CLAUDE_ID, text: 'Keep this request until the receiver returns.', idempotencyKey: 'offline-request',
  }, CODEX_ID);
  assert.equal(queued.delivery, 'stored');
  assert.equal(queued.acknowledgedAt, null);
  assert.equal(queued.recipientInbox.unreadCount, 2);
  assert.deepEqual(queued.recipientInbox.notification, firstNotice.self!.inbox.notification);
  const restarted = await f.monitor();
  const resumed = await claudeTool<Listed>('bridge_sessions_list');
  assert.equal(resumed.activationRequired, false);
  assert.deepEqual(resumed.self!.inbox.notification, firstNotice.self!.inbox.notification);
  const after = await waitFor(
    () => claudeTool<Listed>('bridge_sessions_list'),
    value => value.self!.receiver.checkedAt! > resumed.self!.receiver.checkedAt!, 'the restarted receiver heartbeat',
  );
  assert.equal(after.self!.receiver.state, 'available');
  assert.deepEqual(registration(), originalRegistration);
  assert.equal(restarted.lines.filter(line => line.includes('notificationToken')).length, 0, 'Restart cannot append a duplicate wakeup that may still be queued natively.');
  const recovered = await claudeTool<Received>('bridge_messages_read', { unreadOnly: true });
  assert.deepEqual(new Set(recovered.messages.map(message => message.messageId)), new Set([unread.messageId, queued.messageId]));
  assert.ok(recovered.messages.every(message => !message.previouslyRead));
  const history = await claudeTool<Received>('bridge_messages_read', { messageId: completed.messageId });
  assert.equal(history.messages[0]!.previouslyRead, true);
  assert.equal(history.messages[0]!.acknowledgedAt, firstRead.messages[0]!.acknowledgedAt);
  assert.equal(history.messages[0]!.answeredBy, result.messageId);
  const delayed = await claudeTool<NotificationReceived>('bridge_messages_read', { notificationToken: unreadToken });
  assert.deepEqual(delayed.messages, []);
  assert.deepEqual(delayed.notification, { consumed: true, replayed: false, remaining: false });
  assert.equal((await claudeTool<Sent>('bridge_message_send', resultInput)).messageId, result.messageId);
  assert.equal(f.queued().length, 1);
  assert.equal(readFileSync(join(f.home, 'ipc'), 'utf8'), 'No socket directory is available to this sender or receiver.');
});

test('twenty distinct sends and proactive reads share one outstanding Codex notification until its delivered token is consumed', { timeout: 20_000 }, async t => {
  const f = fixture(t);
  await f.monitor();
  const codex = await f.client('codex', true);
  const claude = await f.client('claude', true);
  const claudeTool = <T>(name: string, args: Record<string, unknown> = {}) => tool<T>(claude, name, currentClaudeInput(name, args));
  await tool(codex, 'bridge_connect', { sessionId: CLAUDE_ID }, CODEX_ID);
  const sentIds = new Set<string>();
  const readIds = new Set<string>();
  for (let index = 0; index < 20; index++) {
    const message = await claudeTool<Sent>('bridge_message_send', {
      sessionId: CODEX_ID, text: `Review experiment checkpoint ${index}.`, idempotencyKey: `burst-${index}`,
    });
    sentIds.add(message.messageId);
    assert.equal(message.delivery, 'stored');
    assert.equal(message.deliveryStage, 'queued');
    assert.equal(message.acknowledgedAt, null);
    assert.equal(message.recipientInbox.unreadCount, index % 5 + 1);
    assert.equal(message.recipientInbox.pendingRequestCount, index + 1);
    assert.equal(message.recipientInbox.notification!.state, 'submitted');
    assert.equal(message.recipientInbox.notification!.nativeQueueId, NATIVE_QUEUE_ID);
    assert.equal(f.queued().length, 1, 'New messages cannot append native turns behind an outstanding wakeup.');
    assertPublic(message);
    if (index % 5 === 4) {
      const proactive = await tool<Received>(codex, 'bridge_messages_read', { unreadOnly: true }, CODEX_ID);
      assert.equal(proactive.messages.length, 5);
      for (const receipt of proactive.messages) {
        assert.equal(receipt.previouslyRead, false);
        readIds.add(receipt.messageId);
      }
      assert.ok(!('notification' in proactive), 'Ordinary polling cannot consume the queued wakeup.');
    }
  }
  assert.equal(sentIds.size, 20);
  assert.deepEqual(readIds, sentIds);
  const token = notificationToken(f.queued()[0]![4]!);
  const before = await tool<Listed>(codex, 'bridge_sessions_list', {}, CODEX_ID);
  assert.equal(before.self!.inbox.unreadCount, 0);
  assert.equal(before.self!.inbox.pendingRequestCount, 20);
  assert.equal(before.self!.inbox.notification!.state, 'submitted');
  assertPublic(before, token);
  await assert.rejects(tool(codex, 'bridge_messages_read', { notificationToken: 'missing-notification' }, CODEX_ID), /notification|token/i);
  const delivered = await tool<NotificationReceived>(codex, 'bridge_messages_read', { notificationToken: token, unreadOnly: true }, CODEX_ID);
  assert.deepEqual(delivered.messages, [], 'A late wakeup sees an empty inbox after proactive receipts.');
  assert.deepEqual(delivered.notification, { consumed: true, replayed: false, remaining: false });
  assert.equal(f.queued().length, 1);
  const replay = await tool<NotificationReceived>(codex, 'bridge_messages_read', { notificationToken: token }, CODEX_ID);
  assert.equal(replay.notification.replayed, true);
  assert.equal(replay.notification.consumed, false);
  assert.ok(replay.messages.every(message => !message.actionable));
  assert.equal(f.queued().length, 1);
  const newer = await claudeTool<Sent>('bridge_message_send', {
    sessionId: CODEX_ID, text: 'A meaningful new finding after the first wakeup was handled.', idempotencyKey: 'later-finding',
  });
  assert.equal(f.queued().length, 2);
  const newToken = notificationToken(f.queued()[1]![4]!);
  assert.notEqual(newToken, token);
  const oldReplay = await tool<NotificationReceived>(codex, 'bridge_messages_read', { notificationToken: token }, CODEX_ID);
  assert.ok(!oldReplay.messages.some(message => message.messageId === newer.messageId));
  assert.ok(oldReplay.messages.every(message => !message.actionable));
  const waiting = await tool<Listed>(codex, 'bridge_sessions_list', {}, CODEX_ID);
  assert.equal(waiting.self!.inbox.unreadCount, 1);
  assert.equal(waiting.self!.inbox.notification!.state, 'submitted');
  const newRead = await tool<NotificationReceived>(codex, 'bridge_messages_read', { notificationToken: newToken }, CODEX_ID);
  assert.deepEqual(newRead.messages.map(message => message.messageId), [newer.messageId]);
  assert.equal(newRead.messages[0]!.actionable, true);
  assert.equal(f.queued().length, 2);
  const bounded = [];
  for (let index = 0; index < 2; index++) bounded.push(await claudeTool<Sent>('bridge_message_send', {
    sessionId: CODEX_ID, text: `Separate bounded page item ${index}.`, idempotencyKey: `bounded-${index}`,
  }));
  assert.equal(f.queued().length, 3);
  const boundedToken = notificationToken(f.queued()[2]![4]!);
  await assert.rejects(tool(codex, 'bridge_messages_read', { notificationToken: boundedToken, cursor: '' }, CODEX_ID), /bounded batch/);
  await assert.rejects(tool(codex, 'bridge_messages_read', { notificationToken: boundedToken, messageId: bounded[0]!.messageId }, CODEX_ID), /bounded batch/);
  const page = await tool<NotificationReceived>(codex, 'bridge_messages_read', { notificationToken: boundedToken, limit: 1 }, CODEX_ID);
  assert.equal(page.messages.length, 1);
  assert.deepEqual(page.notification, { consumed: true, replayed: false, remaining: true });
  assert.equal(page.nextCursor, null, 'A delivered token consumes one bounded page, not an unbounded cursor loop.');
  assert.equal(f.queued().length, 4, 'The unread remainder gets one successor wakeup.');
  const boundedReplay = await tool<NotificationReceived>(codex, 'bridge_messages_read', { notificationToken: boundedToken, limit: 1 }, CODEX_ID);
  assert.deepEqual(boundedReplay.messages.map(message => message.messageId), page.messages.map(message => message.messageId));
  assert.ok(boundedReplay.messages.every(message => message.previouslyRead && !message.actionable));
  assert.equal(f.queued().length, 4);
  const lastPage = await tool<NotificationReceived>(codex, 'bridge_messages_read', { notificationToken: notificationToken(f.queued()[3]![4]!) }, CODEX_ID);
  assert.deepEqual(new Set([...page.messages, ...lastPage.messages].map(message => message.messageId)), new Set(bounded.map(message => message.messageId)));
  assert.deepEqual(lastPage.notification, { consumed: true, replayed: false, remaining: false });
  assert.equal(f.queued().length, 4);
});


test('Devin stdio MCP binds case-preserved word-pair identities only through explicit connect and fresh hook input', {timeout: 15_000}, async t => {
  const f = fixture(t);
  const devin = await f.client('devin', true);
  const codex = await f.client('codex', true);
  const ownId = 'Gentle-Falcon';
  const nextId = 'gentle-falcon';
  const devinInput = (name: string, args: Record<string, unknown> = {}, identity: unknown = ownId) => {
    const output = devinContextHook({hook_event_name: 'PreToolUse', session_id: identity,
      tool_name: `mcp__session-bridge__${name}`, tool_input: {...args, _sessionId: 'Old-Session'}});
    assert.ok(output);
    return output.hookSpecificOutput.updatedInput;
  };
  const devinTool = <T>(name: string, args: Record<string, unknown> = {}, identity: unknown = ownId) =>
    tool<T>(devin, name, devinInput(name, args, identity));
  assert.equal(devin.getServerVersion()!.version, '0.5.0');
  const catalog = (await devin.listTools()).tools;
  assert.deepEqual(catalog.map(method => method.name).sort(), publicMethods);
  assert.ok(catalog.every(method => method.inputSchema.properties?._sessionId));
  await assert.rejects(tool(devin, 'bridge_sessions_list'), /native session context is unavailable/);
  await assert.rejects(tool(devin, 'bridge_sessions_list', {}, CODEX_ID), /native session context is unavailable/);
  const dormant = await devinTool<Listed>('bridge_sessions_list');
  assert.equal(dormant.activationRequired, true);
  assert.equal(dormant.self, null);
  assert.deepEqual(dormant.sessions, []);
  let store = new Store(f.home);
  try { assert.deepEqual(store.peers(), []); } finally { store.close(); }
  const connected = await devinTool<Connected>('bridge_connect', {sessionId: `codex:${CODEX_ID}`});
  assert.equal(connected.state, 'pending');
  const own = await devinTool<Listed>('bridge_sessions_list');
  assert.equal(own.self!.sessionId, ownId);
  assert.equal(own.self!.address, `devin:${ownId}`);
  assert.equal(own.self!.provider, 'devin');
  assert.equal(own.self!.receiver.transport, 'hooks');
  assert.equal(own.self!.receiver.state, 'unknown');
  assert.equal(own.self!.receiver.idleWakeAvailable, false);
  const fullLengthTarget = await devinTool<Connected>('bridge_connect', {sessionId: `devin:${'x'.repeat(128)}`});
  assert.equal(fullLengthTarget.state, 'activation_required', 'A valid prefixed native address fits the tool schema without activating its target.');
  assert.deepEqual(f.queued(), []);
  const request = await devinTool<Sent>('bridge_message_send', {
    sessionId: CODEX_ID, text: 'Review this selected snapshot.', idempotencyKey: 'devin-review',
  });
  assert.equal(request.from.sessionId, ownId);
  const codexToken = notificationToken(f.queued()[0]![4]!);
  await tool(codex, 'bridge_messages_read', {notificationToken: codexToken}, CODEX_ID);
  const answer = await tool<Sent>(codex, 'bridge_message_send', {
    sessionId: `devin:${ownId}`, replyTo: request.messageId, text: 'Review complete: one finding.', idempotencyKey: 'codex-result',
  }, CODEX_ID);
  assert.equal(answer.delivery, 'stored');
  assert.equal(answer.to.sessionId, ownId);
  assert.equal(f.queued().length, 1, 'A Devin message is stored without a hidden model wakeup.');
  const changed = await devinTool<Listed>('bridge_sessions_list', {}, nextId);
  assert.equal(changed.activationRequired, true);
  assert.deepEqual(changed.sessions, []);
  await assert.rejects(devinTool('bridge_messages_read', {messageId: answer.messageId}, nextId), /Activation required/);
  await devinTool('bridge_connect', {sessionId: CODEX_ID}, nextId);
  const next = await devinTool<Listed>('bridge_sessions_list', {}, nextId);
  assert.equal(next.self!.sessionId, nextId);
  assert.notEqual(next.self!.sessionId, own.self!.sessionId);
  await assert.rejects(devinTool('bridge_messages_read', {messageId: answer.messageId}, nextId), /Not a participant/);
  for (const invalid of [null, '', 'bad\nidentity']) {
    const args = devinInput('bridge_messages_read', {messageId: answer.messageId}, invalid);
    assert.equal(args._sessionId, null);
    await assert.rejects(tool(devin, 'bridge_messages_read', args), /_sessionId|invalid|native session context/i);
  }
  const receipt = await devinTool<Received>('bridge_messages_read', {messageId: answer.messageId});
  assert.equal(receipt.messages[0]!.to.sessionId, ownId);
  assert.equal(receipt.messages[0]!.previouslyRead, false);
  const updated = await devinTool<ReturnType<Sessions['updateStatus']>>('bridge_status_update', {text: 'Inspecting the review finding.'});
  assert.equal(updated.sessionId, ownId);
  assert.equal((await devinTool<Listed>('bridge_sessions_list', {}, nextId)).self!.status, null);
  assert.equal(f.queued().length, 1);
  store = new Store(f.home);
  try {
    assert.equal(store.findNativePeer('Old-Session', 'devin'), null);
    assert.notEqual(store.findNativePeer(ownId, 'devin')!.id, store.findNativePeer(nextId, 'devin')!.id);
  } finally { store.close(); }
  assertPublic([request, answer, receipt, updated]);
});
