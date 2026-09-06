import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/store.js';
import type { Message } from '../src/types.js';

const NATIVE_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const SENDER_ID = 'bbbbbbbb-1111-2222-3333-444444444444';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'session-bridge-receiver-store-'));
  let time = 1_000_000;
  const stores: Store[] = [];
  const open = () => {
    const store = new Store(home, () => time);
    stores.push(store);
    return store;
  };
  const store = open();
  const sender = store.ensureCodexPeer({ nativeSessionId: SENDER_ID, label: 'Sender' });
  t.after(() => {
    for (const database of stores) {
      try { database.close(); } catch { /* Durability tests close an earlier connection. */ }
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { store, sender, open, now: () => time, advance: (ms: number) => { time += ms; } };
}

function ids(messages: Message[]): string[] {
  return messages.map(({ id }) => id).sort();
}

test('native receiver acquisition attaches the existing identity and preserves queued work and connections', (t) => {
  const f = fixture(t);
  const previous = f.store.createPeer({ host: 'claude', nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  const pairing = f.store.pair(f.sender.id, previous.peer.id);
  f.store.updateStatus(previous.peer.id, 'Review in progress');
  const request = f.store.send(f.sender.id, {
    to: previous.peer.id, body: 'Review the change', idempotencyKey: 'review',
  });
  f.advance(500);
  const receiver = f.open().acquireReceiver({ nativeSessionId: NATIVE_ID.toUpperCase(), label: 'Reviewer' });
  assert.equal(receiver.peer.id, previous.peer.id);
  assert.equal(receiver.peer.host, 'claude');
  assert.equal(receiver.peer.nativeSessionId, NATIVE_ID);
  assert.equal(receiver.peer.attachedAt, f.now());
  assert.equal(receiver.peer.statusText, 'Review in progress');
  assert.equal(receiver.ticket, undefined);
  assert.ok(receiver.ownerToken);
  assert.throws(() => f.store.attach(previous.ticket), /already used/);
  assert.deepEqual(f.store.pairings(receiver.peer.id), [pairing]);
  assert.deepEqual(ids(f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken)), [request.id]);
  assert.deepEqual(f.store.receiverStatus(receiver.peer.id), {
    state: 'available', checkedAt: f.now(), expiresAt: f.now() + 5000,
  });
});

test('a receiver without native identity retains the single-use legacy attachment ticket', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ label: 'Legacy receiver' });
  assert.equal(receiver.peer.host, 'claude');
  assert.equal(receiver.peer.nativeSessionId, null);
  assert.equal(receiver.peer.attachedAt, null);
  assert.ok(receiver.ticket);
  assert.equal(f.open().attach(receiver.ticket).id, receiver.peer.id);
  assert.throws(() => f.store.attach(receiver.ticket!), /already used/);
  f.store.releaseReceiver(receiver.peer.id, receiver.ownerToken);
  assert.equal(f.store.peer(receiver.peer.id).closedAt, null);
});

test('only the live receiver owner can renew its lease and an exact expiry cannot be revived', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  const other = f.open();
  assert.throws(() => other.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Competitor' }));
  assert.equal(other.renewReceiver(receiver.peer.id, 'wrong-owner'), false);
  f.advance(4000);
  assert.equal(other.renewReceiver(receiver.peer.id, receiver.ownerToken), true);
  assert.deepEqual(f.store.receiverStatus(receiver.peer.id), {
    state: 'available', checkedAt: f.now(), expiresAt: f.now() + 5000,
  });
  f.advance(4999);
  assert.equal(f.store.receiverStatus(receiver.peer.id).state, 'available');
  f.advance(1);
  assert.deepEqual(f.store.receiverStatus(receiver.peer.id), {
    state: 'unavailable', checkedAt: 1_004_000, expiresAt: f.now(),
  });
  assert.equal(other.renewReceiver(receiver.peer.id, receiver.ownerToken), false);
  assert.equal(f.store.receiverStatus(receiver.peer.id).state, 'unavailable');
});

