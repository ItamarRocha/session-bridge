import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMonitor } from '../src/monitor.js';
import { Store } from '../src/store.js';
import { notifyEndpoint } from '../src/transport.js';

test('native monitor binds its selected Claude session without exposing an attachment ticket', async () => {
  const home = mkdtempSync('/tmp/sb-monitor-native-');
  const notices: string[] = [];
  const sessionId = randomUUID();
  const monitor = await startMonitor(home, 'Native Claude', line => notices.push(line), sessionId);
  const store = new Store(home);
  try {
    const peer = store.findNativePeer(sessionId, 'claude')!;
    assert.equal(peer.id, monitor.peer.id);
    assert.notEqual(peer.attachedAt, null);
    assert.ok(peer.endpoint);
    assert.match(notices[0]!, new RegExp(sessionId));
    assert.doesNotMatch(notices[0]!, /sbt_|sb_|bridge_attach/);
    await assert.rejects(startMonitor(home, 'Duplicate', () => {}, sessionId), /already has an active peer/);
    assert.equal(store.peer(peer.id).closedAt, null);

    const sender = store.createPeer({ host: 'codex', label: 'Selected sender', nativeSessionId: randomUUID() });
    store.attach(sender.ticket);
    store.pair(sender.peer.id, peer.id);
    const message = store.send(sender.peer.id, { to: peer.id, body: 'Bounded test request', idempotencyKey: 'native-monitor-test' });
    assert.equal((await notifyEndpoint(peer.endpoint!, message.id)).state, 'submitted');
    assert.match(notices[1]!, new RegExp(message.id));
    assert.equal((await notifyEndpoint(peer.endpoint!, message.id)).state, 'submitted');
    assert.equal(notices.length, 2);
    await monitor.close();
    assert.notEqual(store.peer(peer.id).closedAt, null);
    assert.equal(existsSync(peer.endpoint!), false);
  } finally {
    await monitor.close();
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('failed monitor startup closes its registration and owned resources', async () => {
  const home = mkdtempSync('/tmp/sb-monitor-fail-');
  try {
    const ipc = join(home, 'ipc');
    mkdirSync(ipc, { mode: 0o755 });
    chmodSync(ipc, 0o755);
    await assert.rejects(startMonitor(home, 'Failed endpoint', () => {}), /private/);
    let store = new Store(home);
    assert.deepEqual(store.peers(), []);
    store.close();
    chmodSync(ipc, 0o700);
    await assert.rejects(startMonitor(home, 'Broken stdout', () => { throw new Error('output closed'); }), /output closed/);
    store = new Store(home);
    assert.deepEqual(store.peers(), []);
    store.close();
    assert.deepEqual(readdirSync(ipc), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('monitor releases its socket even if marking its peer closed fails', async t => {
  const home = mkdtempSync('/tmp/sb-monitor-close-');
  try {
    const monitor = await startMonitor(home, 'Cleanup fault', () => {});
    const store = new Store(home);
    const path = store.peer(monitor.peer.id).endpoint!;
    store.close();
    const original = Store.prototype.closePeer;
    const mock = t.mock.method(Store.prototype, 'closePeer', () => { throw new Error('database unavailable'); });
    await assert.rejects(monitor.close(), /database unavailable/);
    assert.equal(existsSync(path), false);
    await assert.rejects(monitor.close(), /database unavailable/);
    mock.mock.restore();
    const reopened = new Store(home);
    original.call(reopened, monitor.peer.id);
    reopened.close();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
