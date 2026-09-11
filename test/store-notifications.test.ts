import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/store.js';
import type { Claim, InboxNotification, Message } from '../src/types.js';

const SENDER_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const RECIPIENT_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const CLAUDE_ID = 'cccccccc-1111-4222-8333-444444444444';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'session-bridge-notification-store-'));
  let time = 1_000_000;
  const stores = new Set<Store>();
  const open = () => {
    const store = new Store(home, () => time);
    stores.add(store);
    return store;
  };
  const close = (store: Store) => {
    store.close();
    stores.delete(store);
  };
  const store = open();
  const sender = store.ensureCodexPeer({ nativeSessionId: SENDER_ID, label: 'Sender' });
  const recipient = store.ensureCodexPeer({ nativeSessionId: RECIPIENT_ID, label: 'Recipient' });
  const pairing = store.pair(sender.id, recipient.id);
  const send = (key: string, ttlSeconds = 3600, kind: 'request' | 'notice' = 'request') =>
    store.send(sender.id, { to: recipient.id, body: key, idempotencyKey: key, ttlSeconds, kind });
  t.after(() => {
    for (const database of stores) database.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, store, open, close, sender, recipient, pairing, send,
    now: () => time, advance: (ms: number) => { time += ms; } };
}

function ids(messages: ReadonlyArray<Pick<Message, 'id'>>): string[] {
  return messages.map(({ id }) => id).sort();
}

function receiptIds(claims: Claim[]): Array<{ messageId: string; claimId: string }> {
  return claims.map(({ message, claimId }) => ({ messageId: message.id, claimId }));
}

function reserved(store: Store, to: string): InboxNotification {
  const notification = store.reserveNotification(to);
  assert.ok(notification);
  return notification;
}

test('two connections coalesce every arrival into one notification and begin delivery only once', (t) => {
  const f = fixture(t);
  const other = f.open();
  assert.equal(f.store.reserveNotification(f.recipient.id), null);
  const notificationIds = new Set<string>();
  for (let index = 0; index < 25; index++) {
    const writer = index % 2 === 0 ? f.store : other;
    writer.send(f.sender.id, { to: f.recipient.id, body: `Request ${index}`, idempotencyKey: `request-${index}` });
    notificationIds.add(reserved(writer, f.recipient.id).id);
    notificationIds.add(reserved(writer === f.store ? other : f.store, f.recipient.id).id);
  }
  assert.equal(notificationIds.size, 1);
  const notification = reserved(other, f.recipient.id);
  assert.equal(notification.state, 'pending');
  assert.equal(notification.consumedAt, null);
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 25);
  assert.equal(f.store.beginNotificationDelivery(notification.id), true);
  assert.equal(other.beginNotificationDelivery(notification.id), false);
  assert.equal(other.notificationStatus(f.recipient.id).notification?.state, 'submitting');
  f.store.finishNotificationDelivery(notification.id, { state: 'submitted', detail: 'Queued', nativeQueueId: 'synthetic-queue' });
  assert.equal(other.notificationStatus(f.recipient.id).notification?.nativeQueueId, 'synthetic-queue');
  assert.equal(other.beginNotificationDelivery(notification.id), false);
});

test('a stored request survives restart before reservation and an idempotent retry wakes it exactly once', (t) => {
  const f = fixture(t);
  const request = f.send('request');
  assert.equal(f.store.notificationStatus(f.recipient.id).notification, null);
  f.close(f.store);
  const reopened = f.open();
  const retry = reopened.send(f.sender.id, { to: f.recipient.id, body: 'request', idempotencyKey: 'request' });
  assert.equal(retry.id, request.id);
  const notification = reserved(reopened, f.recipient.id);
  const read = reopened.consumeNotification(f.recipient.id, notification.id);
  assert.equal(read.consumed, true);
  assert.deepEqual(ids(read.claims.map(({ message }) => message)), [request.id]);
  assert.equal(read.claims[0]!.alreadyClaimed, false);
  assert.equal(read.notification, null);
  assert.equal(reopened.reserveNotification(f.recipient.id), null);
});

