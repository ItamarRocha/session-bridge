import { basename } from 'node:path';
import { Store } from './store.js';
import { messageNotice } from './transport.js';

export interface MonitorOptions {
  pollIntervalMs?: number;
  outputTimeoutMs?: number;
}

export async function startMonitor(
  home: string,
  label: string,
  output: (line: string) => void | Promise<void>,
  sessionId?: string,
  options: MonitorOptions = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const outputTimeoutMs = options.outputTimeoutMs ?? 2_000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000
    || !Number.isInteger(outputTimeoutMs) || outputTimeoutMs < 1 || outputTimeoutMs > 2_000) {
    throw new Error('Monitor intervals must be positive; polling is at most 1s and output waits at most 2s.');
  }
  const store = new Store(home);
  let receiver: ReturnType<Store['acquireReceiver']> | undefined;
  let poll: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const abort = new AbortController();
  let resolveDone!: () => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  // Lifecycle observation is optional; awaiting done still reports the original failure.
  void done.catch(() => {});
  const close = (failure?: unknown) => closing ??= (async () => {
    closed = true;
    clearTimeout(poll);
    clearInterval(heartbeat);
    abort.abort();
    let cleanupError: unknown;
    try { if (receiver) store.releaseReceiver(receiver.peer.id, receiver.ownerToken); }
    catch (error) { cleanupError = error; }
    try { store.close(); } catch (error) { cleanupError ??= error; }
    if (failure !== undefined || cleanupError !== undefined) rejectDone(failure ?? cleanupError);
    else resolveDone();
    if (cleanupError !== undefined) throw cleanupError;
  })();
  const stop = (failure?: unknown) => { void close(failure).catch(() => {}); };
  const write = async (line: string) => {
    if (closed) return;
    let timeout: NodeJS.Timeout | undefined;
    let cancel!: () => void;
    try {
      await Promise.race([
        Promise.resolve().then(() => { if (!closed) return output(line); }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Monitor output did not complete before its deadline.')), outputTimeoutMs);
          cancel = () => reject(new Error('Monitor is closed.'));
          abort.signal.addEventListener('abort', cancel, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      abort.signal.removeEventListener('abort', cancel);
    }
  };
  try {
    receiver = store.acquireReceiver({
      label: label || `Claude (${basename(process.cwd())})`, nativeSessionId: sessionId,
    });
    const { peer, ownerToken, ticket } = receiver;
    heartbeat = setInterval(() => {
      if (closed) return;
      try { if (!store.renewReceiver(peer.id, ownerToken)) stop(); }
      catch (error) { stop(error); }
    }, 1_000);
    await write(sessionId
      ? `Session Bridge receiver ready for Claude session ${sessionId}. Call bridge_connect with the native session ID selected by the user. Connecting permits messages; work follows this session's existing scope and permissions.`
      : `Session Bridge monitor ready. Your shareable peer ID is ${peer.id}. Bind this session's MCP tools by calling bridge_attach with ${JSON.stringify({ ticket })}. Keep the ticket in this session; share only the peer ID. Pairing alone does not authorize tasks from another agent.`);
    const check = async () => {
      if (closed) return;
      try {
        for (let count = 0; count < 20 && !closed; count++) {
          const message = store.pendingNotifications(peer.id, ownerToken, 1)[0];
          if (!message) break;
          await write(messageNotice(message, home, peer));
          if (closed) return;
          if (!store.markNotified(peer.id, ownerToken, message.id) && !store.renewReceiver(peer.id, ownerToken)) {
            stop();
            return;
          }
        }
        if (!closed) poll = setTimeout(() => { void check(); }, pollIntervalMs);
      } catch (error) { if (!closed) stop(error); }
    };
    if (!closed) poll = setTimeout(() => { void check(); }, 0);
    return { peer, close: () => close(), done };
  } catch (error) {
    try { await close(error); } catch { /* Preserve the startup failure after releasing resources. */ }
    throw error;
  }
}
