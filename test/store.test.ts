import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Store } from '../src/store.js';

const NATIVE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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
  assert.throws(() => store.createPeer({ host: 'claude', label: 'x', nativeSessionId: 'not-a-session' }), /UUID/);
});

test('Codex native attachment reuse preserves identity and connections without silently attaching a target', (t) => {
  const f = fixture(t);
  const status = f.store.updateStatus(f.a.id, 'Reviewing the current change');
  const reused = f.open().ensureCodexPeer({ nativeSessionId: NATIVE_ID, label: 'New label', attach: false });
  assert.deepEqual(reused, status);
  assert.equal(f.store.peers().length, 3);
  assert.equal(f.store.pairings(reused.id)[0]!.id, f.pair.id);
  assert.equal(f.store.attach(f.ticket).attachedAt, 1_000_000);
  assert.throws(() => f.store.attach(f.ticket), /already used/);
  assert.throws(() => f.store.createPeer({ host: 'codex', nativeSessionId: NATIVE_ID, label: 'Duplicate' }), /already has an active peer/);
  f.store.closePeer(reused.id);
  const fresh = f.store.ensureCodexPeer({ nativeSessionId: NATIVE_ID, label: 'Reconnected Codex' });
  assert.equal(fresh.id, reused.id);
  assert.equal(f.store.findNativePeer(NATIVE_ID)?.id, fresh.id);
  assert.deepEqual(f.store.connectedPeers(fresh.id), []);
  assert.equal(f.store.ensureCodexPeer({ nativeSessionId: NATIVE_ID, label: 'Ignored' }).id, fresh.id);
});

test('a provisional Codex target becomes attached only when that caller binds and invalidates a pending ticket', (t) => {
  const f = fixture(t);
  const nativeSessionId = '00000000-1111-2222-3333-444444444444';
  const target = f.store.ensureCodexPeer({ nativeSessionId, label: 'Target', attach: false });
  assert.equal(target.attachedAt, null);
  f.advance(1000);
  const caller = f.open().ensureCodexPeer({ nativeSessionId, label: 'Caller' });
  assert.equal(caller.id, target.id);
  assert.equal(caller.attachedAt, 1_001_000);
  f.advance(1000);
  assert.equal(f.store.ensureCodexPeer({ nativeSessionId, label: 'Again' }).attachedAt, caller.attachedAt);
  assert.equal(f.store.ensureCodexPeer({ nativeSessionId: NATIVE_ID, label: 'Native attachment' }).attachedAt, 1_002_000);
  assert.throws(() => f.store.attach(f.ticket), /already used/);
});

test('native lookup is exact and read only, reports provider ambiguity, and preserves a live Claude endpoint', (t) => {
  const f = fixture(t);
  const claude = f.store.createPeer({ host: 'claude', nativeSessionId: NATIVE_ID, label: 'Claude', endpoint: '/private/tmp/claude.sock' });
  assert.throws(() => f.store.findNativePeer(NATIVE_ID), /ambiguous/);
  assert.equal(f.store.findNativePeer(NATIVE_ID, 'codex')!.id, f.a.id);
  assert.equal(f.store.findNativePeer(NATIVE_ID, 'claude')!.id, claude.peer.id);
  assert.throws(() => f.open().createPeer({ host: 'claude', nativeSessionId: NATIVE_ID, label: 'Replacement', endpoint: '/private/tmp/replacement.sock' }), /already has an active peer/);
  assert.equal(f.store.peer(claude.peer.id).endpoint, '/private/tmp/claude.sock');
  assert.equal(f.store.attach(claude.ticket).id, claude.peer.id);
  assert.throws(() => f.store.attach(claude.ticket), /already used/);
  const before = f.store.peers();
  assert.equal(f.store.findNativePeer('00000000-1111-2222-3333-444444444444'), null);
  assert.deepEqual(f.store.peers(), before);
  assert.throws(() => f.store.findNativePeer(NATIVE_ID.slice(0, 8)), /UUID/);
  f.store.closePeer(claude.peer.id);
  assert.equal(f.store.findNativePeer(NATIVE_ID)!.id, f.a.id);
});