test('ordinary incoming reads and targeted receipts retain the outstanding token even with no unread messages', (t) => {
  const f = fixture(t);
  const messages = [f.send('first'), f.send('second'), f.send('notice', 3600, 'notice')];
  const notification = reserved(f.store, f.recipient.id);
  assert.deepEqual(ids(f.open().incoming(f.recipient.id, { unreadOnly: true })), ids(messages));
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 3);
  assert.equal(f.store.notificationStatus(f.recipient.id).pendingRequestCount, 2);
  for (const message of messages) f.open().claim(f.recipient.id, message.id);
  assert.deepEqual(f.store.incoming(f.recipient.id, { unreadOnly: true }), []);
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 0);
  assert.equal(f.store.notificationStatus(f.recipient.id).pendingRequestCount, 2);
  assert.deepEqual(f.store.notificationStatus(f.recipient.id).notification, notification);
  assert.equal(reserved(f.store, f.recipient.id).id, notification.id);
  const read = f.store.consumeNotification(f.recipient.id, notification.id);
  assert.equal(read.consumed, true);
  assert.deepEqual(read.claims, []);
  assert.equal(read.remaining, false);
  assert.equal(read.notification, null);
  assert.equal(f.store.notificationStatus(f.recipient.id).notification, null);
});

test('bounded notification consumption records one durable receipt batch and one successor across connections', (t) => {
  const f = fixture(t);
  const messages = Array.from({ length: 25 }, (_, index) => f.send(`request-${index}`));
  const notification = reserved(f.store, f.recipient.id);
  const first = f.store.consumeNotification(f.recipient.id, notification.id);
  assert.equal(first.consumed, true);
  assert.equal(first.claims.length, 20);
  assert.ok(first.claims.every((claim) => !claim.alreadyClaimed));
  assert.equal(first.remaining, true);
  assert.ok(first.notification);
  assert.notEqual(first.notification.id, notification.id);
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 5);

  const other = f.open();
  const competing = other.consumeNotification(f.recipient.id, notification.id, 1);
  assert.equal(competing.consumed, false);
  assert.deepEqual(receiptIds(competing.claims), receiptIds(first.claims));
  assert.ok(competing.claims.every((claim) => claim.alreadyClaimed));
  assert.equal(competing.notification?.id, first.notification.id);
  assert.equal(reserved(other, f.recipient.id).id, first.notification.id);

  f.close(f.store);
  const reopened = f.open();
  const replay = reopened.consumeNotification(f.recipient.id, notification.id, 100);
  assert.equal(replay.consumed, false);
  assert.deepEqual(receiptIds(replay.claims), receiptIds(first.claims));
  assert.ok(replay.claims.every((claim) => claim.alreadyClaimed));
  const last = reopened.consumeNotification(f.recipient.id, first.notification.id);
  assert.equal(last.consumed, true);
  assert.equal(last.claims.length, 5);
  assert.deepEqual(ids([...first.claims, ...last.claims].map(({ message }) => message)), ids(messages));
  assert.equal(last.remaining, false);
  assert.equal(last.notification, null);
  assert.equal(reopened.notificationStatus(f.recipient.id).notification, null);
  reopened.cancel(f.sender.id, first.claims[0]!.message.id);
  f.advance(3_600_000);
  reopened.disconnect(f.sender.id, f.pairing.id);
  f.close(reopened);
  const historical = f.open().consumeNotification(f.recipient.id, notification.id);
  assert.equal(historical.consumed, false);
  assert.deepEqual(receiptIds(historical.claims), receiptIds(first.claims));
  assert.ok(historical.claims.every((claim) => claim.alreadyClaimed));
  assert.equal(historical.notification, null);
});

