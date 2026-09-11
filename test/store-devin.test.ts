import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { canonicalSessionId, isHost } from '../src/providers.js';
import { Store } from '../src/store.js';
import type { Message } from '../src/types.js';

const SENDER_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const SHARED_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const CLAUDE_ID = 'cccccccc-1111-4222-8333-444444444444';
const TICKET_ID = 'dddddddd-1111-4222-8333-444444444444';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'session-bridge-devin-store-'));
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
  t.after(() => {
    for (const database of stores) database.close();
    rmSync(home, { recursive: true, force: true });
  });
  return { home, store, sender, open, close, now: () => time, advance: (ms: number) => { time += ms; } };
}

function ids(messages: ReadonlyArray<Pick<Message, 'id'>>): string[] {
  return messages.map(({ id }) => id).sort();
}

function snapshot(database: DatabaseSync) {
  return {
    peers: database.prepare('SELECT * FROM peers ORDER BY id').all(),
    pairings: database.prepare('SELECT * FROM pairings ORDER BY id').all(),
    messages: database.prepare('SELECT * FROM messages ORDER BY id').all(),
    notifications: database.prepare('SELECT * FROM inbox_notifications ORDER BY id').all(),
    receipts: database.prepare('SELECT * FROM notification_receipts ORDER BY notification_id,ordinal').all(),
  };
}

function rebuildSchemaFour(database: DatabaseSync): void {
  database.exec(`PRAGMA foreign_keys=OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE peers_schema4 (
      id TEXT PRIMARY KEY, host TEXT NOT NULL CHECK (host IN ('codex','claude')),
      label TEXT NOT NULL, native_session_id TEXT, endpoint TEXT,
      created_at INTEGER NOT NULL, closed_at INTEGER, ticket_hash TEXT UNIQUE, attached_at INTEGER,
      status_text TEXT, status_updated_at INTEGER, receiver_owner TEXT, receiver_checked_at INTEGER,
      receiver_expires_at INTEGER
    );
    INSERT INTO peers_schema4 SELECT id,host,label,native_session_id,endpoint,created_at,closed_at,ticket_hash,
      attached_at,status_text,status_updated_at,receiver_owner,receiver_checked_at,receiver_expires_at FROM peers;
    DROP TABLE peers;
    ALTER TABLE peers_schema4 RENAME TO peers;
    CREATE INDEX peer_native_identity ON peers(native_session_id COLLATE NOCASE,host) WHERE closed_at IS NULL;
    CREATE INDEX peer_identity_history ON peers(host,native_session_id COLLATE NOCASE);
    PRAGMA user_version=4;
    COMMIT;
    PRAGMA foreign_keys=ON;`);
}

test('provider validation preserves opaque Devin IDs while canonicalizing only UUID providers', () => {
  for (const host of ['codex', 'claude', 'devin']) assert.equal(isHost(host), true);
  for (const host of ['Devin', 'devin ', '', 'unknown', undefined, null, 1, {}, ['devin']]) {
    assert.equal(isHost(host), false);
  }
  assert.equal(canonicalSessionId('codex', SHARED_ID.toUpperCase()), SHARED_ID);
  assert.equal(canonicalSessionId('claude', SHARED_ID.toUpperCase()), SHARED_ID);
  for (const id of ['Alpha', 'alpha', 'Alpha_09-x', '0', 'A'.repeat(128), SHARED_ID.toUpperCase()]) {
    assert.equal(canonicalSessionId('devin', id), id);
  }
  for (const id of ['', '-Alpha', '_Alpha', ' Alpha', 'Alpha ', 'a/b', 'a.b', 'a:b', 'a\nb', 'a\0b', 'é', 'A'.repeat(129),
    undefined, null, true, 123, {}, ['Alpha']]) {
    assert.throws(() => canonicalSessionId('devin', id));
  }
  for (const host of ['codex', 'claude'] as const) {
    assert.throws(() => canonicalSessionId(host, 'Alpha'));
    assert.throws(() => canonicalSessionId(host, null));
  }
});

