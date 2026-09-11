import { canonicalSessionId } from './providers.js';

const METHODS = [
  'bridge_connect', 'bridge_sessions_list', 'bridge_status_update',
  'bridge_message_send', 'bridge_messages_read', 'bridge_disconnect',
];
const CLAUDE_PREFIXES = ['mcp__session-bridge__', 'mcp__plugin_session-bridge_session-bridge__'];
const CLAUDE_TOOLS = new Set(CLAUDE_PREFIXES.flatMap(prefix => METHODS.map(method => `${prefix}${method}`)));
const DEVIN_TOOLS = new Set(METHODS.map(method => `mcp__session-bridge__${method}`));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextHook(input: unknown, host: 'claude' | 'devin', tools: Set<string>) {
  if (!record(input) || input.hook_event_name !== 'PreToolUse'
    || typeof input.tool_name !== 'string' || !tools.has(input.tool_name)) return null;
  if (!record(input.tool_input)) throw new Error('Bridge hook requires object tool input.');
  // Native context can change while the MCP process survives; every call replaces prior identity.
  let sessionId: string | null = null;
  if (typeof input.session_id === 'string') {
    try { sessionId = canonicalSessionId(host, input.session_id); }
    catch { /* Clear stale supplied context when the current host identity is invalid. */ }
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...input.tool_input, _sessionId: sessionId },
    },
  };
}

export function claudeContextHook(input: unknown) {
  return contextHook(input, 'claude', CLAUDE_TOOLS);
}

export function devinContextHook(input: unknown) {
  return contextHook(input, 'devin', DEVIN_TOOLS);
}