test('arrivals around consumption cannot let an old token retire or redispatch its successor', (t) => {
  const f = fixture(t);
  const other = f.open();
  const firstMessage = f.send('before-notification');
  const notification = reserved(f.store, f.recipient.id);
  assert.equal(f.store.beginNotificationDelivery(notification.id), true);
  const secondMessage = f.send('before-consumption');
  const first = other.consumeNotification(f.recipient.id, notification.id, 1);
  assert.equal(first.claims.length, 1);
  assert.ok(first.notification);
  const successor = first.notification;
  const thirdMessage = f.send('after-consumption');
  assert.equal(reserved(f.store, f.recipient.id).id, successor.id);
  f.store.finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Late failed delivery' });
  assert.equal(f.store.beginNotificationDelivery(notification.id), false);
  const replay = f.store.consumeNotification(f.recipient.id, notification.id, 100);
  assert.equal(replay.consumed, false);
  assert.deepEqual(receiptIds(replay.claims), receiptIds(first.claims));
  assert.equal(replay.notification?.id, successor.id);
  assert.equal(other.notificationStatus(f.recipient.id).unreadCount, 2);

  const second = other.consumeNotification(f.recipient.id, successor.id, 1);
  assert.ok(second.notification);
  assert.notEqual(second.notification.id, successor.id);
  const obsolete = f.store.consumeNotification(f.recipient.id, notification.id);
  assert.equal(obsolete.notification, null);
  assert.equal(f.store.notificationStatus(f.recipient.id).notification?.id, second.notification.id);
  const last = f.store.consumeNotification(f.recipient.id, second.notification.id);
  assert.deepEqual(ids([...first.claims, ...second.claims, ...last.claims].map(({ message }) => message)),
    ids([firstMessage, secondMessage, thirdMessage]));
  assert.equal(last.notification, null);
});

test('only a proven delivery failure permits a pending token to be submitted again', (t) => {
  const f = fixture(t);
  f.send('request');
  const notification = reserved(f.store, f.recipient.id);
  f.store.finishNotificationDelivery(notification.id, { state: 'submitted', detail: 'No attempt began' });
  assert.equal(f.store.notificationStatus(f.recipient.id).notification?.state, 'pending');
  assert.equal(f.store.beginNotificationDelivery(notification.id), true);
  f.open().finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Rejected before queueing' });
  const retry = reserved(f.store, f.recipient.id);
  assert.equal(retry.id, notification.id);
  assert.equal(retry.state, 'pending');
  assert.equal(f.store.beginNotificationDelivery(notification.id), true);
  f.store.finishNotificationDelivery(notification.id, { state: 'unknown', detail: 'Submission outcome unavailable' });
  const uncertain = f.store.notificationStatus(f.recipient.id).notification;
  assert.equal(uncertain?.state, 'unknown');
  f.open().finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Late failure' });
  assert.deepEqual(f.store.notificationStatus(f.recipient.id).notification, uncertain);
  assert.equal(f.store.beginNotificationDelivery(notification.id), false);
});

test('outstanding notifications survive message expiry cancellation disconnection and store restart', async (t) => {
  for (const state of ['pending', 'submitting', 'submitted', 'unknown'] as const) {
    await t.test(state, (t) => {
      const f = fixture(t);
      const request = f.send('request', 1);
      const notification = reserved(f.store, f.recipient.id);
      if (state !== 'pending') assert.equal(f.store.beginNotificationDelivery(notification.id), true);
      if (state === 'submitted' || state === 'unknown') {
        f.store.finishNotificationDelivery(notification.id, { state, detail: `Synthetic ${state}` });
      }
      const outstanding = f.store.notificationStatus(f.recipient.id).notification;
      assert.equal(outstanding?.state, state);
      f.advance(1000);
      assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 0);
      assert.deepEqual(f.store.notificationStatus(f.recipient.id).notification, outstanding);
      f.store.cancel(f.sender.id, request.id);
      assert.deepEqual(f.store.notificationStatus(f.recipient.id).notification, outstanding);
      f.store.disconnect(f.sender.id, f.pairing.id);
      assert.deepEqual(f.store.notificationStatus(f.recipient.id).notification, outstanding);
      f.close(f.store);
      const reopened = f.open();
      assert.deepEqual(reopened.notificationStatus(f.recipient.id).notification, outstanding);
      if (state !== 'pending') assert.equal(reopened.beginNotificationDelivery(notification.id), false);
      const read = reopened.consumeNotification(f.recipient.id, notification.id);
      assert.equal(read.consumed, true);
      assert.deepEqual(read.claims, []);
      assert.equal(read.notification, null);
    });
  }
});

