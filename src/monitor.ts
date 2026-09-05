import { basename } from 'node:path';
import { Store } from './store.js';
import { newSocketPath } from './paths.js';
import { listenForNotices, messageNotice } from './transport.js';
import type { Peer } from './types.js';

export async function startMonitor(home: string, label: string, output: (line: string) => void) {
  const store = new Store(home);
  let peer: Peer | undefined;
  let listener: Awaited<ReturnType<typeof listenForNotices>> | undefined;
  let check: NodeJS.Timeout | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    closed = true;
    clearInterval(check);
    try {
      if (peer) store.closePeer(peer.id);
    } finally {
      try { await listener?.close(); } finally { store.close(); }
    }
  })();
  const seen = new Map<string, number>();
  try {
    const created = store.createPeer({ host: 'claude', label: label || `Claude (${basename(process.cwd())})` });
    peer = created.peer;
    const ownPeer = peer;
    const path = newSocketPath(home);
    listener = await listenForNotices(path, (id) => {
      const current = store.peer(ownPeer.id);
      if (closed || current.closedAt !== null) throw new Error('Bridge attachment is closed.');
      const message = store.message(ownPeer.id, id);
      if (message.to !== ownPeer.id || message.expiresAt <= Date.now() || message.cancelledAt !== null) {
        throw new Error('Message is not eligible for this monitor.');
      }
      const pairing = store.pairings(ownPeer.id).find(p => p.id === message.pairingId);
      if (!pairing || pairing.closedAt !== null) throw new Error('Pairing is disconnected.');
      if (message.acknowledgedAt !== null || seen.has(id)) return;
      output(messageNotice(message, home));
      seen.set(id, message.expiresAt);
    });
    store.setEndpoint(peer.id, path);
    output(`Session Bridge monitor ready. Your shareable peer ID is ${peer.id}. Bind this session's MCP tools by calling bridge_attach with ${JSON.stringify({ ticket: created.ticket })}. Keep the ticket in this session; share only the peer ID. Pairing alone does not authorize tasks from another agent.`);
    check = setInterval(() => {
      try {
        for (const [id, expiresAt] of seen) if (expiresAt <= Date.now()) seen.delete(id);
        if (store.peer(ownPeer.id).closedAt !== null) void close().catch(() => {});
      } catch { void close().catch(() => {}); }
    }, 1_000);
    return { peer, close };
  } catch (error) {
    try { await close(); } catch { /* Preserve the startup failure after releasing resources. */ }
    throw error;
  }
}
