import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { runDevinInboxHook } from '../src/inbox-hook.js';
import { Store } from '../src/store.js';

const DEVIN_ID = 'Gentle-Falcon';
const CODEX_ID = 'abcdef01-2222-4333-8444-555555555555';
const entry = resolve('dist/cli.js');
const postTool = {hook_event_name: 'PostToolUse', session_id: DEVIN_ID};

type Output = Parameters<Parameters<typeof runDevinInboxHook>[2]>[0];

function fixture(t: TestContext, attach = true) {
  const home = mkdtempSync('/tmp/sb-devin-hook-');
  const store = new Store(home);
  const sender = store.ensureCodexPeer({nativeSessionId: CODEX_ID});
  const recipient = attach
    ? store.ensureNativePeer({host: 'devin', nativeSessionId: DEVIN_ID})
    : store.createPeer({host: 'devin', nativeSessionId: DEVIN_ID, label: 'Unattached registration'}).peer;
  store.pair(sender.id, recipient.id);
  t.after(() => { store.close(); rmSync(home, {recursive: true, force: true}); });
  const send = (key: string) => store.send(sender.id, {to: recipient.id,
    body: `Review the private selected snapshot for ${key}.`, idempotencyKey: key});
  return {home, store, sender, recipient, send};
}

function token(output: Output) {
  const context = output.hookSpecificOutput.additionalContext;
  const match = /\{"notificationToken":"([^"\n]+)"\}/.exec(context);
  assert.ok(match, 'The lifecycle hint supplies the token required to consume its notification.');
  assert.ok(!context.includes('private selected snapshot'));
  for (const privateField of ['msg_', 'sb_', 'ownerToken', 'claimId']) assert.ok(!context.includes(privateField));
  return match[1]!;
}

test('Devin lifecycle hooks remain silent for inactive sessions and unsupported events', async t => {
  const f = fixture(t, false);
  const request = f.send('inactive');
  const outputs: Output[] = [];
  const write = async (output: Output) => { outputs.push(output); };
  assert.equal(await runDevinInboxHook(postTool, f.store, write), false);
  assert.equal(f.store.peer(f.recipient.id).attachedAt, null);
  f.store.ensureNativePeer({host: 'devin', nativeSessionId: DEVIN_ID});
  for (const event of ['SessionStart', 'PreToolUse', 'Stop', 'SessionEnd']) {
    assert.equal(await runDevinInboxHook({...postTool, hook_event_name: event}, f.store, write), false);
  }
  for (const identity of [undefined, null, 'not/a/session', 'Other-Session']) {
    assert.equal(await runDevinInboxHook({...postTool, session_id: identity}, f.store, write), false);
  }
  assert.deepEqual(outputs, []);
  assert.equal(f.store.notificationStatus(f.recipient.id).notification, null);
  assert.equal(f.store.message(f.sender.id, request.id).acknowledgedAt, null);
  assert.equal(f.store.peers().length, 2);
});

test('Devin lifecycle boundaries coalesce arrivals and preserve a queued token through proactive reads', async t => {
  const f = fixture(t);
  const outputs: Output[] = [];
  const write = async (output: Output) => { outputs.push(output); };
  for (let index = 0; index < 20; index++) f.send(`burst-${index}`);
  assert.equal(await runDevinInboxHook(postTool, f.store, write), true);
  assert.equal(outputs[0]!.hookSpecificOutput.hookEventName, 'PostToolUse');
  const first = token(outputs[0]!);
  assert.equal(f.store.notificationStatus(f.recipient.id).notification!.state, 'submitted');
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 20);
  f.send('late-arrival');
  assert.equal(await runDevinInboxHook({hook_event_name: 'UserPromptSubmit', session_id: DEVIN_ID}, f.store, write), false);
  for (const message of f.store.inbox(f.recipient.id)) f.store.claim(f.recipient.id, message.id);
  assert.equal(await runDevinInboxHook(postTool, f.store, write), false);
  assert.equal(outputs.length, 1);
  const delayed = f.store.consumeNotification(f.recipient.id, first);
  assert.equal(delayed.consumed, true);
  assert.deepEqual(delayed.claims, []);
  f.send('fresh-finding');
  assert.equal(await runDevinInboxHook({hook_event_name: 'UserPromptSubmit', session_id: DEVIN_ID}, f.store, write), true);
  assert.equal(outputs[1]!.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const second = token(outputs[1]!);
  assert.notEqual(second, first);
  const replay = f.store.consumeNotification(f.recipient.id, first);
  assert.equal(replay.consumed, false);
  assert.deepEqual(replay.claims, []);
  assert.equal(f.store.notificationStatus(f.recipient.id).notification!.id, second);
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 1);
  assert.equal(await runDevinInboxHook(postTool, f.store, write), false);
  assert.equal(outputs.length, 2);
});

