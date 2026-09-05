import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/store.js';

const NATIVE_ID = '01a07056-03b8-77b1-864a-470e8dcece14';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'session-bridge-store-'));
  let time = 1_000_000;
  const stores: Store[] = [];
  const open = () => {
    const store = new Store(home, () => time);
    stores.push(store);
    return store;
  };
  const store = open();
  const a = store.createPeer({ host: 'codex', label: 'Implementer', nativeSessionId: NATIVE_ID });
  const b = store.createPeer({ host: 'claude', label: 'Reviewer' });
  const c = store.createPeer({ host: 'claude', label: 'Other session' });
  const pair = store.pair(a.peer.id, b.peer.id);
  t.after(() => {
    for (const database of stores) { try { database.close(); } catch { /* already closed by a durability test */ } }
    rmSync(home, { recursive: true, force: true });
  });
  const send = (body = 'Please review src/main.ts', idempotencyKey = 'request-1') =>
    store.send(a.peer.id, { to: b.peer.id, body, idempotencyKey });
  return { home, store, open, a: a.peer, b: b.peer, c: c.peer, ticket: a.ticket, pair, send,
    advance: (ms: number) => { time += ms; } };
}

test('tickets are single use, stored as hashes, and absent from public metadata', (t) => {
  const f = fixture(t);
  assert.equal(f.store.attach(f.ticket).id, f.a.id);
  assert.throws(() => f.open().attach(f.ticket), /Invalid or already used/);
  assert.throws(() => f.store.attach('unrecognized-ticket'), /Invalid or already used/);
  assert.match(f.a.id, /^sb_/);
  assert.equal(JSON.stringify(f.store.peers()).includes(f.ticket), false);
  assert.equal(readFileSync(join(f.home, 'bridge.sqlite')).includes(Buffer.from(f.ticket)), false);
  if (existsSync(join(f.home, 'bridge.sqlite-wal'))) {
    assert.equal(readFileSync(join(f.home, 'bridge.sqlite-wal')).includes(Buffer.from(f.ticket)), false);
  }
});

test('peer registration validates native Codex identity and bounded labels', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.createPeer({ host: 'codex', label: 'x' }), /UUID/);
  assert.throws(() => store.createPeer({ host: 'codex', label: 'x', nativeSessionId: '--resume other' }), /UUID/);
  assert.throws(() => store.createPeer({ host: 'claude', label: '  ' }), /Label/);
  assert.throws(() => store.createPeer({ host: 'claude', label: 'x'.repeat(129) }), /Label/);
  assert.throws(() => store.createPeer({ host: 'claude', label: 'x', endpoint: '\0bad' }), /Endpoint/);
});

test('pairing is symmetric and idempotent and rejects missing or closed peers', (t) => {
  const f = fixture(t);
  const second = f.open();
  assert.deepEqual(second.pair(f.b.id, f.a.id), f.pair);
  assert.equal(f.store.pairings(f.a.id).length, 1);
  assert.throws(() => f.store.pair(f.a.id, f.a.id), /itself/);
  assert.throws(() => f.store.pair(f.a.id, 'missing'), /Unknown peer/);
  f.store.closePeer(f.c.id);
  assert.throws(() => f.store.pair(f.a.id, f.c.id), /closed/);
});

test('send is durable and idempotent across connections and rejects changed input', (t) => {
  const f = fixture(t);
  const first = f.send();
  const second = f.open().send(f.a.id, { to: f.b.id, body: first.body, idempotencyKey: 'request-1' });
  assert.deepEqual(second, first);
  assert.equal(f.store.inbox(f.b.id).length, 1);
  assert.throws(() => f.send('a different request'), /different message input/);
  assert.throws(() => f.store.send(f.a.id, { to: f.b.id, body: first.body, ttlSeconds: 120, idempotencyKey: 'request-1' }), /different message input/);
  const reverse = f.store.send(f.b.id, { to: f.a.id, body: 'Independent request', idempotencyKey: 'request-1' });
  assert.notEqual(reverse.id, first.id);
  f.store.close();
  assert.deepEqual(f.open().message(f.a.id, first.id), first);
});