test('replacement ownership fences stale renewal release notification and endpoint changes across connections', (t) => {
  const f = fixture(t);
  const old = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  const pairing = f.store.pair(f.sender.id, old.peer.id);
  const request = f.store.send(f.sender.id, { to: old.peer.id, body: 'Review', idempotencyKey: 'review' });
  f.advance(5000);
  const second = f.open();
  const current = second.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  assert.equal(current.peer.id, old.peer.id);
  assert.notEqual(current.ownerToken, old.ownerToken);
  const status = second.receiverStatus(current.peer.id);
  assert.equal(f.store.renewReceiver(old.peer.id, old.ownerToken), false);
  f.store.releaseReceiver(old.peer.id, old.ownerToken);
  assert.equal(f.store.markNotified(old.peer.id, old.ownerToken, request.id), false);
  assert.deepEqual(f.store.pendingNotifications(old.peer.id, old.ownerToken), []);
  assert.throws(() => f.store.setEndpoint(old.peer.id, '/private/tmp/stale-receiver.sock'));
  assert.deepEqual(second.receiverStatus(current.peer.id), status);
  assert.equal(second.peer(current.peer.id).endpoint, null);
  assert.deepEqual(second.pairings(current.peer.id), [pairing]);
  assert.deepEqual(ids(second.pendingNotifications(current.peer.id, current.ownerToken)), [request.id]);
  assert.equal(second.markNotified(current.peer.id, current.ownerToken, request.id), true);
});

test('normal receiver release preserves native identity pairing receipts and sender idempotency on restart', (t) => {
  const f = fixture(t);
  const old = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  const pairing = f.store.pair(f.sender.id, old.peer.id);
  const input = { to: old.peer.id, body: 'Review', idempotencyKey: 'review' };
  const request = f.store.send(f.sender.id, input);
  const receipt = f.store.claim(old.peer.id, request.id);
  const reply = f.store.reply(old.peer.id, request.id, receipt.claimId, 'Review complete');
  f.advance(1000);
  f.store.releaseReceiver(old.peer.id, old.ownerToken);
  assert.deepEqual(f.store.receiverStatus(old.peer.id), {
    state: 'unavailable', checkedAt: f.now(), expiresAt: f.now(),
  });
  assert.equal(f.store.peer(old.peer.id).closedAt, null);
  assert.deepEqual(f.store.pairings(old.peer.id), [pairing]);
  f.store.close();
  const reopened = f.open();
  const current = reopened.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  assert.equal(current.peer.id, old.peer.id);
  assert.notEqual(current.ownerToken, old.ownerToken);
  assert.equal(reopened.send(f.sender.id, input).id, request.id);
  const recovered = reopened.message(current.peer.id, request.id);
  assert.equal(recovered.claimId, receipt.claimId);
  assert.equal(recovered.acknowledgedAt, receipt.message.acknowledgedAt);
  assert.equal(recovered.answeredBy, reply.id);
  assert.deepEqual(reopened.pendingNotifications(current.peer.id, current.ownerToken), []);
  assert.equal(reopened.history(current.peer.id).length, 2);
});

test('explicit receiver closure invalidates ownership and reopening the native session leaves old pairings disconnected', (t) => {
  const f = fixture(t);
  const old = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  const oldPairing = f.store.pair(f.sender.id, old.peer.id);
  const notified = f.store.send(f.sender.id, { to: old.peer.id, body: 'Notified request', idempotencyKey: 'notified' });
  const stored = f.store.send(f.sender.id, { to: old.peer.id, body: 'Stored request', idempotencyKey: 'stored' });
  assert.equal(f.store.markNotified(old.peer.id, old.ownerToken, notified.id), true);
  f.advance(1000);
  f.store.closePeer(old.peer.id);
  assert.equal(f.store.peer(old.peer.id).closedAt, f.now());
  assert.equal(f.store.receiverStatus(old.peer.id).state, 'unavailable');
  assert.equal(f.store.renewReceiver(old.peer.id, old.ownerToken), false);
  assert.equal(f.store.markNotified(old.peer.id, old.ownerToken, stored.id), false);
  assert.deepEqual(f.store.pairings(old.peer.id), []);
  const reopened = f.open();
  const current = reopened.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  assert.equal(current.peer.id, old.peer.id);
  assert.notEqual(current.ownerToken, old.ownerToken);
  assert.equal(current.peer.closedAt, null);
  assert.deepEqual(reopened.connectedPeers(current.peer.id), []);
  assert.deepEqual(reopened.pendingNotifications(current.peer.id, current.ownerToken), []);
  for (const message of [notified, stored]) {
    assert.equal(reopened.markNotified(current.peer.id, current.ownerToken, message.id), false);
  }
  assert.throws(() => reopened.send(f.sender.id, { to: current.peer.id, body: 'Fresh request', idempotencyKey: 'fresh' }), /not paired/);
  const currentPairing = reopened.pair(f.sender.id, current.peer.id);
  assert.notEqual(currentPairing.id, oldPairing.id);
  const fresh = reopened.send(f.sender.id, { to: current.peer.id, body: 'Fresh request', idempotencyKey: 'fresh' });
  assert.deepEqual(ids(reopened.pendingNotifications(current.peer.id, current.ownerToken)), [fresh.id]);
  assert.equal(reopened.markNotified(current.peer.id, current.ownerToken, fresh.id), true);
  assert.equal(reopened.history(current.peer.id).length, 3);
});

