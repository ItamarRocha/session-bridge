import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { startMonitor } from '../src/monitor.js';
import { Bridge } from '../src/bridge.js';
import { Sessions } from '../src/sessions.js';
import { Store } from '../src/store.js';

async function until(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('The expected monitor state did not arrive.');
    await delay(5);
  }
}

function notificationToken(line: string) {
  return /"notificationToken"\s*:\s*"([^"]+)"/.exec(line)?.[1];
}

function notificationTokens(lines: string[]) {
  return lines.flatMap(line => notificationToken(line) ?? []);
}

function fixture(t: TestContext) {
  const home = mkdtempSync('/tmp/sb-monitor-');
  const sessionId = randomUUID();
  const store = new Store(home);
  const monitors: Awaited<ReturnType<typeof startMonitor>>[] = [];
  t.after(async () => {
    try { for (const monitor of monitors) await monitor.close(); }
    finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  });
  const start = async (output: Parameters<typeof startMonitor>[2], options: Parameters<typeof startMonitor>[4] = {}) => {
    const monitor = await startMonitor(home, 'Claude fixture', output, sessionId, { pollIntervalMs: 10, ...options });
    monitors.push(monitor);
    return monitor;
  };
  const sender = (peerId: string) => {
    const bridge = new Bridge(store, 'codex');
    bridge.attach({ sessionId: randomUUID(), label: 'Selected fixture sender' });
    bridge.pair(peerId);
    return bridge;
  };
  return { home, store, sessionId, start, sender, sessions: new Sessions(store, 'claude', sessionId) };
}

test('twenty durable messages produce one opaque notice and ordinary reads do not rearm it', async t => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'ipc'), 'An unrelated file must not be used for message delivery.');
  const notices: string[] = [];
  let finishFirst!: () => void;
  const monitor = await f.start(line => {
    notices.push(line);
    if (notificationToken(line) && notificationTokens(notices).length === 1) {
      return new Promise<void>(resolve => { finishFirst = resolve; });
    }
  });
  const peer = f.store.findNativePeer(f.sessionId, 'claude')!;
  assert.equal(peer.id, monitor.peer.id);
  assert.notEqual(peer.attachedAt, null);
  assert.equal(peer.endpoint, null);
  assert.match(notices[0]!, new RegExp(f.sessionId));
  assert.doesNotMatch(notices[0]!, /sbt_|sb_|bridge_attach/);
  await assert.rejects(f.start(() => {}), /receiver|lease|active/i);
  await delay(40);
  assert.equal(notices.length, 1, 'An idle receiver must not wake the native conversation.');

  const sender = f.sender(peer.id);
  const messages = [];
  for (let index = 0; index < 20; index++) messages.push(await sender.send({
    to: peer.id, body: `Selected private request body ${index}`, idempotencyKey: `burst-${index}`,
  }));
  await until(() => notificationTokens(notices).length === 1);
  const token = notificationTokens(notices)[0]!;
  assert.equal(f.store.incoming(peer.id, { limit: 100 }).length, 20);
  for (const message of messages) {
    assert.equal(message.delivery, 'stored');
    assert.equal(f.store.message(peer.id, message.id).acknowledgedAt, null);
    assert.ok(notices.every(line => !line.includes(message.id) && !line.includes(message.body)));
  }
  f.sessions.read({ limit: 100 });
  assert.ok(messages.every(message => f.store.message(peer.id, message.id).acknowledgedAt !== null));
  const later = await sender.send({ to: peer.id, body: 'Arrives behind the outstanding token', idempotencyKey: 'later' });
  finishFirst();
  await until(() => f.store.notificationStatus(peer.id).notification?.state === 'submitted');
  await delay(40);
  assert.deepEqual(notificationTokens(notices), [token]);
  assert.equal(f.store.notificationStatus(peer.id).notification!.id, token);
  assert.equal(f.store.message(peer.id, later.id).acknowledgedAt, null);

  f.store.consumeNotification(peer.id, token, 100);
  assert.notEqual(f.store.message(peer.id, later.id).acknowledgedAt, null);
  const next = await sender.send({ to: peer.id, body: 'Arrives after token consumption', idempotencyKey: 'next' });
  await until(() => notificationTokens(notices).length === 2);
  assert.notEqual(notificationTokens(notices)[1], token);
  assert.equal(f.store.message(peer.id, next.id).acknowledgedAt, null);
  await sender.send({ to: peer.id, body: next.body, idempotencyKey: 'next' });
  await delay(40);
  assert.equal(notificationTokens(notices).length, 2);
});