test('legacy submitted uncertain and interrupted deliveries alone never create a fresh wakeup but remain readable', (t) => {
  const f = fixture(t);
  const legacy = ['submitted', 'unknown', 'dispatching'].map((state) => {
    const message = f.send(state);
    assert.equal(f.store.beginDelivery(message.id), true);
    if (state === 'submitted' || state === 'unknown') {
      f.store.finishDelivery(message.id, { state, detail: `Legacy ${state}` });
    }
    return f.store.message(f.sender.id, message.id);
  });
  assert.equal(f.store.reserveNotification(f.recipient.id), null);
  assert.deepEqual(ids(f.store.incoming(f.recipient.id, { unreadOnly: true })), ids(legacy));
  f.close(f.store);
  const reopened = f.open();
  assert.equal(reopened.reserveNotification(f.recipient.id), null);
  for (const message of legacy) assert.deepEqual(reopened.message(f.recipient.id, message.id), message);
  const fresh = reopened.send(f.sender.id, { to: f.recipient.id, body: 'Fresh request', idempotencyKey: 'fresh' });
  const notification = reserved(reopened, f.recipient.id);
  reopened.claim(f.recipient.id, fresh.id);
  const first = reopened.consumeNotification(f.recipient.id, notification.id, 1);
  assert.ok(first.notification);
  const remainder = reopened.consumeNotification(f.recipient.id, first.notification.id);
  assert.deepEqual(ids([...first.claims, ...remainder.claims].map(({ message }) => message)), ids(legacy));
  assert.equal(remainder.notification, null);
  for (const message of legacy) assert.equal(reopened.message(f.recipient.id, message.id).delivery, message.delivery);
});

test('schema three migration preserves receiver ownership receipts and uncertain delivery without inventing a wakeup', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: CLAUDE_ID, label: 'Receiver' });
  const pairing = f.store.pair(f.sender.id, receiver.peer.id);
  const send = (key: string) => f.store.send(f.sender.id, {
    to: receiver.peer.id, body: key, idempotencyKey: key,
  });
  const read = send('previously-read');
  const receipt = f.store.claim(receiver.peer.id, read.id);
  const uncertain = send('legacy-uncertain');
  assert.equal(f.store.beginDelivery(uncertain.id), true);
  f.store.finishDelivery(uncertain.id, { state: 'unknown', detail: 'Legacy submission outcome unavailable' });
  const evidence = f.store.message(receiver.peer.id, uncertain.id);
  const status = f.store.receiverStatus(receiver.peer.id);
  f.close(f.store);
  const legacy = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    legacy.exec('DROP TABLE notification_receipts; DROP TABLE inbox_notifications; PRAGMA user_version=3;');
  } finally {
    legacy.close();
  }

  const reopened = f.open();
  const migrated = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, 5);
  } finally {
    migrated.close();
  }
  assert.deepEqual(reopened.peer(receiver.peer.id), receiver.peer);
  assert.deepEqual(reopened.receiverStatus(receiver.peer.id), status);
  assert.equal(reopened.renewReceiver(receiver.peer.id, receiver.ownerToken), true);
  assert.deepEqual(reopened.pairings(receiver.peer.id), [pairing]);
  assert.deepEqual(reopened.message(receiver.peer.id, read.id), receipt.message);
  assert.deepEqual(reopened.message(receiver.peer.id, uncertain.id), evidence);
  assert.equal(reopened.reserveNotification(receiver.peer.id), null);
  const fresh = reopened.send(f.sender.id, { to: receiver.peer.id, body: 'New request', idempotencyKey: 'new-request' });
  const notification = reserved(reopened, receiver.peer.id);
  assert.equal(reopened.beginNotificationDelivery(notification.id, receiver.ownerToken), true);
  const batch = reopened.consumeNotification(receiver.peer.id, notification.id);
  assert.deepEqual(ids(batch.claims.map(({ message }) => message)), ids([uncertain, fresh]));
  assert.equal(batch.notification, null);
  assert.equal(reopened.message(receiver.peer.id, read.id).claimId, receipt.claimId);
});

