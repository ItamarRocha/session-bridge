import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Sessions } from '../src/sessions.js';
import { Store } from '../src/store.js';

const CODEX = '11111111-1111-4111-8111-111111111111';
const CLAUDE = '22222222-2222-4222-8222-222222222222';
const OTHER_CLAUDE = '33333333-3333-4333-8333-333333333333';

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'sb-inbox-journey-'));
  const queue = join(home, 'queue.jsonl'), command = join(home, 'fake-codex');
  writeFileSync(queue, '');
  writeFileSync(command, `#!${process.execPath}\nconst fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(queue)}, JSON.stringify(process.argv.slice(2))+'\\n');
console.log('Queued message '+require('node:crypto').randomUUID()+' for thread '+process.argv[4]+'.');
`, {mode: 0o700});
  const store = new Store(home, () => 1_000_000);
  store.acquireReceiver({nativeSessionId: CLAUDE, label: 'First worker'});
  store.acquireReceiver({nativeSessionId: OTHER_CLAUDE, label: 'Second worker'});
  const sender = new Sessions(store, 'claude', CLAUDE, command);
  const secondSender = new Sessions(store, 'claude', OTHER_CLAUDE, command);
  const receiver = new Sessions(store, 'codex', CODEX, command);
  const queued = (): string[][] => readFileSync(queue, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const token = (index = queued().length - 1) => {
    const notice = queued()[index]![4]!;
    const match = /"notificationToken":"([^"]+)"/.exec(notice);
    assert.ok(match, 'Native notification must contain its opaque inbox token.');
    return match[1]!;
  };
  t.after(() => {store.close(); rmSync(home, {recursive: true, force: true});});
  const send = (key: string, session = sender, expectsReply = false) => session.send({sessionId: CODEX, text: `Evidence ${key}`, idempotencyKey: key, expectsReply});
  return {home, store, sender, secondSender, receiver, queued, token, send};
}

test('twenty arrivals share one native notification even after proactive receipts', async t => {
  const f = fixture(t);
  await f.sender.connect(`codex:${CODEX}`);
  await f.secondSender.connect(`codex:${CODEX}`);
  const sent = await Promise.all(Array.from({length: 20}, (_, i) => f.send(`report-${i}`, i % 2 ? f.sender : f.secondSender)));
  assert.equal(new Set(sent.map(message => message.messageId)).size, 20);
  assert.equal(f.queued().length, 1);
  assert.ok(f.queued().every(args => args[0] === 'queue' && args[2] === CODEX));
  assert.ok(sent.every(message => !f.queued()[0]![4]!.includes(message.text)));

  f.receiver.read({messageId: sent[0]!.messageId});
  const polled = f.receiver.read({unreadOnly: true, limit: 100});
  assert.equal(polled.messages.length, 19);
  assert.ok(polled.messages.every(message => message.acknowledgedAt !== null));
  assert.equal(f.receiver.list().self!.inbox.unreadCount, 0);
  assert.equal(f.receiver.list().self!.inbox.notification!.state, 'submitted');
  assert.ok(f.receiver.list().self!.inbox.notification!.nativeQueueId);
  assert.ok(!JSON.stringify(f.receiver.list()).includes(f.token()), 'Status must not expose a token for proactive consumption.');
  assert.equal(f.queued().length, 1);

  const consumed = await f.receiver.readNotification(f.token());
  assert.deepEqual(consumed.messages, []);
  assert.equal(consumed.notification.consumed, true);
  assert.equal(consumed.notification.remaining, false);
  assert.equal(consumed.inbox.notification, null);
  assert.equal(f.queued().length, 1);

  await f.send('new-result');
  assert.equal(f.queued().length, 2);
  assert.notEqual(f.token(0), f.token(1));
  const fresh = await f.receiver.readNotification(f.token(1));
  assert.equal(fresh.messages[0]!.text, 'Evidence new-result');
  assert.equal(fresh.messages[0]!.previouslyRead, false);
});

