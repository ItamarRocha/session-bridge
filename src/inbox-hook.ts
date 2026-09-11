import { canonicalSessionId } from './providers.js';
import { inboxNotice } from './transport.js';
import type { StoreContract } from './types.js';

interface HookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
}

/** Hooks observe an explicitly connected session; they never enroll a new one. */
export async function runDevinInboxHook(input: unknown, store: StoreContract, write: (output: HookOutput) => Promise<void>): Promise<boolean> {
  if (!input || typeof input !== 'object' || !('hook_event_name' in input) || !('session_id' in input)) return false;
  const event = input.hook_event_name;
  if (event !== 'PostToolUse' && event !== 'UserPromptSubmit') return false;
  let sessionId: string;
  try { sessionId = canonicalSessionId('devin', input.session_id); } catch { return false; }
  const peer = store.findNativePeer(sessionId, 'devin');
  if (!peer || peer.attachedAt === null || peer.closedAt !== null) return false;
  const notification = store.reserveNotification(peer.id);
  if (!notification || !store.beginNotificationDelivery(notification.id)) return false;
  try {
    await write({hookSpecificOutput: {
      hookEventName: event, additionalContext: inboxNotice(notification, store.home, store.peer(notification.to)),
    }});
    store.finishNotificationDelivery(notification.id, {
      state: 'submitted', detail: 'Devin hook output written; model receipt is pending. Idle wake-up is unavailable.',
    });
    return true;
  } catch (error) {
    store.finishNotificationDelivery(notification.id, {
      state: 'unknown', detail: 'Devin hook output was not confirmed; delivery may have happened. No automatic retry.',
    });
    throw error;
  }
}
