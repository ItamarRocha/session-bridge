import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.js';

for (const phase of ['startup', 'notification'] as const) {
  test(`a stalled stdout reader cannot keep a CLI receiver alive during ${phase}`, { timeout: 6_000 }, async t => {
    const home = mkdtempSync(join(tmpdir(), 'sb-monitor-output-'));
    const nativeId = randomUUID();
    let messageId: string | undefined;
    if (phase === 'notification') {
      const store = new Store(home);
      try {
        const sender = store.ensureCodexPeer({ nativeSessionId: randomUUID() });
        const recipient = store.createPeer({ host: 'claude', nativeSessionId: nativeId, label: 'Receiver' }).peer;
        store.pair(sender.id, recipient.id);
        messageId = store.send(sender.id, { to: recipient.id, body: 'Check this queued request.', idempotencyKey: 'queued-request' }).id;
      } finally { store.close(); }
    }
    // An unread pipe must be blocked either before readiness or after that first write completes.
    const preload = phase === 'startup' ? 'process.stdout.write(Buffer.alloc(1024*1024))' : `
      const write = process.stdout.write.bind(process.stdout);
      let ready = false;
      process.stdout.write = (chunk, callback) => write(chunk, error => {
        callback?.(error);
        if (!ready) {
          ready = true;
          process.stderr.write('test reader stopped after readiness\\n');
          write(Buffer.alloc(1024*1024));
        }
      });
    `;
    const child = spawn(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(preload)}`,
      'dist/cli.js', 'monitor', '--home', home, '--session-id', nativeId,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
      child.stdout.destroy();
      rmSync(home, { recursive: true, force: true });
    });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.equal(signal, null);
    assert.match(stderr, /Monitor output did not complete before its deadline/);
    if (phase === 'notification') assert.match(stderr, /test reader stopped after readiness/);
    const store = new Store(home);
    try {
      const peer = store.findNativePeer(nativeId, 'claude')!;
      assert.equal(store.receiverStatus(peer.id).state, 'unavailable');
      assert.equal(peer.closedAt, null);
      if (messageId) {
        const message = store.message(peer.id, messageId);
        assert.equal(message.delivery, 'stored');
        assert.equal(message.notifiedAt, null);
        assert.equal(message.acknowledgedAt, null);
      }
    } finally { store.close(); }
  });
}