test('a delivered token binds only its invited native recipient and replays are not new work', async t => {
  const f = fixture(t);
  await f.sender.connect(`codex:${CODEX}`);
  const request = await f.send('review', f.sender, true);
  assert.equal(f.receiver.list().activationRequired, true);
  assert.equal(request.recipientInbox.notification!.state, 'submitted');
  const wrong = new Sessions(f.store, 'claude', OTHER_CLAUDE);
  await assert.rejects(wrong.readNotification(f.token()), /recipient|participant|belong|notification/i);
  assert.equal(f.receiver.list().activationRequired, true);

  const result = await f.receiver.readNotification(f.token());
  assert.equal(result.messages[0]!.messageId, request.messageId);
  assert.equal(result.messages[0]!.actionable, true);
  assert.equal(f.receiver.list().activationRequired, false);
  assert.equal(result.inbox.pendingRequestCount, 1, 'Read requests remain unfinished until their substantive result.');

  const replay = await f.receiver.readNotification(f.token());
  assert.equal(replay.notification.replayed, true);
  assert.equal(replay.messages[0]!.previouslyRead, true);
  assert.equal(replay.messages[0]!.actionable, false);
  assert.equal(replay.messages[0]!.acknowledgedAt, result.messages[0]!.acknowledgedAt);
  assert.equal(f.queued().length, 1);
  assert.deepEqual(f.receiver.read({unreadOnly: true}).messages, []);
  assert.equal(f.receiver.read({messageId: request.messageId}).messages[0]!.actionable, true, 'Explicit recovery retains the original request.');
});

test('bounded token reads rearm for remaining work without replaying old generations', async t => {
  const f = fixture(t);
  await f.sender.connect(`codex:${CODEX}`);
  const sent = [];
  for (let i = 0; i < 5; i++) sent.push(await f.send(`part-${i}`));
  const firstToken = f.token();
  const first = await f.receiver.readNotification(firstToken, 2);
  assert.equal(first.messages.length, 2);
  assert.equal(first.notification.remaining, true);
  assert.equal(f.queued().length, 2);
  const secondToken = f.token();
  await f.send('arrived-during-drain');
  assert.equal(f.queued().length, 2);
  const replay = await f.receiver.readNotification(firstToken, 2);
  assert.equal(replay.notification.replayed, true);
  assert.equal(f.queued().length, 2);
  const second = await f.receiver.readNotification(secondToken, 100);
  assert.equal(second.messages.length, 4);
  assert.equal(second.notification.remaining, false);
  assert.equal(new Set([...first.messages, ...second.messages].map(message => message.messageId)).size, 6);
  assert.equal(f.receiver.list().self!.inbox.notification, null);
  await assert.rejects(f.receiver.readNotification(secondToken, 101), /Limit/);
});

test('quiet status changes and unread pagination never consume the queued notification', async t => {
  const f = fixture(t);
  await f.sender.connect(`codex:${CODEX}`);
  for (let i = 0; i < 4; i++) await f.send(`progress-${i}`);
  f.sender.updateStatus('Preparing the final comparison.');
  assert.equal(f.queued().length, 1);
  f.receiver.read({messageId: f.store.inbox(f.store.findNativePeer(CODEX, 'codex')!.id)[0]!.id});
  const one = f.receiver.read({unreadOnly: true, limit: 1});
  assert.equal(one.messages.length, 1);
  assert.ok(one.nextCursor);
  const rest = f.receiver.read({unreadOnly: true, limit: 100, cursor: one.nextCursor});
  assert.equal(rest.messages.length, 2);
  assert.equal(f.receiver.read().messages.length, 4, 'History remains available after receipts.');
  assert.equal(f.receiver.list().self!.inbox.notification!.state, 'submitted');
  assert.equal(f.queued().length, 1);
});