test('reactivation preserves the outstanding token and stays quiet until that delivered token is read', async t => {
  const f = fixture(t);
  const first: string[] = [];
  const monitor = await f.start(line => { first.push(line); });
  const sender = f.sender(monitor.peer.id);
  const read = await sender.send({ to: monitor.peer.id, body: 'Already read', idempotencyKey: 'read' });
  const unread = await sender.send({ to: monitor.peer.id, body: 'Still unread', idempotencyKey: 'unread' });
  await until(() => notificationTokens(first).length === 1);
  const token = notificationTokens(first)[0]!;
  const receipt = f.store.claim(monitor.peer.id, read.id);
  const pairing = f.store.pairings(monitor.peer.id)[0]!;
  await monitor.close();
  await monitor.done;
  assert.equal(f.store.receiverStatus(monitor.peer.id).state, 'unavailable');
  assert.equal(f.store.peer(monitor.peer.id).closedAt, null);
  assert.deepEqual(f.store.pairings(monitor.peer.id), [pairing]);

  const offline = await sender.send({ to: monitor.peer.id, body: 'Arrived while stopped', idempotencyKey: 'offline' });
  const next: string[] = [];
  const replacement = await f.start(line => { next.push(line); });
  assert.equal(replacement.peer.id, monitor.peer.id);
  await delay(60);
  assert.deepEqual(notificationTokens(next), []);
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.id, token);
  assert.equal(f.store.message(monitor.peer.id, read.id).claimId, receipt.claimId);
  assert.equal(f.store.message(monitor.peer.id, unread.id).acknowledgedAt, null);
  assert.equal(f.store.message(monitor.peer.id, offline.id).acknowledgedAt, null);
  f.store.consumeNotification(monitor.peer.id, token, 100);
  await sender.send({ to: monitor.peer.id, body: 'Fresh inbox work', idempotencyKey: 'fresh' });
  await until(() => notificationTokens(next).length === 1);
  assert.notEqual(notificationTokens(next)[0], token);
  await monitor.close();
  assert.equal(f.store.receiverStatus(replacement.peer.id).state, 'available');
});

test('a reserved token that never began output is delivered once by a replacement receiver', async t => {
  const f = fixture(t);
  const oldNotices: string[] = [];
  const monitor = await f.start(line => { oldNotices.push(line); });
  const sender = f.sender(monitor.peer.id);
  const message = f.store.send(sender.self().id, {
    to: monitor.peer.id, body: 'Reserved before the old watcher starts output', idempotencyKey: 'reserved',
  });
  const reserved = f.store.reserveNotification(monitor.peer.id)!;
  assert.equal(reserved.state, 'pending');
  await monitor.close();
  assert.deepEqual(notificationTokens(oldNotices), []);
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.state, 'pending');
  const next: string[] = [];
  await f.start(line => { next.push(line); });
  await until(() => f.store.notificationStatus(monitor.peer.id).notification?.state === 'submitted');
  assert.deepEqual(notificationTokens(next), [reserved.id]);
  assert.equal(f.store.message(monitor.peer.id, message.id).acknowledgedAt, null);
});