test('explicit Devin attachment reuses its exact identity across closure while the Codex wrapper stays compatible', (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'Uninvited', attach: false }));
  assert.equal(f.store.findNativePeer('Uninvited', 'devin'), null);
  assert.throws(() => f.store.createPeer({ host: 'devin', label: 'Missing identity' }));
  assert.throws(() => f.store.createPeer({ host: 'devin', nativeSessionId: '--resume', label: 'Invalid identity' }));
  const registered = f.store.createPeer({ host: 'devin', nativeSessionId: 'Alpha_09', label: 'Registered Devin' });
  assert.equal(registered.peer.nativeSessionId, 'Alpha_09');
  assert.equal(registered.peer.attachedAt, null);
  f.advance(1000);
  const attached = f.open().ensureNativePeer({ host: 'devin', nativeSessionId: 'Alpha_09', label: 'Caller' });
  assert.equal(attached.id, registered.peer.id);
  assert.equal(attached.host, 'devin');
  assert.equal(attached.attachedAt, f.now());
  assert.throws(() => f.store.attach(registered.ticket), /already used/);
  assert.deepEqual(f.store.receiverStatus(attached.id), { state: 'unknown', checkedAt: null, expiresAt: null });
  const pairing = f.store.pair(f.sender.id, attached.id);
  assert.equal(f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'Alpha_09' }).id, attached.id);
  assert.deepEqual(f.store.pairings(attached.id), [pairing]);
  assert.throws(() => f.store.createPeer({ host: 'devin', nativeSessionId: 'Alpha_09', label: 'Duplicate' }), /active peer/);
  f.store.closePeer(attached.id);
  f.advance(1000);
  const reopened = f.open().ensureNativePeer({ host: 'devin', nativeSessionId: 'Alpha_09' });
  assert.equal(reopened.id, attached.id);
  assert.equal(reopened.nativeSessionId, 'Alpha_09');
  assert.equal(reopened.closedAt, null);
  assert.deepEqual(f.store.connectedPeers(reopened.id), []);
  const codex = f.store.ensureNativePeer({ host: 'codex', nativeSessionId: SENDER_ID.toUpperCase() });
  assert.equal(codex.id, f.sender.id);
  assert.equal(f.store.ensureCodexPeer({ nativeSessionId: SENDER_ID.toUpperCase() }).id, codex.id);
});

test('Devin case variants keep messaging history receipts and sender idempotency isolated', (t) => {
  const f = fixture(t);
  const upper = f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'Alpha' });
  const lower = f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'alpha' });
  assert.notEqual(upper.id, lower.id);
  assert.equal(f.store.sameSession(upper.id, lower.id), false);
  assert.equal(f.store.findNativePeer('Alpha', 'devin')?.id, upper.id);
  assert.equal(f.store.findNativePeer('alpha', 'devin')?.id, lower.id);
  assert.equal(f.store.findNativePeer('ALPHA', 'devin'), null);
  f.store.pair(f.sender.id, upper.id);
  f.store.pair(f.sender.id, lower.id);
  const input = { to: f.sender.id, body: 'Review this', idempotencyKey: 'same-key' };
  const upperRequest = f.store.send(upper.id, input);
  const lowerRequest = f.store.send(lower.id, input);
  assert.notEqual(upperRequest.id, lowerRequest.id);
  assert.equal(f.store.send(upper.id, input).id, upperRequest.id);
  assert.equal(f.store.send(lower.id, input).id, lowerRequest.id);
  const receipt = f.store.claim(f.sender.id, upperRequest.id);
  const reply = f.store.reply(f.sender.id, upperRequest.id, receipt.claimId, 'Uppercase result');
  assert.deepEqual(ids(f.store.history(upper.id)), ids([upperRequest, reply]));
  assert.deepEqual(ids(f.store.history(lower.id)), [lowerRequest.id]);
  assert.deepEqual(ids(f.store.incoming(upper.id, { unreadOnly: true })), [reply.id]);
  assert.deepEqual(f.store.incoming(lower.id, { unreadOnly: true }), []);
  assert.throws(() => f.store.message(lower.id, upperRequest.id), /participant/);
  assert.throws(() => f.store.claim(lower.id, reply.id), /recipient/);
  assert.equal(f.store.message(f.sender.id, lowerRequest.id).acknowledgedAt, null);
  f.store.closePeer(upper.id);
  assert.equal(f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'Alpha' }).id, upper.id);
  assert.equal(f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'alpha' }).id, lower.id);
});

