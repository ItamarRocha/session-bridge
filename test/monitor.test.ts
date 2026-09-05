import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startMonitor } from '../src/monitor.js';
import { Store } from '../src/store.js';

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