test('send rejects unpaired peers, malformed payloads, and invalid TTLs', (t) => {
  const f = fixture(t);
  const input = { to: f.b.id, body: 'hello', idempotencyKey: 'key' };
  assert.throws(() => f.store.send(f.a.id, { ...input, to: f.c.id }), /not paired/);
  assert.throws(() => f.store.send(f.a.id, { ...input, body: '' }), /Body/);
  assert.throws(() => f.store.send(f.a.id, { ...input, body: '😀'.repeat(8193) }), /Body/);
  assert.throws(() => f.store.send(f.a.id, { ...input, body: 'before\0after' }), /Body/);
  assert.throws(() => f.store.send(f.a.id, { ...input, idempotencyKey: ' ' }), /Idempotency/);
  for (const ttlSeconds of [0, -1, 86401, 1.5, NaN]) {
    assert.throws(() => f.store.send(f.a.id, { ...input, ttlSeconds }), /TTL/);
  }
  assert.equal(f.store.send(f.a.id, { ...input, body: 'x'.repeat(32768) }).body.length, 32768);
});

test('only message participants can inspect and only recipient can claim', (t) => {
  const f = fixture(t);
  const message = f.send();
  assert.throws(() => f.store.message(f.c.id, message.id), /Not a participant/);
  assert.throws(() => f.store.claim(f.a.id, message.id), /recipient/);
  assert.throws(() => f.store.claim(f.c.id, message.id), /recipient/);
  assert.throws(() => f.store.reply(f.a.id, message.id, 'fake', 'reply'), /recipient/);
  assert.throws(() => f.store.reply(f.b.id, message.id, 'fake', 'reply'), /valid claim/);
  assert.equal(f.store.message(f.b.id, message.id).id, message.id);
});

test('competing claimers get one persisted claim, with no automatic reclaim after expiry', (t) => {
  const f = fixture(t);
  const message = f.send();
  const second = f.open();
  const claim = f.store.claim(f.b.id, message.id, 10);
  assert.equal(claim.alreadyClaimed, false);
  assert.deepEqual(second.claim(f.b.id, message.id, 300), { ...claim, alreadyClaimed: true });
  assert.equal(f.store.inbox(f.b.id).length, 0);
  assert.equal(claim.message.acknowledgedAt, 1_000_000);
  f.advance(10_000);
  assert.throws(() => second.claim(f.b.id, message.id), /automatic re-claim is disabled/);
  assert.throws(() => f.store.reply(f.b.id, message.id, claim.claimId, 'Too late'), /lease expired/);
  assert.equal(f.store.message(f.a.id, message.id).claimId, claim.claimId);
  assert.equal(f.store.message(f.a.id, message.id).answeredBy, null);
});

test('request TTL fences receipt, dispatch, and replies and caps claim lifetime', (t) => {
  const f = fixture(t);
  const message = f.store.send(f.a.id, { to: f.b.id, body: 'brief request', ttlSeconds: 2, idempotencyKey: 'short' });
  const claim = f.store.claim(f.b.id, message.id, 300);
  assert.equal(claim.message.claimExpiresAt, message.expiresAt);
  const untouched = f.store.send(f.a.id, { to: f.b.id, body: 'another', ttlSeconds: 2, idempotencyKey: 'short-2' });
  f.advance(2000);
  assert.equal(f.store.inbox(f.b.id).length, 0);
  assert.equal(f.store.beginDelivery(untouched.id), false);
  assert.throws(() => f.store.claim(f.b.id, untouched.id), /expired/);
  assert.throws(() => f.store.reply(f.b.id, message.id, claim.claimId, 'too late'), /expired/);
});

test('one reply is committed atomically, retries return it, and replies cannot ping-pong', (t) => {
  const f = fixture(t);
  const request = f.send();
  const claim = f.store.claim(f.b.id, request.id);
  const reply = f.store.reply(f.b.id, request.id, claim.claimId, 'Two findings in src/main.ts');
  assert.equal(reply.replyTo, request.id);
  assert.equal(reply.from, f.b.id);
  assert.equal(reply.to, f.a.id);
  assert.equal(f.store.message(f.a.id, request.id).answeredBy, reply.id);
  assert.deepEqual(f.open().reply(f.b.id, request.id, claim.claimId, reply.body), reply);
  assert.throws(() => f.store.reply(f.b.id, request.id, claim.claimId, 'An extra reply'), /different reply/);
  assert.throws(() => f.store.reply(f.b.id, request.id, 'wrong-claim', reply.body), /valid claim/);
  const replyClaim = f.store.claim(f.a.id, reply.id);
  assert.throws(() => f.store.reply(f.a.id, reply.id, replyClaim.claimId, 'thanks'), /Only a request/);
  const notice = f.store.send(f.a.id, { to: f.b.id, kind: 'notice', body: 'FYI', idempotencyKey: 'notice' });
  const noticeClaim = f.store.claim(f.b.id, notice.id);
  assert.throws(() => f.store.reply(f.b.id, notice.id, noticeClaim.claimId, 'thanks'), /Only a request/);
  f.advance(1801_000);
  assert.equal(f.store.reply(f.b.id, request.id, claim.claimId, reply.body).id, reply.id);
});