test('historical Devin aliases share evidence and notification slots only when their native ID case matches', (t) => {
  const f = fixture(t);
  const upper = f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'Alpha' });
  const lower = f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'alpha' });
  f.store.pair(f.sender.id, upper.id);
  f.store.pair(f.sender.id, lower.id);
  const input = { to: f.sender.id, body: 'Original request', idempotencyKey: 'shared-key' };
  const original = f.store.send(upper.id, input);
  const receipt = f.store.claim(f.sender.id, original.id);
  const reply = f.store.reply(f.sender.id, original.id, receipt.claimId, 'Original result');
  const originalToken = f.store.reserveNotification(upper.id);
  assert.ok(originalToken);
  const lowercaseMessage = f.store.send(f.sender.id, { to: lower.id, body: 'Lowercase request', idempotencyKey: 'lowercase' });
  const lowercaseToken = f.store.reserveNotification(lower.id);
  assert.ok(lowercaseToken);
  assert.notEqual(originalToken.id, lowercaseToken.id);
  f.store.closePeer(upper.id);
  const database = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    database.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,attached_at)
      VALUES('synthetic-devin-alias','devin','Reattached Devin','Alpha',?,?)`).run(f.now() + 1, f.now() + 1);
  } finally {
    database.close();
  }
  const alias = f.open().ensureNativePeer({ host: 'devin', nativeSessionId: 'Alpha' });
  assert.notEqual(alias.id, upper.id);
  assert.equal(f.store.sameSession(alias.id, upper.id), true);
  assert.equal(f.store.sameSession(alias.id, lower.id), false);
  assert.deepEqual(ids(f.store.history(alias.id)), ids([original, reply]));
  assert.equal(f.store.message(alias.id, original.id).claimId, receipt.claimId);
  assert.equal(f.store.send(alias.id, input).id, original.id);
  const lowercaseRequest = f.store.send(lower.id, input);
  assert.notEqual(lowercaseRequest.id, original.id);
  f.store.pair(f.sender.id, alias.id);
  const fresh = f.store.send(f.sender.id, { to: alias.id, body: 'After reattachment', idempotencyKey: 'fresh' });
  assert.equal(f.store.reserveNotification(alias.id)?.id, originalToken.id);
  assert.equal(f.store.notificationStatus(lower.id).notification?.id, lowercaseToken.id);
  assert.throws(() => f.store.consumeNotification(lower.id, originalToken.id), /recipient/);
  const read = f.store.consumeNotification(alias.id, originalToken.id);
  assert.deepEqual(ids(read.claims.map(({ message }) => message)), [fresh.id]);
  assert.equal(f.store.notificationStatus(lower.id).notification?.id, lowercaseToken.id);
  assert.equal(f.store.message(lower.id, lowercaseMessage.id).acknowledgedAt, null);
});

test('bare lookup resolves safe Devin IDs exactly and preserves UUID provider ambiguity', (t) => {
  const f = fixture(t);
  const word = f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'Alpha' });
  assert.equal(f.store.findNativePeer('Alpha')?.id, word.id);
  assert.equal(f.store.findNativePeer('alpha'), null);
  assert.equal(f.store.findNativePeer('Unknown_09-x'), null);
  assert.throws(() => f.store.findNativePeer('Alpha', 'codex'), /UUID/);
  assert.throws(() => f.store.findNativePeer('Alpha', 'claude'), /UUID/);
  for (const id of ['../Alpha', '--resume', 'a b', '']) assert.throws(() => f.store.findNativePeer(id));
  const codex = f.store.ensureCodexPeer({ nativeSessionId: SHARED_ID.toUpperCase() });
  assert.equal(f.store.findNativePeer(SHARED_ID.toUpperCase())?.id, codex.id);
  const exact = f.store.ensureNativePeer({ host: 'devin', nativeSessionId: SHARED_ID });
  assert.throws(() => f.store.findNativePeer(SHARED_ID), /ambiguous/);
  assert.equal(f.store.findNativePeer(SHARED_ID.toUpperCase())?.id, codex.id);
  assert.equal(f.store.findNativePeer(SHARED_ID, 'devin')?.id, exact.id);
  assert.equal(f.store.findNativePeer(SHARED_ID.toUpperCase(), 'devin'), null);
  const uppercase = f.store.ensureNativePeer({ host: 'devin', nativeSessionId: SHARED_ID.toUpperCase() });
  assert.notEqual(uppercase.id, exact.id);
  assert.throws(() => f.store.findNativePeer(SHARED_ID.toUpperCase()), /ambiguous/);
  f.store.closePeer(codex.id);
  assert.equal(f.store.findNativePeer(SHARED_ID)?.id, exact.id);
  assert.equal(f.store.findNativePeer(SHARED_ID.toUpperCase())?.id, uppercase.id);
  const claude = f.store.createPeer({ host: 'claude', nativeSessionId: SHARED_ID.toUpperCase(), label: 'Claude' }).peer;
  assert.throws(() => f.store.findNativePeer(SHARED_ID), /ambiguous/);
  assert.throws(() => f.store.findNativePeer(SHARED_ID.toUpperCase()), /ambiguous/);
  assert.equal(f.store.findNativePeer(SHARED_ID.toUpperCase(), 'claude')?.id, claude.id);
});

test('opening and inspecting stored Devin work never attaches its registration or creates a notification', (t) => {
  const f = fixture(t);
  const registered = f.store.createPeer({ host: 'devin', nativeSessionId: 'Quiet_1', label: 'Quiet Devin' });
  f.store.pair(f.sender.id, registered.peer.id);
  const message = f.store.send(f.sender.id, { to: registered.peer.id, body: 'Stored work', idempotencyKey: 'stored-work' });
  assert.equal(f.store.notificationStatus(registered.peer.id).notification, null);
  f.close(f.store);
  const reopened = f.open();
  const before = reopened.peers();
  assert.equal(reopened.findNativePeer('Quiet_1')?.attachedAt, null);
  assert.deepEqual(ids(reopened.incoming(registered.peer.id, { unreadOnly: true })), [message.id]);
  assert.deepEqual(ids(reopened.history(registered.peer.id)), [message.id]);
  assert.deepEqual(reopened.notificationStatus(registered.peer.id), { unreadCount: 1, pendingRequestCount: 1, notification: null });
  assert.deepEqual(reopened.receiverStatus(registered.peer.id), { state: 'unknown', checkedAt: null, expiresAt: null });
  assert.equal(reopened.findNativePeer('Absent'), null);
  assert.deepEqual(reopened.peers(), before);
  assert.equal(reopened.message(registered.peer.id, message.id).acknowledgedAt, null);
  assert.equal(reopened.attach(registered.ticket).id, registered.peer.id);
  assert.equal(reopened.notificationStatus(registered.peer.id).notification, null);
});

test('Devin notification submission uses a single native slot without a receiver lease and never retries uncertainty', (t) => {
  const f = fixture(t);
  const devin = f.store.ensureNativePeer({ host: 'devin', nativeSessionId: 'Notify_1' });
  f.store.pair(f.sender.id, devin.id);
  f.store.send(f.sender.id, { to: devin.id, body: 'Request', idempotencyKey: 'request' });
  const notification = f.store.reserveNotification(devin.id);
  assert.ok(notification);
  const other = f.open();
  assert.equal(other.reserveNotification(devin.id)?.id, notification.id);
  assert.equal(f.store.beginNotificationDelivery(notification.id), true);
  assert.equal(other.beginNotificationDelivery(notification.id), false);
  const database = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    assert.equal(database.prepare('SELECT dispatch_owner FROM inbox_notifications WHERE id=?').get(notification.id)!.dispatch_owner, null);
    const receiver = database.prepare('SELECT receiver_owner,receiver_checked_at,receiver_expires_at FROM peers WHERE id=?').get(devin.id)!;
    assert.deepEqual(Object.values(receiver), [null, null, null]);
  } finally {
    database.close();
  }
  other.finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Rejected before submission' });
  assert.equal(f.store.beginNotificationDelivery(notification.id), true);
  f.store.finishNotificationDelivery(notification.id, { state: 'unknown', detail: 'Native outcome unavailable' });
  const uncertain = f.store.notificationStatus(devin.id).notification;
  f.advance(6000);
  f.close(f.store);
  const reopened = f.open();
  assert.deepEqual(reopened.notificationStatus(devin.id).notification, uncertain);
  assert.deepEqual(reopened.receiverStatus(devin.id), { state: 'unknown', checkedAt: null, expiresAt: null });
  assert.equal(reopened.beginNotificationDelivery(notification.id), false);
  reopened.finishNotificationDelivery(notification.id, { state: 'stored', detail: 'Late failure' });
  assert.deepEqual(reopened.notificationStatus(devin.id).notification, uncertain);
});

test('real schema four migration widens the provider constraint while preserving every existing row and foreign key', (t) => {
  const f = fixture(t);
  const receiver = f.store.acquireReceiver({ nativeSessionId: CLAUDE_ID, label: 'Receiver' });
  f.store.updateStatus(receiver.peer.id, 'Review in progress');
  const pairing = f.store.pair(f.sender.id, receiver.peer.id);
  const messages = Array.from({ length: 3 }, (_, index) => f.store.send(f.sender.id, {
    to: receiver.peer.id, body: `Request ${index}`, idempotencyKey: `request-${index}`,
  }));
  const token = f.store.reserveNotification(receiver.peer.id);
  assert.ok(token);
  assert.equal(f.store.beginNotificationDelivery(token.id, receiver.ownerToken), true);
  f.store.finishNotificationDelivery(token.id, { state: 'submitted', detail: 'Original queued batch', nativeQueueId: 'synthetic-queue' }, receiver.ownerToken);
  const batch = f.store.consumeNotification(receiver.peer.id, token.id, 1);
  assert.ok(batch.notification);
  const first = batch.claims[0]!;
  f.store.reply(receiver.peer.id, first.message.id, first.claimId, 'Original reply', 'reply-key');
  const remaining = messages.filter(({ id }) => id !== first.message.id);
  assert.equal(f.store.markNotified(receiver.peer.id, receiver.ownerToken, remaining[0]!.id), true);
  f.store.cancel(f.sender.id, remaining[1]!.id);
  const endpoint = f.store.createPeer({ host: 'claude', label: 'Legacy endpoint', endpoint: '/private/tmp/synthetic-devin-migration.sock' });
  const ticket = f.store.createPeer({ host: 'codex', nativeSessionId: TICKET_ID, label: 'Unused ticket' });
  const closed = f.store.createPeer({ host: 'claude', label: 'Closed peer' }).peer;
  f.store.pair(f.sender.id, closed.id);
  f.store.send(f.sender.id, { to: closed.id, kind: 'notice', body: 'Historical notice', idempotencyKey: 'closed-notice' });
  f.advance(100);
  f.store.updateStatus(closed.id, 'Finished');
  f.store.closePeer(closed.id);
  const receiverStatus = f.store.receiverStatus(receiver.peer.id);
  f.close(f.store);

  const legacy = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  let before: ReturnType<typeof snapshot>;
  try {
    rebuildSchemaFour(legacy);
    assert.throws(() => legacy.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at)
      VALUES('synthetic-rejected-devin','devin','Unavailable','Unavailable',0)`).run(), /CHECK/);
    assert.deepEqual(legacy.prepare('PRAGMA foreign_key_check').all(), []);
    before = snapshot(legacy);
  } finally {
    legacy.close();
  }

  const reopened = f.open();
  const migrated = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get()!.user_version, 5);
    assert.deepEqual(snapshot(migrated), before);
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(migrated.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally {
    migrated.close();
  }
  assert.deepEqual(reopened.receiverStatus(receiver.peer.id), receiverStatus);
  assert.equal(reopened.renewReceiver(receiver.peer.id, receiver.ownerToken), true);
  assert.deepEqual(reopened.pairings(receiver.peer.id), [pairing]);
  assert.equal(reopened.attach(endpoint.ticket).id, endpoint.peer.id);
  assert.equal(reopened.attach(ticket.ticket).id, ticket.peer.id);
  const replay = reopened.consumeNotification(receiver.peer.id, token.id);
  assert.equal(replay.consumed, false);
  assert.equal(replay.claims[0]!.claimId, first.claimId);
  assert.equal(replay.claims[0]!.alreadyClaimed, true);
  assert.equal(replay.notification?.id, batch.notification.id);
  const devin = reopened.ensureNativePeer({ host: 'devin', nativeSessionId: 'AfterMigration' });
  reopened.pair(f.sender.id, devin.id);
  const fresh = reopened.send(f.sender.id, { to: devin.id, body: 'New provider works', idempotencyKey: 'new-provider' });
  assert.equal(reopened.incoming(devin.id, { unreadOnly: true })[0]!.id, fresh.id);
  assert.ok(reopened.reserveNotification(devin.id));
});