test('native UUID casing cannot create a second identity or prevent an existing attachment from being reused', (t) => {
  const f = fixture(t);
  assert.equal(f.store.findNativePeer(NATIVE_ID.toUpperCase(), 'codex')!.id, f.a.id);
  assert.equal(f.store.ensureCodexPeer({ nativeSessionId: NATIVE_ID.toUpperCase() }).id, f.a.id);
  assert.throws(() => f.store.createPeer({ host: 'codex', nativeSessionId: NATIVE_ID.toUpperCase(), label: 'Duplicate' }), /already has an active peer/);
  const claude = f.store.createPeer({ host: 'claude', nativeSessionId: NATIVE_ID.toUpperCase(), label: 'Claude' }).peer;
  assert.equal(claude.nativeSessionId, NATIVE_ID);
  assert.equal(f.store.findNativePeer(NATIVE_ID, 'claude')!.id, claude.id);
  assert.throws(() => f.store.createPeer({ host: 'claude', nativeSessionId: NATIVE_ID, label: 'Duplicate Claude' }), /already has an active peer/);
  const nativeSessionId = 'AAAAAAAA-1111-2222-3333-444444444444';
  const codex = f.store.ensureCodexPeer({ nativeSessionId });
  assert.equal(codex.nativeSessionId, nativeSessionId.toLowerCase());
  assert.equal(f.store.findNativePeer(nativeSessionId.toLowerCase(), 'codex')!.id, codex.id);
});

test('connected summaries isolate each caller and disconnecting one edge preserves other same-provider peers', (t) => {
  const f = fixture(t);
  const otherCodex = f.store.ensureCodexPeer({ nativeSessionId: '00000000-1111-2222-3333-444444444444', label: 'Another Codex' });
  const secondPair = f.store.pair(f.a.id, otherCodex.id);
  f.store.pair(f.b.id, f.c.id);
  const connected = f.store.connectedPeers(f.a.id);
  assert.deepEqual(new Set(connected.map(({ peer }) => peer.id)), new Set([f.b.id, otherCodex.id]));
  assert.deepEqual(connected.find(({ peer }) => peer.id === f.b.id)!.pairing, f.pair);
  f.store.disconnect(f.a.id, f.pair.id);
  assert.deepEqual(f.store.connectedPeers(f.a.id), [{ peer: otherCodex, pairing: secondPair }]);
  assert.deepEqual(f.store.connectedPeers(f.b.id).map(({ peer }) => peer.id), [f.c.id]);
  const message = f.store.send(f.a.id, { to: otherCodex.id, body: 'Still connected', idempotencyKey: 'second-codex' });
  assert.equal(f.store.inbox(otherCodex.id)[0]!.id, message.id);
  f.store.closePeer(otherCodex.id);
  assert.deepEqual(f.store.connectedPeers(f.a.id), []);
  assert.throws(() => f.store.connectedPeers(otherCodex.id), /closed/);
});

test('one-line status is durable attributed metadata with an honest timestamp and no message side effect', (t) => {
  const f = fixture(t);
  assert.equal(f.a.statusText, null);
  assert.equal(f.a.statusUpdatedAt, null);
  const updated = f.store.updateStatus(f.b.id, '  Running benchmark B  ');
  assert.equal(updated.id, f.b.id);
  assert.equal(updated.statusText, 'Running benchmark B');
  assert.equal(updated.statusUpdatedAt, 1_000_000);
  f.advance(600_000);
  assert.equal(f.open().connectedPeers(f.a.id)[0]!.peer.statusUpdatedAt, 1_000_000);
  assert.equal(f.store.peer(f.a.id).statusText, null);
  assert.deepEqual(f.store.history(f.a.id), []);
  const next = f.store.updateStatus(f.b.id, 'Waiting for permission');
  assert.equal(next.statusUpdatedAt, 1_600_000);
  for (const invalid of ['', ' ', 'a\nb', 'a\rb', 'a\u2028b', '\0bad', '😀'.repeat(129)]) {
    assert.throws(() => f.store.updateStatus(f.b.id, invalid), /Status/);
  }
  assert.equal(f.store.peer(f.b.id).statusText, 'Waiting for permission');
  f.store.closePeer(f.b.id);
  assert.throws(() => f.store.updateStatus(f.b.id, 'Running again'), /closed/);
});

