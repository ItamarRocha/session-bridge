# Six methods for connecting and messaging

Revised proposal · [Plan](collaboration-v2.md) · [Visual document](collaboration-v2.html)

The model should know who is connected, what they last said they were doing, and how to exchange messages. Goals, tasks, handoffs and reviews use native state and skill instructions. There are no collaboration-specific method groups or hidden workflow engine.

These six names are the intended next interface. The running plugin still has its existing ten-tool catalog; this revision changes the design and collaboration instructions, not the registered tool names.

| Method | Arguments | Result / effect |
| --- | --- | --- |
| `bridge_connect` | `sessionId` | Activate this caller when authorized, invite the selected native session, and return connected/pending/activation-required. Repeated calls reuse the connection. |
| `bridge_sessions_list` | Optional `limit`, `cursor` | Connected-to-caller summaries: native ID, provider, label, connection, status text and timestamp. Read only; no wake or discovery scan. |
| `bridge_status_update` | `text` | Replace this caller's short status. No target ID, assignment, task state or notification. |
| `bridge_message_send` | `sessionId`, `text`, `idempotencyKey`, optional `replyTo`, `expectsReply` | Persist a targeted message or response and return its ID and delivery state. Reuse the key only for the same send. |
| `bridge_messages_read` | Optional `messageId`, `limit`, `cursor` | Return incoming messages by default, or one authorized sent/received message selected by ID. Only incoming reads record receipt; sent-message inspection is read only. Include prior receipt/reply evidence without granting or completing work. |
| `bridge_disconnect` | `sessionId` | Close this caller's connection to the selected peer. Other connections remain; external work is not undone. |

## Keep the callers' job small

- The invoking session is bound by the bridge. There is no caller-supplied `from` identity or status update for another session.
- Native session IDs are the public address. Extra attachment and receipt tokens are implementation details, not IDs the user copies between terminals.
- Inbox reads return enough prior-receipt evidence to avoid blindly repeating side effects after a retry. A receipt means the bridge returned the message, not that the agent accepted or finished a task.
- Sending with `replyTo` replaces the separate public reply operation; it does not create a review/handoff type. The facade must preserve current expiry, participant checks, single-result reply semantics and duplicate-send behavior. A further request starts another bounded exchange.
- A new message expects one result by default. Set `expectsReply: false` for an informational update, such as handoff acceptance, so it neither consumes the final-result reply nor requests a courtesy acknowledgement. With `replyTo`, the response is terminal and `expectsReply: true` is invalid. This maps to the existing request/notice/reply transport.
- Unknown delivery remains unknown until reconciled. Simplifying the interface does not authorize an automatic resend of an uncertain action.

## Status is a one-liner, not a synchronized goal

Store `text`, `updatedAt` and its attributed source (the bound session) on the attachment. Examples: “reviewing the parser change,” “running benchmark B,” “waiting for the user's permission.” Show age/staleness. Do not present an old self-report as verified current execution.

Only update on a meaningful change. Publishing status never starts another model turn. An optional file or native task reference may appear in the text; there is no shared goal ID, work record, task mirror, state transition or completion gate.

## What moves out of the public tool catalog

Attachment and pairing become part of connect. Receipt claiming and claim-token management become part of inbox/read and the bound connection. Reply handling becomes part of send. Message inspection is the same inbox read narrowed by message ID. Full shutdown, exceptional cancellation/recovery and diagnostics stay in existing operator/CLI controls.

The removed goal, goal-control, work, handoff, review, subscription and permission groups are not future phases. Use the [shared skill](../skills/session-bridge/SKILL.md) for collaboration. Automatic native permission approval is omitted; a conversation cannot substitute for the host's permission decision.

## Implementation and compatibility

Reuse the existing Store and delivery adapters. Add only the self-status projection and native identity/connection improvements. Update the MCP facade, CLI help and skill together at the interface revision. Keep existing entry points usable through an explicit migration window; do not advertise both catalogs indefinitely.

Test the six operations as a user journey. Also check that reading/listing does not activate another session, status cannot impersonate a peer, stale status stays stale, retries preserve message identity, and disconnecting one peer preserves other connections. No workflow database or scheduler is needed for these checks.