test('cancellation is sender-only, idempotent, and fences new claims and replies', (t) => {
  const f = fixture(t);
  const message = f.send();
  const claim = f.store.claim(f.b.id, message.id);
  assert.throws(() => f.store.cancel(f.b.id, message.id), /sender/);
  assert.throws(() => f.store.cancel(f.c.id, message.id), /sender/);
  const cancelled = f.store.cancel(f.a.id, message.id);
  f.advance(500);
  assert.equal(f.store.cancel(f.a.id, message.id).cancelledAt, cancelled.cancelledAt);
  assert.throws(() => f.store.reply(f.b.id, message.id, claim.claimId, 'late result'), /cancelled/);
  const pending = f.send('pending', 'pending');
  f.store.cancel(f.a.id, pending.id);
  assert.equal(f.store.beginDelivery(pending.id), false);
  assert.throws(() => f.store.claim(f.b.id, pending.id), /cancelled/);
  assert.equal(f.store.inbox(f.b.id).length, 0);
});

test('disconnect fences pending actions and re-pairing never revives old messages', (t) => {
  const f = fixture(t);
  const request = f.send();
  const claim = f.store.claim(f.b.id, request.id);
  const pending = f.send('not yet delivered', 'pending');
  assert.throws(() => f.store.disconnect(f.c.id, f.pair.id), /participant/);
  f.store.disconnect(f.a.id, f.pair.id);
  f.store.disconnect(f.b.id, f.pair.id);
  assert.equal(f.store.inbox(f.b.id).length, 0);
  assert.equal(f.store.beginDelivery(pending.id), false);
  assert.throws(() => f.store.claim(f.b.id, pending.id), /disconnected/);
  assert.throws(() => f.store.reply(f.b.id, request.id, claim.claimId, 'reply'), /disconnected/);
  assert.throws(() => f.send('new', 'new'), /not paired/);
  const nextPair = f.store.pair(f.a.id, f.b.id);
  assert.notEqual(nextPair.id, f.pair.id);
  assert.equal(f.store.inbox(f.b.id).length, 0);
  assert.throws(() => f.send(), /disconnected/);
  assert.equal(f.send('new after reconnect', 'new').pairingId, nextPair.id);
});

test('closing a peer clears its endpoint and invalidates pairing and attach ticket', (t) => {
  const f = fixture(t);
  const request = f.send();
  f.store.setEndpoint(f.a.id, '/private/tmp/bridge.sock');
  assert.equal(f.store.peer(f.a.id).endpoint, '/private/tmp/bridge.sock');
  f.store.closePeer(f.a.id);
  f.store.closePeer(f.a.id);
  assert.equal(f.store.peer(f.a.id).endpoint, null);
  assert.equal(f.store.peer(f.a.id).closedAt, 1_000_000);
  assert.equal(f.store.peers().length, 2);
  assert.equal(f.store.pairings(f.b.id).length, 0);
  assert.equal(f.store.beginDelivery(request.id), false);
  assert.throws(() => f.store.attach(f.ticket), /Invalid/);
  assert.throws(() => f.store.setEndpoint(f.a.id, '/private/tmp/new.sock'), /closed/);
  assert.throws(() => f.store.inbox(f.a.id), /closed/);
});

test('delivery reservation is exclusive and uncertain dispatch is never retried', (t) => {
  const f = fixture(t);
  const message = f.send();
  const second = f.open();
  assert.equal(f.store.beginDelivery(message.id), true);
  assert.equal(second.beginDelivery(message.id), false);
  assert.equal(second.message(f.a.id, message.id).delivery, 'dispatching');
  f.store.close();
  const reopened = f.open();
  assert.equal(reopened.beginDelivery(message.id), false);
  reopened.finishDelivery(message.id, { state: 'unknown', detail: 'Transport ended without a receipt' });
  assert.equal(reopened.beginDelivery(message.id), false);
  assert.equal(reopened.message(f.a.id, message.id).delivery, 'unknown');
});

test('transport receipts preserve model acknowledgment and accepted reply', (t) => {
  const f = fixture(t);
  const request = f.send();
  assert.equal(f.store.beginDelivery(request.id), true);
  const claim = f.store.claim(f.b.id, request.id);
  const reply = f.store.reply(f.b.id, request.id, claim.claimId, 'done');
  f.store.finishDelivery(request.id, { state: 'submitted', detail: 'Accepted by local transport' });
  const final = f.store.message(f.a.id, request.id);
  assert.equal(final.delivery, 'submitted');
  assert.equal(final.acknowledgedAt, claim.message.acknowledgedAt);
  assert.equal(final.claimId, claim.claimId);
  assert.equal(final.answeredBy, reply.id);
  f.store.finishDelivery(request.id, { state: 'stored', detail: 'stale callback' });
  assert.equal(f.store.message(f.a.id, request.id).delivery, 'submitted');
  assert.equal(f.store.beginDelivery(request.id), false);
});

