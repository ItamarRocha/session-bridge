---
name: connect
description: Connect this Devin conversation to a selected coding session.
argument-hint: "PEER_NATIVE_ID"
triggers:
  - user
---

Connect this existing conversation to the peer selected in the user's invocation. Keep the work inline in the current session.

1. Resolve the selected peer from the invocation or the user's explicit selection in this conversation. If none was selected, explain that `bridge_connect` requires a peer native ID and show `/session-bridge:connect PEER_NATIVE_ID`. Finish without activation or a guessed ID.
2. Read the shared [Session Bridge workflow](../../skills/session-bridge/SKILL.md), then call `bridge_connect({sessionId: PEER_NATIVE_ID})`. Use `codex:UUID` for an unregistered Codex task, or a known Claude/Devin native ID. Preserve Devin ID spelling and case; prefer `devin:ID`.
3. Let the plugin's PreToolUse hook supply the caller context. Report missing hook context as a setup problem; caller identity comes from native hook stdin, not a session-ID environment variable or an ID chosen by the model.
4. Report the returned native self ID and connection state. If connected or pending, use the shared workflow for the user's requested exchange. Explain any `activation_required` result for the selected peer. Connecting itself sends no message.

Devin needs no Monitor or receiver process. After activation, its lifecycle hooks provide an opaque inbox notice after tool completion or at the next prompt; only a bridge read records receipt. An already-idle conversation cannot be woken by this adapter. Display that limitation if the user expects unattended delivery.