test('concurrent Devin hooks write once and uncertain output is not retried at the next boundary', {timeout: 5000}, async t => {
  const f = fixture(t);
  f.send('concurrent');
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const outputs: Output[] = [];
  const first = runDevinInboxHook(postTool, f.store, async output => {
    outputs.push(output);
    started();
    await pending;
  });
  await entered;
  assert.equal(await runDevinInboxHook(postTool, f.store, async output => { outputs.push(output); }), false);
  release();
  assert.equal(await first, true);
  assert.equal(outputs.length, 1);
  f.store.consumeNotification(f.recipient.id, token(outputs[0]!));
  f.send('output-failure');
  await assert.rejects(runDevinInboxHook(postTool, f.store, async () => { throw new Error('Host output closed'); }), /Host output closed/);
  assert.equal(f.store.notificationStatus(f.recipient.id).notification!.state, 'unknown');
  assert.equal(await runDevinInboxHook(postTool, f.store, async () => { throw new Error('Must not retry uncertain output'); }), false);
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 1);
});

test('Devin CLI inbox hook leaves a missing ledger absent and emits only a bounded token hint after activation', t => {
  const root = mkdtempSync('/tmp/sb-devin-idle-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const missingHome = join(root, 'not-created');
  const run = (home: string) => execFileSync(process.execPath,
    [entry, 'inbox-hook', '--host', 'devin', '--home', home],
    {input: JSON.stringify(postTool), encoding: 'utf8', timeout: 5000});
  assert.equal(run(missingHome), '');
  assert.equal(existsSync(missingHome), false);
  const f = fixture(t);
  const request = f.send('cli');
  const output = JSON.parse(run(f.home)) as Output;
  token(output);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(f.store.message(f.sender.id, request.id).acknowledgedAt, null);
  assert.equal(run(f.home), '', 'Repeated lifecycle events do not emit another native hint.');
});

test('inactive Devin CLI hooks leave older and newer shared ledger schemas unchanged', t => {
  for (const version of [4, 6]) {
    const home = mkdtempSync('/tmp/sb-devin-incompatible-hook-');
    t.after(() => rmSync(home, {recursive: true, force: true}));
    const store = new Store(home);
    store.ensureCodexPeer({nativeSessionId: CODEX_ID});
    store.close();
    const file = join(home, 'bridge.sqlite');
    const database = new DatabaseSync(file);
    database.exec(`PRAGMA journal_mode=DELETE; PRAGMA user_version=${version}`);
    database.close();
    const before = readFileSync(file);
    const output = execFileSync(process.execPath,
      [entry, 'inbox-hook', '--host', 'devin', '--home', home],
      {input: JSON.stringify(postTool), encoding: 'utf8', timeout: 5000});
    assert.equal(output, '');
    assert.deepEqual(readFileSync(file), before, 'A passive hook must not migrate or change journal mode.');
    const listing = execFileSync(process.execPath,
      [entry, 'sessions', '--host', 'devin', '--session-id', DEVIN_ID, '--home', home],
      {encoding: 'utf8', timeout: 5000});
    assert.equal(JSON.parse(listing).activationRequired, true);
    assert.deepEqual(readFileSync(file), before, 'A passive CLI listing must not migrate either.');
    assert.equal(existsSync(`${file}-wal`), false);
  }
});

test('a stalled Devin hook stdout reader cannot keep the process alive or retry uncertain output', {timeout: 6000}, async t => {
  const f = fixture(t);
  const request = f.send('stalled-output');
  const preload = 'process.stdout.write(Buffer.alloc(1024*1024))';
  const child = spawn(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    entry, 'inbox-hook', '--host', 'devin', '--home', f.home,
  ], {stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify(postTool));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    child.stdout.destroy();
  });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.match(stderr, /Hook output timed out/);
  assert.equal(f.store.notificationStatus(f.recipient.id).notification!.state, 'unknown');
  assert.equal(f.store.message(f.recipient.id, request.id).acknowledgedAt, null);
  assert.equal(await runDevinInboxHook(postTool, f.store, async () => { throw new Error('Must not resend'); }), false);
});