test('a replacement Claude alias emits an unstarted token retained by its closed native identity', async t => {
  const f = fixture(t);
  const original = f.store.createPeer({ host: 'claude', nativeSessionId: f.sessionId, label: 'Earlier receiver' });
  f.store.attach(original.ticket);
  const sender = f.sender(original.peer.id);
  f.store.send(sender.self().id, { to: original.peer.id, body: 'Earlier request', idempotencyKey: 'earlier' });
  const reserved = f.store.reserveNotification(original.peer.id)!;
  assert.equal(reserved.to, original.peer.id);
  assert.equal(reserved.state, 'pending');
  f.store.closePeer(original.peer.id);
  const aliasId = `sb_${randomUUID()}`;
  const database = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    database.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,attached_at)
      VALUES(?,'claude','Reactivated native alias',?,?,?)`)
      .run(aliasId, f.sessionId.toUpperCase(), Date.now(), Date.now());
  } finally { database.close(); }
  sender.pair(aliasId);
  const fresh = f.store.send(sender.self().id, { to: aliasId, body: 'Current unread request', idempotencyKey: 'current' });
  assert.equal(f.store.sameSession(aliasId, original.peer.id), true);
  assert.equal(f.store.reserveNotification(aliasId)!.id, reserved.id);

  const notices: string[] = [];
  const monitor = await f.start(line => { notices.push(line); });
  assert.equal(monitor.peer.id, aliasId);
  await until(() => notificationTokens(notices).length === 1
    || f.store.notificationStatus(aliasId).notification?.state === 'unknown');
  assert.deepEqual(notificationTokens(notices), [reserved.id]);
  assert.equal(f.store.notificationStatus(aliasId).notification!.state, 'submitted');
  assert.equal(f.store.receiverStatus(aliasId).state, 'available');
  assert.notEqual(f.store.peer(original.peer.id).closedAt, null);
  assert.equal(f.store.message(aliasId, fresh.id).acknowledgedAt, null);
  const read = f.store.consumeNotification(aliasId, reserved.id, 100);
  assert.deepEqual(read.claims.map(claim => claim.message.id), [fresh.id]);
  await delay(40);
  assert.deepEqual(notificationTokens(notices), [reserved.id]);
});

test('consuming a token before stdout completes cannot let its late completion replace a successor', async t => {
  const f = fixture(t);
  const notices: string[] = [];
  let finishFirst!: () => void;
  const monitor = await f.start(line => {
    notices.push(line);
    const token = notificationToken(line);
    if (token && notificationTokens(notices).length === 1) {
      f.store.consumeNotification(f.store.findNativePeer(f.sessionId, 'claude')!.id, token, 100);
      return new Promise<void>(resolve => { finishFirst = resolve; });
    }
  });
  const sender = f.sender(monitor.peer.id);
  const first = await sender.send({ to: monitor.peer.id, body: 'Delivered before output callback completes', idempotencyKey: 'first' });
  await until(() => finishFirst !== undefined);
  const firstToken = notificationTokens(notices)[0]!;
  assert.notEqual(f.store.message(monitor.peer.id, first.id).acknowledgedAt, null);
  const next = await sender.send({ to: monitor.peer.id, body: 'Next unread work', idempotencyKey: 'next' });
  finishFirst();
  await until(() => notificationTokens(notices).length === 2);
  const nextToken = notificationTokens(notices)[1]!;
  assert.notEqual(nextToken, firstToken);
  f.store.consumeNotification(monitor.peer.id, firstToken, 100);
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.id, nextToken);
  assert.equal(f.store.message(monitor.peer.id, next.id).acknowledgedAt, null);
  await delay(40);
  assert.equal(notificationTokens(notices).length, 2);
});

test('ownership loss cannot let an old stdout completion finish a notification or release the replacement lease', async t => {
  const f = fixture(t);
  const notices: string[] = [];
  let finishOld!: () => void;
  const monitor = await f.start(line => {
    notices.push(line);
    if (notificationToken(line)) return new Promise<void>(resolve => { finishOld = resolve; });
  });
  const sender = f.sender(monitor.peer.id);
  const message = await sender.send({ to: monitor.peer.id, body: 'Stale writer fixture', idempotencyKey: 'stale' });
  await until(() => finishOld !== undefined);
  const token = notificationTokens(notices)[0]!;
  const replacementStore = new Store(f.home, () => Date.now() + 6_000);
  try {
    const replacement = replacementStore.acquireReceiver({ nativeSessionId: f.sessionId, label: 'Recovered owner' });
    assert.equal(replacement.peer.id, monitor.peer.id);
    await monitor.done;
    finishOld();
    await delay(20);
    await monitor.close();
    assert.equal(replacementStore.notificationStatus(monitor.peer.id).notification!.id, token);
    assert.equal(replacementStore.notificationStatus(monitor.peer.id).notification!.state, 'submitting');
    assert.equal(f.store.message(monitor.peer.id, message.id).acknowledgedAt, null);
    assert.equal(replacementStore.renewReceiver(replacement.peer.id, replacement.ownerToken), true);
    assert.equal(replacementStore.pairings(replacement.peer.id).length, 1);
    assert.equal(notificationTokens(notices).length, 1);
    replacementStore.releaseReceiver(replacement.peer.id, replacement.ownerToken);
  } finally { replacementStore.close(); }
});

test('uncertain stdout output stays quiet after restart while targeted and history reads recover durable messages', async t => {
  const f = fixture(t);
  let token: string | undefined;
  const monitor = await f.start(async line => {
    token = notificationToken(line);
    if (token) throw new Error('stdout EPIPE');
  });
  const sender = f.sender(monitor.peer.id);
  const message = await sender.send({ to: monitor.peer.id, body: 'Readable after output failure', idempotencyKey: 'output-failure' });
  await assert.rejects(monitor.done, /stdout EPIPE/);
  assert.equal(f.store.receiverStatus(monitor.peer.id).state, 'unavailable');
  assert.equal(f.store.peer(monitor.peer.id).closedAt, null);
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.state, 'unknown');
  assert.equal(f.store.message(monitor.peer.id, message.id).acknowledgedAt, null);
  const recovered: string[] = [];
  await f.start(line => { recovered.push(line); });
  const later = await sender.send({ to: monitor.peer.id, body: 'Queued behind uncertainty', idempotencyKey: 'later' });
  await delay(60);
  assert.deepEqual(notificationTokens(recovered), []);
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.id, token);
  assert.equal(f.sessions.read({ messageId: message.id }).messages[0]!.text, message.body);
  assert.ok(f.sessions.read({ limit: 100 }).messages.some(item => item.messageId === later.id));
  assert.notEqual(f.store.message(monitor.peer.id, later.id).acknowledgedAt, null);
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.state, 'unknown');
  await delay(40);
  assert.deepEqual(notificationTokens(recovered), []);
  assert.equal(f.store.pairings(monitor.peer.id).length, 1);
});

test('a stalled stdout write is bounded and its late completion cannot clear uncertainty', async t => {
  const f = fixture(t);
  let finishOutput!: () => void;
  let writes = 0;
  const monitor = await f.start(line => {
    if (!notificationToken(line)) return;
    writes++;
    return new Promise<void>(resolve => { finishOutput = resolve; });
  }, { outputTimeoutMs: 50 });
  const sender = f.sender(monitor.peer.id);
  const first = await sender.send({ to: monitor.peer.id, body: 'First blocked output', idempotencyKey: 'blocked-1' });
  const next = await sender.send({ to: monitor.peer.id, body: 'Must remain queued', idempotencyKey: 'blocked-2' });
  await assert.rejects(monitor.done, /output.*deadline/);
  assert.equal(writes, 1);
  assert.equal(f.store.receiverStatus(monitor.peer.id).state, 'unavailable');
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.state, 'unknown');
  finishOutput();
  await delay(20);
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.state, 'unknown');
  assert.equal(f.store.message(monitor.peer.id, first.id).acknowledgedAt, null);
  assert.equal(f.store.message(monitor.peer.id, next.id).acknowledgedAt, null);
});

test('closing during an output wait returns promptly and preserves an uncertain notification', async t => {
  const f = fixture(t);
  let started = false;
  const monitor = await f.start(line => {
    if (!notificationToken(line)) return;
    started = true;
    return new Promise<void>(() => {});
  });
  const sender = f.sender(monitor.peer.id);
  const message = await sender.send({ to: monitor.peer.id, body: 'Interrupted output', idempotencyKey: 'closing' });
  await until(() => started);
  await monitor.close();
  await monitor.done;
  assert.equal(f.store.message(monitor.peer.id, message.id).acknowledgedAt, null);
  assert.equal(f.store.notificationStatus(monitor.peer.id).notification!.state, 'unknown');
  assert.equal(f.store.receiverStatus(monitor.peer.id).state, 'unavailable');
});

test('failed readiness output releases ownership and permits reactivation of the same native peer', async t => {
  const f = fixture(t);
  await assert.rejects(f.start(async () => { throw new Error('readiness output closed'); }), /readiness output closed/);
  const peer = f.store.findNativePeer(f.sessionId, 'claude')!;
  assert.ok(peer);
  assert.equal(f.store.receiverStatus(peer.id).state, 'unavailable');
  assert.equal(f.store.notificationStatus(peer.id).notification, null);
  const replacement = await f.start(() => {});
  assert.equal(replacement.peer.id, peer.id);
  assert.equal(existsSync(join(f.home, 'ipc')), false);
});

test('legacy ticket activation receives through the same inbox watcher', async t => {
  const f = fixture(t);
  const notices: string[] = [];
  const monitor = await startMonitor(f.home, 'Legacy fixture', line => { notices.push(line); }, undefined, { pollIntervalMs: 10 });
  try {
    const ticket = /"ticket":"(sbt_[^"]+)"/.exec(notices[0]!)?.[1];
    assert.ok(ticket);
    const recipient = new Bridge(f.store, 'claude');
    assert.equal(recipient.attach({ ticket }).id, monitor.peer.id);
    const sender = f.sender(monitor.peer.id);
    const message = await sender.send({ to: monitor.peer.id, body: 'Legacy request', idempotencyKey: 'legacy' });
    await until(() => notices.some(line => line.includes(message.id)));
    assert.match(notices[1]!, /bridge_receive/);
    assert.equal(f.store.message(monitor.peer.id, message.id).delivery, 'submitted');
  } finally { await monitor.close(); }
});

test('receipts, cancellation, expiry, disconnected pairs and uncertain legacy delivery cannot trigger a new token', async t => {
  const f = fixture(t);
  const notices: string[] = [];
  let ready!: () => void;
  const starting = f.start(line => {
    notices.push(line);
    if (line.includes('receiver ready')) return new Promise<void>(resolve => { ready = resolve; });
  });
  await until(() => ready !== undefined);
  const peer = f.store.findNativePeer(f.sessionId, 'claude')!;
  const sender = f.sender(peer.id);
  const send = (key: string) => f.store.send(sender.self().id, { to: peer.id, body: key, idempotencyKey: key });
  const read = send('already-read');
  f.store.claim(peer.id, read.id);
  const cancelled = send('cancelled');
  sender.cancel(cancelled.id);
  const unknown = send('unknown');
  f.store.beginDelivery(unknown.id);
  f.store.finishDelivery(unknown.id, { state: 'unknown', detail: 'Older adapter could not confirm delivery.' });
  const dispatching = send('dispatching');
  f.store.beginDelivery(dispatching.id);
  const oldSubmitted = send('old-submitted');
  f.store.beginDelivery(oldSubmitted.id);
  f.store.finishDelivery(oldSubmitted.id, { state: 'submitted', detail: 'Older adapter submitted without watcher evidence.' });
  const previousClock = new Store(f.home, () => Date.now() - 2_000);
  try {
    const expired = previousClock.send(sender.self().id, { to: peer.id, body: 'Expired inbox message', idempotencyKey: 'expired', ttlSeconds: 1 });
    assert.ok(expired.expiresAt < Date.now());
  } finally { previousClock.close(); }
  const formerSender = f.sender(peer.id);
  f.store.send(formerSender.self().id, { to: peer.id, body: 'Disconnected request', idempotencyKey: 'disconnected' });
  formerSender.disconnect(f.store.pairings(formerSender.self().id)[0]!.id);
  ready();
  await starting;
  await delay(40);
  assert.deepEqual(notificationTokens(notices), []);
  assert.equal(f.store.notificationStatus(peer.id).notification, null);
  send('eligible');
  await until(() => notificationTokens(notices).length === 1);
  await delay(40);
  assert.equal(notices.length, 2);
});
