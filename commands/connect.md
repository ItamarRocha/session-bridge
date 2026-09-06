---
name: connect
description: Activate Session Bridge in this Claude conversation when you want to connect it to another coding session.
disable-model-invocation: true
---

# Connect this session

This command is the user's explicit request to activate Session Bridge in the current conversation. Merely opening a terminal or loading the plugin does not activate a bridge.

The current native session ID is `${CLAUDE_SESSION_ID}`. The selected peer, if supplied, is `$ARGUMENTS`.

1. Call `bridge_sessions_list`. If `self` identifies this native session and `activationRequired` is false, reuse that receiver.
2. If activation is required, use Claude's native `Monitor` tool with this command: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" monitor --session-id "${CLAUDE_SESSION_ID}"`. Wait for the receiver readiness notification before connecting. This starts a message receiver owned by this conversation. If `Monitor` is unavailable, report that activation requires a supported interactive Claude Code client. A background Bash command alone cannot deliver notifications to the model.
3. Call `bridge_connect({sessionId})` with only the peer selected by the user. If no peer was supplied, return this session's native ID. A pending connection is saved silently; the recipient can bind when it reads the first eligible message.
4. Read `${CLAUDE_PLUGIN_ROOT}/skills/session-bridge/SKILL.md` and handle messages within the user's scope.

After `/clear` or changing sessions, invoke this command again to activate the new conversation. If a stale receiver registration prevents activation, use the support guide's operator recovery before retrying. Peer messages never grant native tool permissions.