test('schema migration preserves tickets and message evidence and does not silently merge legacy native duplicates', (t) => {
  const f = fixture(t);
  const original = f.send();
  const claim = f.store.claim(f.b.id, original.id);
  f.store.close();
  const legacy = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  legacy.exec(`ALTER TABLE peers DROP COLUMN status_text;
    ALTER TABLE peers DROP COLUMN status_updated_at;
    ALTER TABLE peers DROP COLUMN receiver_owner;
    ALTER TABLE peers DROP COLUMN receiver_checked_at;
    ALTER TABLE peers DROP COLUMN receiver_expires_at;
    ALTER TABLE messages DROP COLUMN notified_at;
    ALTER TABLE messages DROP COLUMN notified_by;
    PRAGMA user_version=1;`);
  legacy.prepare('UPDATE peers SET native_session_id=? WHERE id=?').run(NATIVE_ID.toUpperCase(), f.a.id);
  legacy.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at)
    VALUES('legacy-duplicate','codex','Duplicate native registration',?,?)`).run(NATIVE_ID, 1_000_000);
  legacy.close();
  const migrated = f.open();
  assert.equal(migrated.peer(f.a.id).statusText, null);
  assert.equal(migrated.peer(f.a.id).statusUpdatedAt, null);
  assert.equal(migrated.attach(f.ticket).id, f.a.id);
  assert.deepEqual(migrated.message(f.a.id, original.id), claim.message);
  assert.equal(migrated.pairings(f.a.id)[0]!.id, f.pair.id);
  assert.throws(() => migrated.findNativePeer(NATIVE_ID, 'codex'), /ambiguous/);
  assert.throws(() => migrated.ensureCodexPeer({ nativeSessionId: NATIVE_ID, label: 'Codex' }), /ambiguous/);
  migrated.closePeer('legacy-duplicate');
  assert.equal(migrated.findNativePeer(NATIVE_ID, 'codex')!.id, f.a.id);
  const again = f.open();
  assert.throws(() => again.attach(f.ticket), /already used/);
  assert.equal(again.message(f.b.id, original.id).claimId, claim.claimId);
});

test('schema two historical native aliases retain receipts and idempotency without reviving old connections', (t) => {
  const f = fixture(t);
  const nativeB = 'bbbbbbbb-1111-4222-8333-444444444444';
  const setup = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  setup.prepare('UPDATE peers SET native_session_id=? WHERE id=?').run(nativeB, f.b.id);
  setup.close();
  const request = f.send();
  const receipt = f.store.claim(f.b.id, request.id);
  const result = f.store.reply(f.b.id, request.id, receipt.claimId, 'Original result', 'reply-key');
  f.store.closePeer(f.a.id);
  f.store.closePeer(f.b.id);
  f.store.close();

  const legacy = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  legacy.exec(`ALTER TABLE peers DROP COLUMN receiver_owner;
    ALTER TABLE peers DROP COLUMN receiver_checked_at;
    ALTER TABLE peers DROP COLUMN receiver_expires_at;
    ALTER TABLE messages DROP COLUMN notified_at;
    ALTER TABLE messages DROP COLUMN notified_by;
    PRAGMA user_version=2;`);
  for (const [id, host, nativeId] of [
    ['sb_current_a', 'codex', NATIVE_ID.toUpperCase()], ['sb_current_b', 'claude', nativeB],
  ]) {
    legacy.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,attached_at)
      VALUES(?,?, 'Reactivated native session',?,1000001,1000001)`).run(id!, host!, nativeId!);
  }
  legacy.close();

  const store = f.open();
  const a = store.findNativePeer(NATIVE_ID, 'codex')!, b = store.findNativePeer(nativeB, 'claude')!;
  assert.equal(store.sameSession(a.id, f.a.id), true);
  assert.equal(store.sameSession(b.id, f.b.id), true);
  assert.equal(store.message(a.id, request.id).claimId, receipt.claimId);
  assert.equal(store.message(b.id, request.id).answeredBy, result.id);
  assert.deepEqual(store.incoming(a.id).map(message => message.id), [result.id]);
  assert.deepEqual(store.incoming(b.id).map(message => message.id), [request.id]);
  assert.deepEqual(new Set(store.history(a.id).map(message => message.id)), new Set([request.id, result.id]));
  assert.equal(store.send(a.id, {to: b.id, body: request.body, idempotencyKey: 'request-1'}).id, request.id);
  assert.equal(store.reply(b.id, request.id, receipt.claimId, result.body, 'reply-key').id, result.id);
  assert.throws(() => store.send(a.id, {to: b.id, body: 'Changed request', idempotencyKey: 'request-1'}), /different message input/);
  assert.throws(() => store.claim(b.id, request.id), /disconnected/);
  assert.equal(store.beginDelivery(request.id), false);
  const freshPair = store.pair(a.id, b.id);
  assert.notEqual(freshPair.id, request.pairingId);
  const cancelled = store.cancel(a.id, request.id);
  assert.equal(store.send(a.id, {to: b.id, body: request.body, idempotencyKey: 'request-1'}).cancelledAt, cancelled.cancelledAt);
  assert.equal(store.beginDelivery(request.id), false);
  assert.equal(store.send(a.id, {to: b.id, body: 'Fresh request', idempotencyKey: 'new-request'}).pairingId, freshPair.id);
  const sameUuidOtherProvider = store.ensureCodexPeer({nativeSessionId: nativeB});
  assert.equal(store.sameSession(sameUuidOtherProvider.id, b.id), false);
  assert.throws(() => store.message(sameUuidOtherProvider.id, request.id), /participant/);
  const version = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  assert.equal(version.prepare('PRAGMA user_version').get()!.user_version, 4);
  version.close();
  assert.equal(f.open().message(a.id, request.id).claimId, receipt.claimId);
});

