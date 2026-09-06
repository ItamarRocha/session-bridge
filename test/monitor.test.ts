import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMonitor } from '../src/monitor.js';
import { Bridge } from '../src/bridge.js';
import { Store } from '../src/store.js';

async function until(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail('The expected monitor state did not arrive.');
    await delay(5);
  }
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
  const start = async (output: Parameters<typeof startMonitor>[2], options: Parameters<typeof startMonitor>[4] = {}, nativeId: string | undefined = sessionId) => {
    const monitor = await startMonitor(home, 'Claude fixture', output, nativeId, { pollIntervalMs: 10, ...options });
    monitors.push(monitor);
    return monitor;
  };
  const sender = (peerId: string) => {
    const bridge = new Bridge(store, 'codex');
    bridge.attach({ sessionId: randomUUID(), label: 'Selected fixture sender' });
    bridge.pair(peerId);
    return bridge;
  };
  return { home, store, sessionId, start, sender };
}

test('native receiver watches durable inbox arrivals without sockets or idle notifications', async t => {
  const f = fixture(t);
  writeFileSync(join(f.home, 'ipc'), 'An unrelated file must not be used for message delivery.');
  const notices: string[] = [];
  const monitor = await f.start(line => { notices.push(line); });
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
  const input = { to: peer.id, body: 'Selected private request body', idempotencyKey: 'first-arrival' };
  const message = await sender.send(input);
  assert.equal(message.delivery, 'stored');
  await until(() => notices.some(line => line.includes(message.id)));
  assert.equal(f.store.message(sender.self().id, message.id).delivery, 'submitted');
  assert.equal(f.store.message(sender.self().id, message.id).acknowledgedAt, null);
  assert.equal((await sender.send(input)).id, message.id);
  await delay(40);
  assert.equal(notices.filter(line => line.includes(message.id)).length, 1);
  assert.ok(notices.every(line => !line.includes(input.body)), 'Notices contain references, not message bodies.');

  const later = await sender.send({ ...input, idempotencyKey: 'late-arrival' });
  await until(() => notices.some(line => line.includes(later.id)));
  assert.equal(notices.length, 3);
});

test('explicit reactivation reuses the same peer and connections, and only repeats unread notice IDs', async t => {
  const f = fixture(t);
  const first: string[] = [];
  const monitor = await f.start(line => { first.push(line); });
  const sender = f.sender(monitor.peer.id);
  const read = await sender.send({ to: monitor.peer.id, body: 'Already read', idempotencyKey: 'read' });
  const unread = await sender.send({ to: monitor.peer.id, body: 'Still unread', idempotencyKey: 'unread' });
  await until(() => first.some(line => line.includes(unread.id)));
  const receipt = f.store.claim(monitor.peer.id, read.id);
  const pairing = f.store.pairings(monitor.peer.id)[0]!;
  await monitor.close();
  await monitor.done;
  assert.equal(f.store.receiverStatus(monitor.peer.id).state, 'unavailable');
  assert.equal(f.store.peer(monitor.peer.id).closedAt, null);
  assert.deepEqual(f.store.pairings(monitor.peer.id), [pairing]);

  const offline = await sender.send({ to: monitor.peer.id, body: 'Arrived while stopped', idempotencyKey: 'offline' });
  assert.equal(offline.delivery, 'stored');
  const next: string[] = [];
  const replacement = await f.start(line => { next.push(line); });
  assert.equal(replacement.peer.id, monitor.peer.id);
  await until(() => next.some(line => line.includes(offline.id)));
  assert.equal(next.filter(line => line.includes(unread.id)).length, 1);
  assert.equal(next.some(line => line.includes(read.id)), false);
  assert.equal(f.store.message(monitor.peer.id, read.id).claimId, receipt.claimId);
  assert.equal(f.store.message(monitor.peer.id, unread.id).acknowledgedAt, null);
  await monitor.close();
  assert.equal(f.store.receiverStatus(replacement.peer.id).state, 'available');
});

test('loss of receiver ownership stops the old watcher without releasing its replacement lease', async t => {
  const f = fixture(t);
  const notices: string[] = [];
  const monitor = await f.start(line => { notices.push(line); });
  const sender = f.sender(monitor.peer.id);
  const replacementStore = new Store(f.home, () => Date.now() + 6_000);
  try {
    const replacement = replacementStore.acquireReceiver({ nativeSessionId: f.sessionId, label: 'Recovered owner' });
    assert.equal(replacement.peer.id, monitor.peer.id);
    await sender.send({ to: monitor.peer.id, body: 'For the new receiver only', idempotencyKey: 'replaced' });
    await monitor.done;
    await monitor.close();
    assert.equal(notices.length, 1, 'A fenced owner cannot emit new inbox notifications.');
    assert.equal(replacementStore.renewReceiver(replacement.peer.id, replacement.ownerToken), true);
    assert.equal(replacementStore.receiverStatus(replacement.peer.id).state, 'available');
    assert.equal(replacementStore.pairings(replacement.peer.id).length, 1);
    replacementStore.releaseReceiver(replacement.peer.id, replacement.ownerToken);
  } finally { replacementStore.close(); }
});