test('consumption and unread status exclude receipts expired cancelled and disconnected messages without losing pending requests', (t) => {
  const f = fixture(t);
  const acknowledged = f.send('acknowledged');
  const cancelled = f.send('cancelled');
  f.send('expired', 1);
  const notification = reserved(f.store, f.recipient.id);
  f.store.claim(f.recipient.id, acknowledged.id);
  f.store.cancel(f.sender.id, cancelled.id);
  const disconnectedSender = f.store.createPeer({ host: 'claude', label: 'Disconnected sender' }).peer;
  const disconnectedPairing = f.store.pair(disconnectedSender.id, f.recipient.id);
  f.store.send(disconnectedSender.id, { to: f.recipient.id, body: 'Disconnected', idempotencyKey: 'disconnected' });
  f.store.disconnect(disconnectedSender.id, disconnectedPairing.id);
  const closedSender = f.store.createPeer({ host: 'claude', label: 'Closed sender' }).peer;
  f.store.pair(closedSender.id, f.recipient.id);
  f.store.send(closedSender.id, { to: f.recipient.id, body: 'Closed sender', idempotencyKey: 'closed' });
  f.store.closePeer(closedSender.id);
  f.advance(1000);
  const outgoing = f.store.send(f.recipient.id, { to: f.sender.id, body: 'Question', idempotencyKey: 'outgoing' });
  const outgoingReceipt = f.store.claim(f.sender.id, outgoing.id);
  const reply = f.store.reply(f.sender.id, outgoing.id, outgoingReceipt.claimId, 'Answer');
  const unread = [f.send('eligible-request'), f.send('eligible-notice', 3600, 'notice'), reply];
  assert.deepEqual(ids(f.store.incoming(f.recipient.id, { unreadOnly: true })), ids(unread));
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 3);
  assert.equal(f.store.notificationStatus(f.recipient.id).pendingRequestCount, 2);
  const read = f.store.consumeNotification(f.recipient.id, notification.id);
  assert.deepEqual(ids(read.claims.map(({ message }) => message)), ids(unread));
  assert.equal(read.notification, null);
  assert.equal(f.store.notificationStatus(f.recipient.id).unreadCount, 0);
  assert.equal(f.store.notificationStatus(f.recipient.id).pendingRequestCount, 2);
  const receipt = f.store.claim(f.recipient.id, acknowledged.id);
  f.store.reply(f.recipient.id, acknowledged.id, receipt.claimId, 'Complete');
  assert.equal(f.store.notificationStatus(f.recipient.id).pendingRequestCount, 1);
});

