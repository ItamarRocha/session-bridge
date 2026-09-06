const METHODS = [
  'bridge_connect', 'bridge_sessions_list', 'bridge_status_update',
  'bridge_message_send', 'bridge_messages_read', 'bridge_disconnect',
];
const PREFIXES = ['mcp__session-bridge__', 'mcp__plugin_session-bridge_session-bridge__'];
const TOOLS = new Set(PREFIXES.flatMap(prefix => METHODS.map(method => `${prefix}${method}`)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function claudeContextHook(input: unknown) {
  if (!record(input) || input.hook_event_name !== 'PreToolUse'
    || typeof input.tool_name !== 'string' || !TOOLS.has(input.tool_name)) return null;
  if (!record(input.tool_input)) throw new Error('Bridge hook requires object tool input.');
  // MCP startup identity survives /clear; the hook supplies this call's current identity.
  const sessionId = typeof input.session_id === 'string' && UUID.test(input.session_id)
    ? input.session_id : null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...input.tool_input, _sessionId: sessionId },
    },
  };
}