test('async stdout failure releases the lease and leaves the same unread message for explicit recovery', async t => {
  const f = fixture(t);
  const monitor = await f.start(async line => {
    if (line.includes('has message')) throw new Error('stdout EPIPE');
  });
  const sender = f.sender(monitor.peer.id);
  const message = await sender.send({ to: monitor.peer.id, body: 'Recovery after output failure', idempotencyKey: 'output-failure' });
  await assert.rejects(monitor.done, /stdout EPIPE/);
  assert.equal(f.store.receiverStatus(monitor.peer.id).state, 'unavailable');
  assert.equal(f.store.peer(monitor.peer.id).closedAt, null);
  assert.equal(f.store.message(monitor.peer.id, message.id).delivery, 'stored');
  assert.equal(f.store.message(monitor.peer.id, message.id).acknowledgedAt, null);
  const recovered: string[] = [];
  await f.start(line => { recovered.push(line); });
  await until(() => recovered.some(line => line.includes(message.id)));
  assert.equal(f.store.pairings(monitor.peer.id).length, 1);
});

test('a stalled stdout write is bounded and cannot overlap another notice or mark a late completion', async t => {
  const f = fixture(t);
  let finishOutput!: () => void;
  let writes = 0;
  const monitor = await f.start(line => {
    if (!line.includes('has message')) return;
    writes++;
    return new Promise<void>(resolve => { finishOutput = resolve; });
  }, { outputTimeoutMs: 50 });
  const sender = f.sender(monitor.peer.id);
  const first = await sender.send({ to: monitor.peer.id, body: 'First blocked output', idempotencyKey: 'blocked-1' });
  const next = await sender.send({ to: monitor.peer.id, body: 'Must remain queued', idempotencyKey: 'blocked-2' });
  await assert.rejects(monitor.done, /output.*deadline/);
  assert.equal(writes, 1);
  assert.equal(f.store.receiverStatus(monitor.peer.id).state, 'unavailable');
  finishOutput();
  await delay(20);
  assert.equal(f.store.message(monitor.peer.id, first.id).delivery, 'stored');
  assert.equal(f.store.message(monitor.peer.id, next.id).delivery, 'stored');
});

test('closing during an output wait returns promptly and does not consume the pending message', async t => {
  const f = fixture(t);
  let started = false;
  const monitor = await f.start(line => {
    if (!line.includes('has message')) return;
    started = true;
    return new Promise<void>(() => {});
  });
  const sender = f.sender(monitor.peer.id);
  const message = await sender.send({ to: monitor.peer.id, body: 'Interrupted output', idempotencyKey: 'closing' });
  await until(() => started);
  await monitor.close();
  await monitor.done;
  assert.equal(f.store.message(monitor.peer.id, message.id).delivery, 'stored');
  assert.equal(f.store.receiverStatus(monitor.peer.id).state, 'unavailable');
});

test('failed readiness output releases ownership and permits reactivation of the same native peer', async t => {
  const f = fixture(t);
  await assert.rejects(f.start(async () => { throw new Error('readiness output closed'); }), /readiness output closed/);
  const peer = f.store.findNativePeer(f.sessionId, 'claude')!;
  assert.ok(peer);
  assert.equal(f.store.receiverStatus(peer.id).state, 'unavailable');
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

test('the watcher skips receipts, cancelled or expired messages, disconnected pairs and uncertain legacy delivery', async t => {
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
  const send = (key: string) => sender.send({ to: peer.id, body: key, idempotencyKey: key });
  const read = await send('already-read');
  f.store.claim(peer.id, read.id);
  const cancelled = await send('cancelled');
  sender.cancel(cancelled.id);
  const unknown = await send('unknown');
  f.store.beginDelivery(unknown.id);
  f.store.finishDelivery(unknown.id, { state: 'unknown', detail: 'Older adapter could not confirm delivery.' });
  const dispatching = await send('dispatching');
  f.store.beginDelivery(dispatching.id);
  const oldSubmitted = await send('old-submitted');
  f.store.beginDelivery(oldSubmitted.id);
  f.store.finishDelivery(oldSubmitted.id, { state: 'submitted', detail: 'Older adapter submitted without watcher evidence.' });
  const previousClock = new Store(f.home, () => Date.now() - 2_000);
  try {
    const expired = previousClock.send(sender.self().id, { to: peer.id, body: 'Expired inbox message', idempotencyKey: 'expired', ttlSeconds: 1 });
    assert.ok(expired.expiresAt < Date.now());
  } finally { previousClock.close(); }
  const formerSender = f.sender(peer.id);
  await formerSender.send({ to: peer.id, body: 'Disconnected request', idempotencyKey: 'disconnected' });
  formerSender.disconnect(f.store.pairings(formerSender.self().id)[0]!.id);
  const eligible = await send('eligible');
  ready();
  await starting;
  await until(() => notices.some(line => line.includes(eligible.id)));
  await delay(40);
  assert.equal(notices.length, 2, 'Only readiness and the eligible message may reach the native conversation.');
});
