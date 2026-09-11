---
name: sessions
description: List this Devin conversation's connected peers and inbox state.
triggers:
  - user
---

Call `bridge_sessions_list({limit: 100})`, following `nextCursor` until all connected peers are returned. Listing is passive; preserve activation state.

Show the current native ID when returned, then each peer's native ID/provider, connection state, receiver state/transport/`idleWakeAvailable`, latest status with its timestamp, and inbox unread/pending-request counts and notification state. Status is a dated self-report; connection and receiver fields do not prove model activity. Tokens are intentionally absent from status.

If activation is required, keep any retained peers visible and explain `/session-bridge:connect PEER_NATIVE_ID`. This command requires a selected peer to activate Devin. Do not create a placeholder connection or read messages merely to list sessions.

Devin's hook receiver has unknown availability and cannot wake an already-idle conversation. Messages can be collected after tool completion, at the next user prompt, or by an explicit inbox read. For requested message handling, use the shared [Session Bridge workflow](../../skills/session-bridge/SKILL.md).