test('a definitely unavailable transport can return to stored for an explicit attempt', (t) => {
  const f = fixture(t);
  const request = f.send();
  assert.equal(f.store.beginDelivery(request.id), true);
  f.store.finishDelivery(request.id, { state: 'stored', detail: 'Receiver has no channel endpoint' });
  assert.equal(f.store.beginDelivery(request.id), true);
  f.store.finishDelivery(request.id, { state: 'submitted', detail: 'sent' });
  assert.equal(f.store.beginDelivery(request.id), false);
});

test('store creates private files and rejects symlinks, shared files, and hardlinks', (t) => {
  const f = fixture(t);
  assert.equal(lstatSync(f.home).mode & 0o777, 0o700);
  assert.equal(lstatSync(join(f.home, 'bridge.sqlite')).mode & 0o777, 0o600);
  for (const suffix of ['-wal', '-shm']) {
    assert.equal(lstatSync(join(f.home, `bridge.sqlite${suffix}`)).mode & 0o077, 0);
  }
  const root = mkdtempSync(join(tmpdir(), 'session-bridge-security-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, 'linked-home');
  symlinkSync(f.home, link);
  assert.throws(() => new Store(link), /real directory/);
  const publicHome = mkdtempSync(join(root, 'public-'));
  chmodSync(publicHome, 0o755);
  assert.throws(() => new Store(publicHome), /home must have private permissions/);
  assert.equal(lstatSync(publicHome).mode & 0o777, 0o755);
  const unsafe = mkdtempSync(join(root, 'unsafe-'));
  const file = join(unsafe, 'bridge.sqlite');
  writeFileSync(file, '', { mode: 0o644 });
  assert.throws(() => new Store(unsafe), /private permissions/);
  rmSync(file);
  symlinkSync(join(root, 'missing-target'), file);
  assert.throws(() => new Store(unsafe), /regular file/);
  const hardHome = mkdtempSync(join(root, 'hard-'));
  const hardFile = join(hardHome, 'bridge.sqlite');
  writeFileSync(hardFile, '', { mode: 0o600 });
  linkSync(hardFile, join(root, 'hardlink'));
  assert.throws(() => new Store(hardHome), /hard links/);
});

test('unsupported future schema fails without modifying its version', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'session-bridge-future-schema-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'bridge.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version=99');
  db.close();
  chmodSync(file, 0o600);
  assert.throws(() => new Store(home), /Unsupported store schema version: 99/);
  const reopened = new DatabaseSync(file);
  assert.equal(reopened.prepare('PRAGMA user_version').get()!.user_version, 99);
  reopened.close();
});


test('history provides bounded recent recovery records in both directions, including terminal states', (t) => {
  const f = fixture(t);
  const first = f.send();
  const firstClaim = f.store.claim(f.b.id, first.id);
  assert.equal(firstClaim.message.claimExpiresAt, 1_000_000 + 1800_000);
  f.advance(1000);
  const reply = f.store.reply(f.b.id, first.id, firstClaim.claimId, 'review complete');
  f.advance(1000);
  const cancelled = f.send('cancelled request', 'cancelled');
  f.store.cancel(f.a.id, cancelled.id);
  f.advance(1000);
  const expired = f.store.send(f.a.id, { to: f.b.id, body: 'expired request', ttlSeconds: 1, idempotencyKey: 'expired' });
  f.advance(1000);
  f.store.disconnect(f.b.id, f.pair.id);
  assert.deepEqual(f.store.history(f.a.id).map((message) => message.id), [expired.id, cancelled.id, reply.id, first.id]);
  assert.deepEqual(f.store.history(f.b.id, 2).map((message) => message.id), [expired.id, cancelled.id]);
  assert.deepEqual(f.store.history(f.c.id), []);
  assert.equal(f.store.history(f.a.id).find((message) => message.id === first.id)?.claimId, firstClaim.claimId);
  assert.notEqual(f.store.history(f.a.id).find((message) => message.id === cancelled.id)?.cancelledAt, null);
  assert.throws(() => f.store.history('missing'), /Unknown peer/);
  for (const limit of [0, -1, 101, 1.5, NaN]) assert.throws(() => f.store.history(f.a.id, limit), /History limit/);
  f.store.closePeer(f.a.id);
  assert.equal(f.store.history(f.a.id).length, 4);
});