test('historical native aliases share a token while the same UUID on another host has its own token', (t) => {
  const f = fixture(t);
  f.send('before-reconnect');
  const original = reserved(f.store, f.recipient.id);
  f.store.closePeer(f.recipient.id);
  const database = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    database.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,attached_at)
      VALUES('synthetic-recipient-alias','codex','Reconnected recipient',?,?,?)`)
      .run(RECIPIENT_ID.toUpperCase(), f.now() + 1, f.now() + 1);
  } finally {
    database.close();
  }
  const alias = f.open().ensureCodexPeer({ nativeSessionId: RECIPIENT_ID });
  assert.notEqual(alias.id, f.recipient.id);
  assert.equal(f.store.sameSession(alias.id, f.recipient.id), true);
  f.store.pair(f.sender.id, alias.id);
  const fresh = f.store.send(f.sender.id, { to: alias.id, body: 'After reconnect', idempotencyKey: 'after-reconnect' });
  assert.equal(reserved(f.store, alias.id).id, original.id);
  const otherHost = f.store.createPeer({ host: 'claude', nativeSessionId: RECIPIENT_ID, label: 'Other host' }).peer;
  f.store.pair(f.sender.id, otherHost.id);
  const otherMessage = f.store.send(f.sender.id, { to: otherHost.id, body: 'Other host', idempotencyKey: 'other-host' });
  const otherNotification = reserved(f.store, otherHost.id);
  assert.notEqual(otherNotification.id, original.id);
  assert.throws(() => f.store.consumeNotification(otherHost.id, original.id));
  assert.equal(f.store.message(f.sender.id, fresh.id).acknowledgedAt, null);
  const read = f.store.consumeNotification(alias.id, original.id);
  assert.deepEqual(ids(read.claims.map(({ message }) => message)), [fresh.id]);
  assert.equal(f.store.notificationStatus(alias.id).notification, null);
  assert.equal(f.store.notificationStatus(otherHost.id).notification?.id, otherNotification.id);
  assert.equal(f.store.message(otherHost.id, otherMessage.id).acknowledgedAt, null);
});

test('duplicate active native identities reject notification operations without recording receipts', (t) => {
  const f = fixture(t);
  const request = f.send('request');
  const notification = reserved(f.store, f.recipient.id);
  const database = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    database.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at)
      VALUES('synthetic-active-duplicate','codex','Duplicate recipient',?,?)`)
      .run(RECIPIENT_ID.toUpperCase(), f.now());
    assert.throws(() => f.store.reserveNotification(f.recipient.id), /ambiguous/i);
    assert.throws(() => f.store.notificationStatus(f.recipient.id), /ambiguous/i);
    assert.throws(() => f.store.beginNotificationDelivery(notification.id), /ambiguous/i);
    assert.throws(() => f.store.consumeNotification(f.recipient.id, notification.id), /ambiguous/i);
    assert.equal(f.store.message(f.sender.id, request.id).acknowledgedAt, null);
    const unchanged = database.prepare('SELECT state,consumed_at FROM inbox_notifications WHERE id=?').get(notification.id)!;
    assert.equal(unchanged.state, 'pending');
    assert.equal(unchanged.consumed_at, null);
  } finally {
    database.close();
  }
});

test('invalid consumption cannot receipt messages or retire another recipient notification', (t) => {
  const f = fixture(t);
  const request = f.send('request');
  const notification = reserved(f.store, f.recipient.id);
  assert.throws(() => f.open().consumeNotification(f.sender.id, notification.id));
  for (const limit of [0, -1, 1.5, 101]) {
    assert.throws(() => f.store.consumeNotification(f.recipient.id, notification.id, limit));
  }
  assert.equal(f.store.message(f.sender.id, request.id).acknowledgedAt, null);
  assert.deepEqual(f.store.notificationStatus(f.recipient.id).notification, notification);
  assert.equal(f.store.consumeNotification(f.recipient.id, notification.id, 1).consumed, true);
});