test('conflicting historical idempotency keys fail closed without overwriting either exchange', (t) => {
  const f = fixture(t);
  const first = f.send();
  const legacy = new DatabaseSync(join(f.home, 'bridge.sqlite'));
  legacy.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,closed_at)
    VALUES('sb_old_a','codex','Old registration',?,1,2)`).run(NATIVE_ID);
  const [a, b] = ['sb_old_a', f.b.id].sort();
  legacy.prepare(`INSERT INTO pairings(id,a,b,created_at,closed_at) VALUES('pair_old',?,?,1,2)`).run(a!, b!);
  legacy.prepare(`INSERT INTO messages(id,pairing_id,from_peer,to_peer,kind,body,created_at,expires_at,idempotency_key)
    VALUES('msg_old','pair_old','sb_old_a',?,'request','Different earlier operation',1,3600001,'request-1')`).run(f.b.id);
  legacy.close();
  assert.throws(() => f.send(), /conflicting historical messages/);
  assert.equal(f.store.message(f.a.id, first.id).body, first.body);
  assert.equal(f.store.message(f.a.id, 'msg_old').body, 'Different earlier operation');
  assert.equal(f.store.history(f.a.id).length, 2);
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

test('competing readers retain the original receipt after its historical lease deadline', (t) => {
  const f = fixture(t);
  const message = f.send();
  const second = f.open();
  const claim = f.store.claim(f.b.id, message.id, 10);
  assert.equal(claim.alreadyClaimed, false);
  assert.deepEqual(second.claim(f.b.id, message.id, 300), { ...claim, alreadyClaimed: true });
  assert.equal(f.store.inbox(f.b.id).length, 0);
  assert.equal(claim.message.acknowledgedAt, 1_000_000);
  f.advance(10_000);
  assert.deepEqual(second.claim(f.b.id, message.id), {...claim, alreadyClaimed: true});
  const reply = f.store.reply(f.b.id, message.id, claim.claimId, 'Completed result');
  assert.equal(reply.replyTo, message.id);
  assert.equal(f.store.message(f.a.id, message.id).claimId, claim.claimId);
  assert.equal(f.store.message(f.a.id, message.id).answeredBy, reply.id);
});

test('a result after thirty one minutes retains its receipt while the one hour message deadline still fences work', (t) => {
  const f = fixture(t);
  const request = f.send();
  const receipt = f.store.claim(f.b.id, request.id);
  const pending = f.send('Still awaiting a receiver', 'pending');
  f.advance(31 * 60 * 1000);
  const reopened = f.open();
  assert.deepEqual(reopened.claim(f.b.id, request.id), {...receipt, alreadyClaimed: true});
  const reply = reopened.reply(f.b.id, request.id, receipt.claimId, 'Completed investigation', 'result');
  assert.equal(reply.replyTo, request.id);
  assert.equal(reopened.message(f.a.id, request.id).acknowledgedAt, receipt.message.acknowledgedAt);
  f.advance(29 * 60 * 1000);
  assert.throws(() => reopened.claim(f.b.id, request.id), /expired/);
  assert.throws(() => reopened.claim(f.b.id, pending.id), /expired/);
  assert.equal(reopened.beginDelivery(pending.id), false);
  assert.equal(reopened.message(f.b.id, request.id).claimId, receipt.claimId);
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

test('reply idempotency is durable and rejects key reuse across requests, notices and replies', (t) => {
  const f = fixture(t);
  const first = f.send();
  const claim = f.store.claim(f.b.id, first.id);
  f.store.send(f.b.id, { to: f.a.id, body: 'Progress update', kind: 'notice', idempotencyKey: 'notice-key' });
  assert.throws(() => f.store.reply(f.b.id, first.id, claim.claimId, 'Result', 'notice-key'), /different message input/);
  assert.throws(() => f.store.reply(f.b.id, first.id, claim.claimId, 'Result', ' '), /Idempotency key/);
  const result = f.store.reply(f.b.id, first.id, claim.claimId, 'Result', 'result-key');
  assert.deepEqual(f.open().reply(f.b.id, first.id, claim.claimId, 'Result', 'result-key'), result);
  assert.throws(() => f.store.reply(f.b.id, first.id, claim.claimId, 'Changed result', 'result-key'), /different message input/);
  assert.throws(() => f.store.reply(f.b.id, first.id, claim.claimId, 'Result', 'second-key'), /different idempotency key/);
  assert.throws(() => f.store.send(f.b.id, { to: f.a.id, body: 'Follow up', idempotencyKey: 'result-key' }), /different message input/);
  const second = f.send('Another request', 'another-request');
  const secondClaim = f.store.claim(f.b.id, second.id);
  assert.throws(() => f.store.reply(f.b.id, second.id, secondClaim.claimId, 'Result', 'result-key'), /different message input/);
  const legacy = f.store.reply(f.b.id, second.id, secondClaim.claimId, 'Legacy result');
  assert.deepEqual(f.store.reply(f.b.id, second.id, secondClaim.claimId, 'Legacy result', 'legacy-result-key'), legacy);
  assert.deepEqual(f.open().reply(f.b.id, second.id, secondClaim.claimId, 'Legacy result', 'legacy-result-key'), legacy);
  assert.equal(f.store.history(f.b.id).filter(({ kind }) => kind === 'reply').length, 2);
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
  assert.equal(f.send().id, request.id);
  assert.equal(f.store.beginDelivery(request.id), false);
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

test('incoming recovery preserves previously received and terminal messages without including sent messages', (t) => {
  const f = fixture(t);
  const received = f.send();
  const claim = f.store.claim(f.b.id, received.id);
  f.advance(1000);
  const outgoing = f.store.reply(f.b.id, received.id, claim.claimId, 'Result');
  f.advance(1000);
  const cancelled = f.send('Cancelled request', 'cancelled-recovery');
  f.store.cancel(f.a.id, cancelled.id);
  f.advance(1000);
  const expired = f.store.send(f.a.id, { to: f.b.id, body: 'Expired request', ttlSeconds: 1, idempotencyKey: 'expired-recovery' });
  f.advance(1000);
  assert.deepEqual(f.store.inbox(f.b.id), []);
  assert.deepEqual(f.open().incoming(f.b.id).map(({ id }) => id), [received.id, cancelled.id, expired.id]);
  assert.equal(f.store.incoming(f.b.id)[0]!.answeredBy, outgoing.id);
  assert.equal(f.store.incoming(f.b.id)[0]!.acknowledgedAt, claim.message.acknowledgedAt);
  assert.deepEqual(f.store.incoming(f.c.id), []);
  f.store.disconnect(f.a.id, f.pair.id);
  assert.equal(f.store.incoming(f.b.id).length, 3);
  f.store.closePeer(f.b.id);
  assert.throws(() => f.store.incoming(f.b.id), /closed/);
});

test('incoming keyset pages bound historical bodies and preserve received records through timestamp ties', (t) => {
  const f = fixture(t);
  const sent = [];
  for (let index = 0; index < 105; index++) {
    if (index === 104) f.advance(1000);
    sent.push(f.store.send(f.a.id, { to: f.b.id, body: `Checkpoint ${index}`, kind: 'notice', idempotencyKey: `page-${index}` }));
  }
  const expected = sent.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  assert.equal(f.store.incoming(f.b.id).length, 100);
  assert.equal(f.store.incoming(f.b.id, { limit: 101 }).length, 101);
  const firstPage = f.store.incoming(f.b.id, { limit: 7 });
  assert.deepEqual(firstPage.map(({ id }) => id), expected.slice(0, 7).map(({ id }) => id));
  const receipt = f.store.claim(f.b.id, firstPage[0]!.id);
  assert.equal(f.open().incoming(f.b.id, { limit: 7 })[0]!.acknowledgedAt, receipt.message.acknowledgedAt);
  const actual = firstPage.map(({ id }) => id);
  let after = firstPage.at(-1)!;
  for (;;) {
    const next = f.store.incoming(f.b.id, { limit: 7, after: { createdAt: after.createdAt, id: after.id } });
    assert.ok(next.length <= 7);
    if (!next.length) break;
    actual.push(...next.map(({ id }) => id));
    after = next.at(-1)!;
  }
  assert.deepEqual(actual, expected.map(({ id }) => id));
  for (const limit of [0, -1, 102, 1.5, NaN]) assert.throws(() => f.store.incoming(f.b.id, { limit }), /Incoming limit/);
  assert.throws(() => f.store.incoming(f.b.id, { after: { createdAt: NaN, id: firstPage[0]!.id } }), /cursor timestamp/);
  assert.throws(() => f.store.incoming(f.b.id, { after: { createdAt: 1_000_000, id: '' } }), /cursor ID/);
});