test('a bounded Devin notification read leaves one successor hint for the unread remainder', async t => {
  const f = fixture(t);
  const ids = new Set<string>();
  const outputs: Output[] = [];
  const write = async (output: Output) => { outputs.push(output); };
  for (let index = 0; index < 25; index++) ids.add(f.send(`bounded-${index}`).id);
  await runDevinInboxHook(postTool, f.store, write);
  const firstToken = token(outputs[0]!);
  const first = f.store.consumeNotification(f.recipient.id, firstToken);
  assert.equal(first.claims.length, 20);
  assert.equal(first.remaining, true);
  assert.equal(first.notification!.state, 'pending');
  assert.equal(await runDevinInboxHook(postTool, f.store, write), true);
  const successorToken = token(outputs[1]!);
  assert.notEqual(successorToken, firstToken);
  const replay = f.store.consumeNotification(f.recipient.id, firstToken);
  assert.equal(replay.consumed, false);
  assert.ok(replay.claims.every(claim => claim.alreadyClaimed));
  assert.equal(f.store.notificationStatus(f.recipient.id).notification!.id, successorToken);
  assert.equal(await runDevinInboxHook(postTool, f.store, write), false);
  const last = f.store.consumeNotification(f.recipient.id, successorToken);
  assert.equal(last.claims.length, 5);
  assert.equal(last.remaining, false);
  assert.deepEqual(new Set([...first.claims, ...last.claims].map(claim => claim.message.id)), ids);
  assert.equal(await runDevinInboxHook(postTool, f.store, write), false);
  assert.equal(outputs.length, 2);
});

test('Devin hooks deliver a pending historical notification through the current alias of the same native session', async t => {
  const f = fixture(t);
  f.send('old-registration');
  const pending = f.store.reserveNotification(f.recipient.id)!;
  f.store.closePeer(f.recipient.id);
  const aliasId = `sb_${randomUUID()}`;
  const db = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    // Older ledgers can retain multiple registrations for one native session.
    db.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,attached_at)
      VALUES(?,'devin','Current native alias',?,?,?)`).run(aliasId, DEVIN_ID, Date.now(), Date.now());
  } finally { db.close(); }
  f.store.pair(f.sender.id, aliasId);
  const fresh = f.store.send(f.sender.id, {to: aliasId, body: 'Read the fresh selected snapshot.', idempotencyKey: 'fresh-alias'});
  const outputs: Output[] = [];
  assert.equal(await runDevinInboxHook(postTool, f.store, async output => { outputs.push(output); }), true);
  assert.equal(token(outputs[0]!), pending.id);
  assert.equal(pending.to, f.recipient.id);
  assert.notEqual(pending.to, aliasId);
  const receipt = f.store.consumeNotification(aliasId, pending.id);
  assert.equal(receipt.consumed, true);
  assert.deepEqual(receipt.claims.map(claim => claim.message.id), [fresh.id]);
  assert.equal(await runDevinInboxHook(postTool, f.store, async output => { outputs.push(output); }), false);
  assert.equal(outputs.length, 1);
});
