import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Sessions } from '../src/sessions.js';
import { Store } from '../src/store.js';
import type { Host } from '../src/types.js';

const CODEX_A = '11111111-1111-4111-8111-111111111111';
const CODEX_B = '22222222-2222-4222-8222-222222222222';
const CLAUDE_A = '33333333-3333-4333-8333-333333333333';
const CLAUDE_B = '44444444-4444-4444-8444-444444444444';
const DORMANT_CODEX = '55555555-5555-4555-8555-555555555555';
const DORMANT_CLAUDE = '66666666-6666-4666-8666-666666666666';

function fixture(t: TestContext, queueExit = 0) {
  const home = mkdtempSync(join(tmpdir(), 'sb-sessions-'));
  const capture = join(home, 'native-queue.jsonl');
  const command = join(home, 'fake-codex');
  writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))+'\\n');process.exit(${queueExit});\n`, { mode: 0o700 });
  let now = 1_000_000;
  const databases: Store[] = [];
  const open = () => {
    const store = new Store(home, () => now);
    databases.push(store);
    return store;
  };
  const store = open();
  const receivers = new Map<string, ReturnType<Store['acquireReceiver']>>();
  for (const [host, nativeSessionId, label] of [
    ['codex', CODEX_A, 'Implementer'], ['codex', CODEX_B, 'Experiment'],
    ['claude', CLAUDE_A, 'Reviewer'], ['claude', CLAUDE_B, 'Second reviewer'],
  ] satisfies Array<[Host, string, string]>) {
    if (host === 'claude') receivers.set(nativeSessionId, store.acquireReceiver({ nativeSessionId, label }));
    else {
      const registration = store.createPeer({ host, nativeSessionId, label });
      store.attach(registration.ticket);
    }
  }
  const session = (host: Host, id: string | undefined, database = store) => new Sessions(database, host, id, command);
  t.after(() => {
    for (const database of databases) database.close();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    store, open, session, receivers,
    codexA: session('codex', CODEX_A), codexB: session('codex', CODEX_B),
    claudeA: session('claude', CLAUDE_A), claudeB: session('claude', CLAUDE_B),
    advance: (ms: number) => { now += ms; },
    queued: (): string[][] => existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
  };
}

function assertPublicIdentity(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(!serialized.includes('sb_'), 'Public results must not expose internal peer IDs.');
  assert.ok(!serialized.includes('claimId'), 'Receipt tokens remain inside the facade.');
  assert.ok(!serialized.includes('claimExpiresAt'), 'The retired receipt lease is not a public reply deadline.');
  assert.ok(!serialized.includes('pairingId'), 'Connection tokens remain inside the facade.');
}

test('four existing sessions exchange across both providers without transitive connections or global disconnect', async t => {
  const f = fixture(t);
  await f.codexA.connect(`codex:${CODEX_B}`);
  await f.codexA.connect(`claude:${CLAUDE_A}`);
  await f.claudeA.connect(`claude:${CLAUDE_B}`);
  await f.codexA.connect(CODEX_B);
  assert.deepEqual(new Set(f.codexA.list().sessions.map(peer => peer.sessionId)), new Set([CODEX_B, CLAUDE_A]));
  assert.deepEqual(f.codexB.list().sessions.map(peer => peer.sessionId), [CODEX_A]);
  assert.deepEqual(f.claudeB.list().sessions.map(peer => peer.sessionId), [CLAUDE_A]);
  assert.equal(f.queued().length, 0, 'Connecting does not start or notify any model.');

  for (const [sender, recipient, senderId, recipientId] of [
    [f.codexA, f.codexB, CODEX_A, CODEX_B],
    [f.codexA, f.claudeA, CODEX_A, CLAUDE_A],
    [f.claudeA, f.claudeB, CLAUDE_A, CLAUDE_B],
  ] as const) {
    const request = await sender.send({ sessionId: recipientId, text: 'Review the current parser change.', idempotencyKey: `review-${recipientId}` });
    const receipt = recipient.read({ messageId: request.messageId }).messages[0]!;
    assert.equal(receipt.text, request.text);
    const reply = await recipient.send({ sessionId: senderId, text: 'Review complete: one missing boundary check.', replyTo: request.messageId, idempotencyKey: `result-${recipientId}` });
    assert.equal(sender.read({ messageId: reply.messageId }).messages[0]!.replyTo, request.messageId);
    assertPublicIdentity([request, receipt, reply]);
  }
  await assert.rejects(f.codexB.send({ sessionId: CLAUDE_B, text: 'Indirect path is insufficient.', idempotencyKey: 'transitive' }), /not paired/);
  assert.equal(f.codexA.disconnect(CODEX_B).disconnected, true);
  assert.equal(f.codexA.disconnect(CODEX_B).disconnected, false);
  assert.deepEqual(f.codexB.list().sessions, []);
  assert.deepEqual(f.codexA.list().sessions.map(peer => peer.sessionId), [CLAUDE_A]);
  assert.deepEqual(f.claudeB.list().sessions.map(peer => peer.sessionId), [CLAUDE_A]);
  await assert.rejects(f.codexA.send({ sessionId: CODEX_B, text: 'Disconnected.', idempotencyKey: 'closed' }), /not paired/);
  const remaining = await f.claudeB.send({ sessionId: CLAUDE_A, text: 'The other review continues.', expectsReply: false, idempotencyKey: 'remaining' });
  assert.equal(f.claudeA.read({ messageId: remaining.messageId }).messages[0]!.text, remaining.text);
});

test('listing and self status remain silent, attributed and stale without activating dormant sessions', async t => {
  const f = fixture(t);
  const dormantCodex = f.session('codex', DORMANT_CODEX);
  const dormantClaude = f.session('claude', DORMANT_CLAUDE);
  assert.equal(dormantCodex.list().activationRequired, true);
  assert.equal(dormantClaude.list().activationRequired, true);
  assert.throws(() => dormantCodex.updateStatus('Running'), /Activation required/);
  assert.throws(() => f.session('codex', undefined).list(), /native session context is unavailable/);
  assert.equal(f.store.peers().length, 4);
  assert.deepEqual(f.codexA.list().sessions, [], 'Unconnected registrations are not discovered.');
  await f.codexA.connect(CLAUDE_A);
  const status = f.claudeA.updateStatus('Reviewing parser.ts at commit abc123');
  assert.equal(status.sessionId, CLAUDE_A);
  assert.deepEqual(status.status, { text: 'Reviewing parser.ts at commit abc123', updatedAt: 1_000_000, source: 'self_report' });
  f.advance(600_000);
  const listed = f.codexA.list().sessions[0]!;
  assert.equal(listed.status!.updatedAt, 1_000_000);
  assert.equal(listed.connection, 'connected', 'A connection is not a claim of current execution.');
  assert.equal(f.codexA.list().self!.status, null);
  assertPublicIdentity(f.codexA.list());
  assert.deepEqual(f.codexA.read().messages, []);
  assert.deepEqual(f.claudeA.read().messages, []);
  assert.deepEqual(f.queued(), []);
});

test('receiver health and message progress stay distinct from durable connections', async t => {
  const f = fixture(t);
  await f.codexA.connect(CLAUDE_A);
  const receiver = f.receivers.get(CLAUDE_A)!;
  assert.equal(f.codexA.list().sessions[0]!.receiver.state, 'available');
  assert.equal(f.claudeA.list().sessions[0]!.receiver.state, 'unknown');
  f.store.releaseReceiver(receiver.peer.id, receiver.ownerToken);
  const offline = f.claudeA.list();
  assert.equal(offline.activationRequired, true);
  assert.equal(offline.self!.sessionId, CLAUDE_A);
  assert.equal(offline.sessions[0]!.sessionId, CODEX_A);
  assert.equal(f.codexA.list().sessions[0]!.connection, 'connected');
  assert.equal(f.codexA.list().sessions[0]!.receiver.state, 'unavailable');
  assert.equal((await f.claudeA.connect(CLAUDE_B)).state, 'activation_required');
  assert.equal(f.claudeA.list().sessions.length, 1);

  const queued = await f.codexA.send({ sessionId: CLAUDE_A, text: 'Review when the receiver returns.', idempotencyKey: 'offline' });
  assert.equal(queued.deliveryStage, 'queued');
  assert.equal(queued.acknowledgedAt, null);
  const replacement = f.store.acquireReceiver({ nativeSessionId: CLAUDE_A, label: 'Reviewer resumed' });
  assert.equal(replacement.peer.id, receiver.peer.id);
  assert.equal(f.claudeA.list().activationRequired, false);
  assert.equal(f.store.markNotified(replacement.peer.id, replacement.ownerToken, queued.messageId), true);
  const notified = f.codexA.read({ messageId: queued.messageId }).messages[0]!;
  assert.equal(notified.deliveryStage, 'notified');
  assert.equal(notified.acknowledgedAt, null);
  assert.equal(f.claudeA.read({ messageId: queued.messageId }).messages[0]!.deliveryStage, 'read');
  await f.claudeA.send({ sessionId: CODEX_A, text: 'Review finished.', replyTo: queued.messageId, idempotencyKey: 'offline-result' });
  assert.equal(f.codexA.read({ messageId: queued.messageId }).messages[0]!.deliveryStage, 'replied');
  assertPublicIdentity(f.claudeA.list());
  assert.ok(!JSON.stringify(f.claudeA.list()).includes(replacement.ownerToken));
});

test('messages preserve receipts and one final reply while notices and retries cannot create reply loops', async t => {
  const f = fixture(t);
  await f.codexA.connect(CLAUDE_A);
  const input = { sessionId: CLAUDE_A, text: 'Review commit abc123 while I continue implementing.', idempotencyKey: 'review' };
  const request = await f.codexA.send(input);
  const before = f.codexA.read({ messageId: request.messageId }).messages[0]!;
  assert.equal(before.acknowledgedAt, null);
  assert.ok(!('previouslyRead' in before), 'Sent inspection is not a receipt.');
  assert.equal(f.claudeA.read().messages[0]!.previouslyRead, false);
  const after = f.codexA.read({ messageId: request.messageId }).messages[0]!;
  assert.equal(after.acknowledgedAt, 1_000_000);
  assert.equal(f.claudeA.read({ messageId: request.messageId }).messages[0]!.previouslyRead, true);
  assert.equal(f.claudeA.read().messages[0]!.previouslyRead, true, 'A lost read response remains recoverable without remembering its message ID.');
  assert.throws(() => f.claudeB.read({ messageId: request.messageId }), /Not a participant/);
  assert.equal((await f.codexA.send(input)).messageId, request.messageId);
  await assert.rejects(f.codexA.send({ ...input, text: 'Changed request' }), /different message input/);
  await assert.rejects(f.codexA.send({ ...input, expectsReply: false }), /different message input/);
  const notice = await f.claudeA.send({ sessionId: CODEX_A, text: 'Accepted; I will review that commit.', idempotencyKey: 'accepted', expectsReply: false });
  f.codexA.read({ messageId: notice.messageId });
  await assert.rejects(f.codexA.send({ sessionId: CLAUDE_A, text: 'Thanks', replyTo: notice.messageId, idempotencyKey: 'courtesy' }), /Only a request/);
  await assert.rejects(f.claudeA.send({ sessionId: CODEX_A, text: 'Result', replyTo: request.messageId, idempotencyKey: 'accepted' }), /different message input/);
  await assert.rejects(f.claudeA.send({ sessionId: CODEX_A, text: 'Result', replyTo: request.messageId, expectsReply: true, idempotencyKey: 'invalid' }), /terminal/);
  await assert.rejects(f.claudeA.send({ sessionId: CODEX_B, text: 'Result', replyTo: request.messageId, idempotencyKey: 'wrong-peer' }), /participants/);
  const resultInput = { sessionId: CODEX_A, text: 'One finding at parser.ts:12.', replyTo: request.messageId, idempotencyKey: 'result' };
  const result = await f.claudeA.send(resultInput);
  const queued = f.queued().length;
  assert.equal((await f.claudeA.send(resultInput)).messageId, result.messageId);
  assert.equal(f.queued().length, queued, 'A successful retry does not re-notify the receiver.');
  await assert.rejects(f.claudeA.send({ ...resultInput, text: 'Another finding' }), /different message input/);
  await assert.rejects(f.claudeA.send({ ...resultInput, idempotencyKey: 'another-result' }), /different idempotency key/);
  f.codexA.read({ messageId: result.messageId });
  await assert.rejects(f.codexA.send({ sessionId: CLAUDE_A, text: 'Thanks', replyTo: result.messageId, idempotencyKey: 'thanks' }), /Only a request/);
  assert.equal(f.codexA.read({ messageId: request.messageId }).messages[0]!.answeredBy, result.messageId);
  assertPublicIdentity([after, result, f.claudeA.read({ messageId: request.messageId })]);
});

test('one-sided Codex invitation binds only the notified native recipient without a reciprocal connect or new model', async t => {
  const f = fixture(t);
  const recipient = f.session('codex', DORMANT_CODEX);
  const pending = await f.claudeA.connect(`codex:${DORMANT_CODEX}`);
  assert.equal(pending.state, 'pending');
  assert.equal(recipient.list().activationRequired, true);
  assert.equal(f.claudeA.list().sessions[0]!.connection, 'pending');
  assert.deepEqual(f.queued(), []);
  const unavailable = await f.codexA.connect(`claude:${DORMANT_CLAUDE}`);
  assert.equal(unavailable.state, 'activation_required');
  assert.equal(f.store.findNativePeer(DORMANT_CLAUDE), null);
  const request = await f.claudeA.send({ sessionId: `codex:${DORMANT_CODEX}`, text: 'Please review this selected context.', idempotencyKey: 'invite-review' });
  assert.equal(request.delivery, 'stored');
  assert.equal(request.recipientInbox.notification?.state, 'submitted');
  const invocation = f.queued()[0]!;
  assert.deepEqual(invocation.slice(0, 4), ['queue', '--thread', DORMANT_CODEX, '--message']);
  assert.equal(invocation.length, 5);
  assert.ok(!invocation[4]!.includes(request.text), 'Native notification does not embed peer content.');
  await f.codexA.connect(CODEX_B);
  const unrelated = await f.codexA.send({ sessionId: CODEX_B, text: 'Different exchange.', idempotencyKey: 'other' });
  assert.throws(() => recipient.read({ messageId: unrelated.messageId }), /Not a participant/);
  assert.equal(recipient.list().activationRequired, true);
  assert.throws(() => recipient.read(), /Activation required/);
  const message = recipient.read({ messageId: request.messageId }).messages[0]!;
  assert.equal(message.text, request.text);
  assert.equal(recipient.list().activationRequired, false);
  assert.deepEqual(recipient.list().sessions.map(peer => peer.sessionId), [CLAUDE_A]);
  assert.equal(f.claudeA.list().sessions[0]!.connection, 'connected');
  const result = await recipient.send({ sessionId: CLAUDE_A, replyTo: request.messageId, text: 'Review complete.', idempotencyKey: 'one-sided-result' });
  assert.equal(f.claudeA.read({ messageId: result.messageId }).messages[0]!.from.sessionId, DORMANT_CODEX);
});

test('message pagination and competing readers preserve one receipt across database connections', async t => {
  const f = fixture(t);
  await f.codexA.connect(CLAUDE_A);
  const competing = f.session('claude', CLAUDE_A, f.open());
  const sent = [];
  for (let i = 0; i < 3; i++) sent.push(await f.codexA.send({ sessionId: CLAUDE_A, text: `Checkpoint ${i}`, idempotencyKey: `checkpoint-${i}`, expectsReply: false }));
  const first = f.claudeA.read({ limit: 1 });
  assert.equal(first.messages.length, 1);
  assert.ok(first.nextCursor);
  const recovered = competing.read({ limit: 1 });
  assert.equal(recovered.messages[0]!.messageId, first.messages[0]!.messageId);
  assert.equal(recovered.messages[0]!.previouslyRead, true, 'Losing the first read response does not hide its claimed message.');
  const repeated = competing.read({ messageId: first.messages[0]!.messageId }).messages[0]!;
  assert.equal(repeated.previouslyRead, true);
  assert.equal(repeated.acknowledgedAt, first.messages[0]!.acknowledgedAt);
  const rest = competing.read({ limit: 2, cursor: first.nextCursor });
  assert.equal(rest.nextCursor, null);
  assert.equal(rest.messages.length, 2);
  assert.deepEqual(new Set([...first.messages, ...rest.messages].map(message => message.messageId)), new Set(sent.map(message => message.messageId)));
  const recovery = f.claudeA.read().messages;
  assert.equal(recovery.length, 3);
  assert.ok(recovery.every(message => message.previouslyRead));
  assert.throws(() => f.claudeA.read({ cursor: 'malformed' }), /Invalid cursor/);
  assert.throws(() => f.claudeA.read({ limit: 0 }), /Limit/);
  await f.codexA.connect(CODEX_B);
  const peers = f.codexA.list({ limit: 1 });
  assert.ok(peers.nextCursor);
  const nextPeers = f.codexA.list({ limit: 1, cursor: peers.nextCursor });
  assert.equal(nextPeers.nextCursor, null);
  assert.deepEqual(new Set([...peers.sessions, ...nextPeers.sessions].map(peer => peer.sessionId)), new Set([CLAUDE_A, CODEX_B]));
});

test('a receipt survives long work while the original request deadline still limits replies', async t => {
  const f = fixture(t);
  await f.codexA.connect(CLAUDE_A);
  const received = await f.codexA.send({ sessionId: CLAUDE_A, text: 'Bounded review.', idempotencyKey: 'received' });
  const untouched = await f.codexA.send({ sessionId: CLAUDE_A, text: 'Another bounded review.', idempotencyKey: 'untouched' });
  const original = f.claudeA.read({ messageId: received.messageId }).messages[0]!;
  f.advance(1_800_001);
  const recoveredReceipt = f.claudeA.read({ messageId: received.messageId }).messages[0]!;
  assert.equal(recoveredReceipt.actionable, true);
  assert.equal(recoveredReceipt.previouslyRead, true);
  assert.equal(recoveredReceipt.acknowledgedAt, original.acknowledgedAt);
  assert.equal(recoveredReceipt.blockedReason, null);
  const lateReply = await f.claudeA.send({ sessionId: CODEX_A, replyTo: received.messageId, text: 'Late result.', idempotencyKey: 'late' });
  f.advance(1_800_000);
  const fresh = await f.codexA.send({ sessionId: CLAUDE_A, text: 'A fresh request after the earlier deadlines.', idempotencyKey: 'fresh' });
  const recovered = f.claudeA.read().messages;
  assert.equal(recovered.length, 3);
  for (const old of [received, untouched]) {
    const blocked = recovered.find(message => message.messageId === old.messageId)!;
    assert.equal(blocked.actionable, false);
    assert.match(blocked.blockedReason!, /expired/);
  }
  const freshReceipt = recovered.find(message => message.messageId === fresh.messageId)!;
  assert.equal(freshReceipt.previouslyRead, false);
  assert.equal(freshReceipt.acknowledgedAt, 4_600_001, 'An expired earlier item does not hide or prevent receipt of fresh work.');
  const expired = f.claudeA.read({ messageId: untouched.messageId }).messages[0]!;
  assert.equal(expired.actionable, false);
  assert.equal(expired.previouslyRead, false);
  assert.match(expired.blockedReason!, /expired/);
  assert.equal(f.codexA.read({ messageId: untouched.messageId }).messages[0]!.acknowledgedAt, null);
  assert.equal(f.codexA.read({ messageId: received.messageId }).messages[0]!.answeredBy, lateReply.messageId);
});

test('uncertain native delivery remains inspectable and is not repeated on an idempotent send', async t => {
  const f = fixture(t, 1);
  await f.claudeA.connect(CODEX_A);
  const input = { sessionId: CODEX_A, text: 'Run this bounded check.', idempotencyKey: 'uncertain' };
  const first = await f.claudeA.send(input);
  assert.equal(first.delivery, 'stored');
  assert.equal(first.recipientInbox.notification?.state, 'unknown');
  assert.equal(f.claudeA.read({ messageId: first.messageId }).messages[0]!.acknowledgedAt, null);
  assert.equal((await f.claudeA.send(input)).messageId, first.messageId);
  assert.equal(f.queued().length, 1);
  assert.equal(f.codexA.read({ messageId: first.messageId }).messages[0]!.previouslyRead, false);
  assert.equal(f.claudeA.read({ messageId: first.messageId }).messages[0]!.deliveryStage, 'read');
  assert.equal(f.codexA.list().self!.inbox.notification?.state, 'unknown');
});


test('blocked targeted notifications expose evidence without activating a provisional Codex recipient', async t => {
  for (const reason of ['cancelled', 'disconnected', 'expired'] as const) {
    await t.test(reason, async subtest => {
      const f = fixture(subtest);
      const recipient = f.session('codex', DORMANT_CODEX);
      await f.claudeA.connect(`codex:${DORMANT_CODEX}`);
      const request = await f.claudeA.send({ sessionId: DORMANT_CODEX, text: 'Review the selected snapshot.', idempotencyKey: 'before-block' });
      if (reason === 'cancelled') f.store.cancel(f.store.findNativePeer(CLAUDE_A)!.id, request.messageId);
      else if (reason === 'disconnected') f.claudeA.disconnect(DORMANT_CODEX);
      else f.advance(3_600_001);
      const evidence = recipient.read({ messageId: request.messageId }).messages[0]!;
      assert.equal(evidence.text, request.text);
      assert.equal(evidence.actionable, false);
      assert.equal(evidence.previouslyRead, false);
      assert.equal(evidence.acknowledgedAt, null);
      assert.match(evidence.blockedReason!, new RegExp(reason));
      assert.equal(recipient.list().activationRequired, true);
      assert.equal(f.store.findNativePeer(DORMANT_CODEX)!.attachedAt, null);
      for (const identity of [evidence.from, evidence.to]) {
        assert.ok(!('connection' in identity), 'Historical message identities cannot imply a current connection.');
        assert.ok(!('status' in identity), 'Status belongs to current session listings, not message identity.');
      }
      if (reason === 'disconnected') await f.claudeA.connect(`codex:${DORMANT_CODEX}`);
      const fresh = await f.claudeA.send({ sessionId: DORMANT_CODEX, text: 'Review this fresh snapshot.', idempotencyKey: 'after-block' });
      const receipt = recipient.read({ messageId: fresh.messageId }).messages[0]!;
      assert.equal(receipt.actionable, true);
      assert.equal(receipt.previouslyRead, false);
      assert.equal(receipt.blockedReason, null);
      assert.notEqual(receipt.acknowledgedAt, null);
      assert.equal(recipient.list().activationRequired, false);
      assert.equal(f.store.findNativePeer(DORMANT_CODEX)!.attachedAt, receipt.acknowledgedAt);
    });
  }
});