test('a failed schema four migration rolls back the provider constraint and every ledger row', (t) => {
  const f = fixture(t);
  const recipient = f.store.ensureCodexPeer({ nativeSessionId: SHARED_ID });
  f.store.pair(f.sender.id, recipient.id);
  for (let index = 0; index < 2; index++) {
    f.store.send(f.sender.id, { to: recipient.id, body: `Request ${index}`, idempotencyKey: `request-${index}` });
  }
  const notification = f.store.reserveNotification(recipient.id);
  assert.ok(notification);
  const consumed = f.store.consumeNotification(recipient.id, notification.id, 1);
  assert.ok(consumed.notification);
  f.close(f.store);

  const legacy = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  let before: ReturnType<typeof snapshot>;
  let originalSchema: Record<string, unknown>[];
  let violations: Record<string, unknown>[];
  const schemaSql = 'SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name';
  try {
    rebuildSchemaFour(legacy);
    legacy.exec('PRAGMA foreign_keys=OFF');
    legacy.prepare('INSERT INTO pairings(id,a,b,created_at) VALUES(?,?,?,?)')
      .run('synthetic-dangling-pairing', f.sender.id, 'zz-missing-peer', f.now());
    legacy.exec('PRAGMA foreign_keys=ON');
    violations = legacy.prepare('PRAGMA foreign_key_check').all();
    assert.equal(violations.length, 1);
    assert.equal(violations[0]!.table, 'pairings');
    before = snapshot(legacy);
    originalSchema = legacy.prepare(schemaSql).all();
  } finally {
    legacy.close();
  }

  assert.throws(() => f.open(), /foreign key validation/i);
  const unchanged = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  try {
    assert.equal(unchanged.prepare('PRAGMA user_version').get()!.user_version, 4);
    assert.deepEqual(snapshot(unchanged), before);
    assert.deepEqual(unchanged.prepare(schemaSql).all(), originalSchema);
    assert.deepEqual(unchanged.prepare('PRAGMA foreign_key_check').all(), violations);
    assert.equal(unchanged.prepare("SELECT name FROM sqlite_schema WHERE name='peers_upgrade'").get(), undefined);
    assert.throws(() => unchanged.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at)
      VALUES('synthetic-rejected-devin','devin','Unavailable','Unavailable',0)`).run(), /CHECK/);
  } finally {
    unchanged.close();
  }
});