test('ambiguous active native identities reject receiver acquisition without changing the original owner', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  const originalStatus = f.store.receiverStatus(receiver.peer.id);
  const database = new DatabaseSync(join(f.store.home, 'bridge.sqlite'));
  try {
    database.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at)
      VALUES('legacy-duplicate','claude','Duplicate native registration',?,?)`).run(NATIVE_ID.toUpperCase(), f.now());
  } finally {
    database.close();
  }
  f.advance(1000);
  assert.throws(() => f.open().acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Replacement' }), /ambiguous/i);
  assert.deepEqual(f.store.peer(receiver.peer.id), receiver.peer);
  assert.deepEqual(f.store.receiverStatus(receiver.peer.id), originalStatus);
  assert.equal(f.store.renewReceiver(receiver.peer.id, receiver.ownerToken), true);
  assert.deepEqual(f.store.receiverStatus(receiver.peer.id), {
    state: 'available', checkedAt: f.now(), expiresAt: f.now() + 5000,
  });
});

test('legacy peers have unknown receiver status and an existing endpoint requires an explicit upgrade', (t) => {
  const f = fixture(t);
  const legacy = f.store.createPeer({
    host: 'claude', nativeSessionId: NATIVE_ID, label: 'Legacy', endpoint: '/private/tmp/legacy-receiver.sock',
  });
  const pairing = f.store.pair(f.sender.id, legacy.peer.id);
  assert.deepEqual(f.store.receiverStatus(legacy.peer.id), { state: 'unknown', checkedAt: null, expiresAt: null });
  assert.deepEqual(f.store.receiverStatus(f.sender.id), { state: 'unknown', checkedAt: null, expiresAt: null });
  assert.throws(() => f.open().acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Replacement' }), /upgrad/i);
  assert.equal(f.store.peer(legacy.peer.id).endpoint, legacy.peer.endpoint);
  assert.deepEqual(f.store.pairings(legacy.peer.id), [pairing]);
  assert.equal(f.store.attach(legacy.ticket).id, legacy.peer.id);
});

test('old lease metadata does not authorize stealing a subsequently registered legacy endpoint', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({nativeSessionId: NATIVE_ID, label: 'Reviewer'});
  f.store.releaseReceiver(receiver.peer.id, receiver.ownerToken);
  f.store.setEndpoint(receiver.peer.id, '/private/tmp/new-legacy-receiver.sock');
  assert.deepEqual(f.store.receiverStatus(receiver.peer.id), {state: 'unknown', checkedAt: null, expiresAt: null});
  assert.throws(() => f.store.acquireReceiver({nativeSessionId: NATIVE_ID, label: 'Replacement'}), /upgrad/i);
  assert.equal(f.store.peer(receiver.peer.id).endpoint, '/private/tmp/new-legacy-receiver.sock');
});

test('notification scans are read only and each owner records at most one notification without claiming the message', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  f.store.pair(f.sender.id, receiver.peer.id);
  const request = f.store.send(f.sender.id, { to: receiver.peer.id, body: 'Review', idempotencyKey: 'review' });
  assert.deepEqual(ids(f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken)), [request.id]);
  assert.deepEqual(ids(f.open().pendingNotifications(receiver.peer.id, receiver.ownerToken)), [request.id]);
  assert.deepEqual(f.store.message(f.sender.id, request.id), request);
  assert.equal(f.store.markNotified(receiver.peer.id, receiver.ownerToken, request.id), true);
  const notified = f.store.message(f.sender.id, request.id);
  assert.equal(notified.delivery, 'submitted');
  assert.equal(notified.notifiedAt, f.now());
  assert.equal(notified.acknowledgedAt, null);
  assert.equal(notified.claimId, null);
  assert.equal(f.open().markNotified(receiver.peer.id, receiver.ownerToken, request.id), false);
  assert.deepEqual(f.store.message(f.sender.id, request.id), notified);
  assert.deepEqual(f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken), []);
  assert.deepEqual(ids(f.store.inbox(receiver.peer.id)), [request.id]);
});

test('restarted receivers recover prior-owner notifications once without replaying native or uncertain delivery', (t) => {
  const f = fixture(t);
  const old = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  f.store.pair(f.sender.id, old.peer.id);
  const send = (key: string) => f.store.send(f.sender.id, { to: old.peer.id, body: key, idempotencyKey: key });
  const stored = send('stored');
  const notified = send('notified');
  assert.equal(f.store.markNotified(old.peer.id, old.ownerToken, notified.id), true);
  const nativeSubmitted = send('native-submitted');
  assert.equal(f.store.beginDelivery(nativeSubmitted.id), true);
  f.store.finishDelivery(nativeSubmitted.id, { state: 'submitted', detail: 'Native transport accepted the message' });
  const unknown = send('unknown');
  assert.equal(f.store.beginDelivery(unknown.id), true);
  f.store.finishDelivery(unknown.id, { state: 'unknown', detail: 'Native transport outcome unavailable' });
  const dispatching = send('dispatching');
  assert.equal(f.store.beginDelivery(dispatching.id), true);
  const preserved = [nativeSubmitted, unknown, dispatching].map(({ id }) => f.store.message(f.sender.id, id));
  f.store.close();
  f.advance(5000);
  const reopened = f.open();
  const current = reopened.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  assert.deepEqual(ids(reopened.pendingNotifications(current.peer.id, current.ownerToken)), ids([stored, notified]));
  for (const message of [stored, notified]) {
    assert.equal(reopened.markNotified(current.peer.id, current.ownerToken, message.id), true);
    assert.equal(reopened.message(f.sender.id, message.id).notifiedAt, f.now());
  }
  assert.deepEqual(reopened.pendingNotifications(current.peer.id, current.ownerToken), []);
  for (const message of preserved) {
    assert.equal(reopened.markNotified(current.peer.id, current.ownerToken, message.id), false);
    assert.deepEqual(reopened.message(f.sender.id, message.id), message);
  }
  assert.equal(reopened.history(current.peer.id).length, 5);
});

test('receipt cancellation expiry and disconnection fence both scans and notifications after a receiver restart', (t) => {
  const f = fixture(t);
  const old = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  f.store.pair(f.sender.id, old.peer.id);
  const send = (key: string, ttlSeconds = 3600) => f.store.send(f.sender.id, {
    to: old.peer.id, body: key, idempotencyKey: key, ttlSeconds,
  });
  const acknowledged = send('acknowledged');
  const cancelled = send('cancelled');
  const expired = send('expired', 1);
  const otherSender = f.store.createPeer({ host: 'claude', label: 'Other sender' }).peer;
  const otherPairing = f.store.pair(otherSender.id, old.peer.id);
  const disconnected = f.store.send(otherSender.id, { to: old.peer.id, body: 'Disconnected', idempotencyKey: 'disconnected' });
  const closingSender = f.store.createPeer({ host: 'claude', label: 'Closing sender' }).peer;
  f.store.pair(closingSender.id, old.peer.id);
  const closedSender = f.store.send(closingSender.id, { to: old.peer.id, body: 'Sender closed', idempotencyKey: 'sender-closed' });
  for (const message of [acknowledged, cancelled, expired]) {
    assert.equal(f.store.markNotified(old.peer.id, old.ownerToken, message.id), true);
  }
  f.store.claim(old.peer.id, acknowledged.id);
  f.store.cancel(f.sender.id, cancelled.id);
  f.advance(1000);
  assert.deepEqual(ids(f.store.pendingNotifications(old.peer.id, old.ownerToken)), ids([disconnected, closedSender]));
  f.store.disconnect(otherSender.id, otherPairing.id);
  assert.notEqual(f.store.pair(otherSender.id, old.peer.id).id, otherPairing.id);
  f.store.closePeer(closingSender.id);
  const eligible = send('still-eligible');
  f.store.releaseReceiver(old.peer.id, old.ownerToken);
  const reopened = f.open();
  const current = reopened.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  assert.deepEqual(ids(reopened.pendingNotifications(current.peer.id, current.ownerToken)), [eligible.id]);
  for (const message of [acknowledged, cancelled, expired, disconnected, closedSender]) {
    assert.equal(reopened.markNotified(current.peer.id, current.ownerToken, message.id), false);
  }
  assert.equal(reopened.markNotified(current.peer.id, current.ownerToken, eligible.id), true);
});

test('expired ownership and another recipient cannot record notifications selected by a live receiver', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  const other = f.store.acquireReceiver({ label: 'Other receiver' });
  f.store.pair(f.sender.id, receiver.peer.id);
  const request = f.store.send(f.sender.id, { to: receiver.peer.id, body: 'Review', idempotencyKey: 'review' });
  assert.deepEqual(ids(f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken)), [request.id]);
  assert.equal(f.store.markNotified(other.peer.id, other.ownerToken, request.id), false);
  assert.deepEqual(f.store.pendingNotifications(other.peer.id, other.ownerToken), []);
  f.advance(5000);
  assert.deepEqual(f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken), []);
  assert.equal(f.store.markNotified(receiver.peer.id, receiver.ownerToken, request.id), false);
  assert.deepEqual(f.store.message(f.sender.id, request.id), request);
});

test('notification recording rechecks eligibility if a message is claimed cancelled or expires after the scan', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  f.store.pair(f.sender.id, receiver.peer.id);
  const send = (key: string, ttlSeconds = 3600) => f.store.send(f.sender.id, {
    to: receiver.peer.id, body: key, idempotencyKey: key, ttlSeconds,
  });
  const acknowledged = send('acknowledged');
  const cancelled = send('cancelled');
  const expired = send('expired', 1);
  assert.deepEqual(ids(f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken)), ids([acknowledged, cancelled, expired]));
  f.open().claim(receiver.peer.id, acknowledged.id);
  f.store.cancel(f.sender.id, cancelled.id);
  f.advance(1000);
  for (const message of [acknowledged, cancelled, expired]) {
    assert.equal(f.store.markNotified(receiver.peer.id, receiver.ownerToken, message.id), false);
    assert.equal(f.store.message(f.sender.id, message.id).delivery, 'stored');
  }
});

test('notification backlog limits allow every eligible message to drain exactly once', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: NATIVE_ID, label: 'Reviewer' });
  f.store.pair(f.sender.id, receiver.peer.id);
  const messages = Array.from({ length: 25 }, (_, index) => f.store.send(f.sender.id, {
    to: receiver.peer.id, body: `Request ${index}`, idempotencyKey: `request-${index}`,
  }));
  const first = f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken);
  assert.equal(first.length, 20);
  assert.equal(f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken, 3).length, 3);
  const seen: Message[] = [];
  for (;;) {
    const batch = f.store.pendingNotifications(receiver.peer.id, receiver.ownerToken, 7);
    if (batch.length === 0) break;
    assert.ok(seen.length + batch.length <= messages.length);
    for (const message of batch) {
      assert.equal(f.store.markNotified(receiver.peer.id, receiver.ownerToken, message.id), true);
      seen.push(message);
    }
  }
  assert.deepEqual(ids(seen), ids(messages));
});