test('Claude delivery requires its current live owner and accepts proven failure only from that attempt owner', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: CLAUDE_ID, label: 'Receiver' });
  f.store.pair(f.sender.id, receiver.peer.id);
  f.store.send(f.sender.id, { to: receiver.peer.id, body: 'Request', idempotencyKey: 'claude-request' });
  const notification = reserved(f.store, receiver.peer.id);
  assert.equal(f.store.beginNotificationDelivery(notification.id), false);
  assert.equal(f.store.beginNotificationDelivery(notification.id, 'wrong-owner'), false);
  assert.equal(f.store.beginNotificationDelivery(notification.id, receiver.ownerToken), true);
  f.open().finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Unowned completion' });
  assert.equal(f.store.notificationStatus(receiver.peer.id).notification?.state, 'submitting');
  f.store.finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Rejected before dispatch' }, receiver.ownerToken);
  assert.equal(f.store.notificationStatus(receiver.peer.id).notification?.state, 'pending');
  assert.equal(f.store.beginNotificationDelivery(notification.id, receiver.ownerToken), true);
  f.open().finishNotificationDelivery(notification.id, { state: 'submitted', detail: 'Queued' }, receiver.ownerToken);
  assert.equal(f.store.notificationStatus(receiver.peer.id).notification?.state, 'submitted');
  assert.equal(f.store.beginNotificationDelivery(notification.id, receiver.ownerToken), false);
});

test('a replacement Claude receiver cannot finish or replay a submission begun by an expired owner', (t) => {
  const f = fixture(t);
  const old = f.store.acquireReceiver({ nativeSessionId: CLAUDE_ID, label: 'Receiver' });
  f.store.pair(f.sender.id, old.peer.id);
  f.store.send(f.sender.id, { to: old.peer.id, body: 'Request', idempotencyKey: 'claude-request' });
  const notification = reserved(f.store, old.peer.id);
  assert.equal(f.store.beginNotificationDelivery(notification.id, old.ownerToken), true);
  const submitting = f.store.notificationStatus(old.peer.id).notification;
  f.advance(5000);
  f.store.finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Expired owner' }, old.ownerToken);
  assert.deepEqual(f.store.notificationStatus(old.peer.id).notification, submitting);
  const other = f.open();
  const current = other.acquireReceiver({ nativeSessionId: CLAUDE_ID, label: 'Receiver' });
  assert.notEqual(current.ownerToken, old.ownerToken);
  f.store.finishNotificationDelivery(notification.id, { state: 'submitted', detail: 'Stale owner' }, old.ownerToken);
  other.finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Different generation' }, current.ownerToken);
  assert.deepEqual(other.notificationStatus(current.peer.id).notification, submitting);
  assert.equal(other.beginNotificationDelivery(notification.id, current.ownerToken), false);
  assert.equal(reserved(other, current.peer.id).id, notification.id);
  f.close(f.store);
  assert.deepEqual(f.open().notificationStatus(current.peer.id).notification, submitting);
});

test('a replacement Claude receiver may begin an untouched pending token but stale owners remain fenced', (t) => {
  const f = fixture(t);
  const old = f.store.acquireReceiver({ nativeSessionId: CLAUDE_ID, label: 'Receiver' });
  f.store.pair(f.sender.id, old.peer.id);
  f.store.send(f.sender.id, { to: old.peer.id, body: 'Request', idempotencyKey: 'claude-request' });
  const notification = reserved(f.store, old.peer.id);
  f.advance(5000);
  const other = f.open();
  const current = other.acquireReceiver({ nativeSessionId: CLAUDE_ID, label: 'Receiver' });
  assert.equal(f.store.beginNotificationDelivery(notification.id, old.ownerToken), false);
  assert.equal(other.beginNotificationDelivery(notification.id, current.ownerToken), true);
  f.store.finishNotificationDelivery(notification.id, { state: 'submitted', detail: 'Old completion' }, old.ownerToken);
  assert.equal(other.notificationStatus(current.peer.id).notification?.state, 'submitting');
  other.finishNotificationDelivery(notification.id, { state: 'submitted', detail: 'Current completion' }, current.ownerToken);
  assert.equal(other.notificationStatus(current.peer.id).notification?.state, 'submitted');
});
