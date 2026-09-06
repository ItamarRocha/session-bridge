# Six methods for connecting and messaging

Implemented interface · [Design](collaboration-v2.md) · [Visual guide](collaboration-v2.html) · [Live validation](live-validation.md)

The default MCP catalog exposes these six methods. Goals, tasks, handoffs and reviews use native state and the [shared skill](../skills/session-bridge/SKILL.md). There is no collaboration-specific method group or hidden workflow engine.

| Method | Arguments | Result / effect |
| --- | --- | --- |
| `bridge_connect` | `sessionId` | Connect this caller to the selected native session. Return `connected`, `pending` or `activation_required`. Repeated calls reuse the edge; connecting sends no notification. |
| `bridge_sessions_list` | Optional `limit`, `cursor` | Return `self`, `activationRequired`, connected-to-caller `sessions` and `nextCursor`. Each summary has native identity, connection, receiver availability and latest self-status. A receiver can require activation while connections remain listed. Read only; no wake or discovery scan. |
| `bridge_status_update` | `text` | Replace this caller's one-line status, up to 512 UTF-8 bytes. Return its updated summary. No target identity, assignment or notification. |
| `bridge_message_send` | `sessionId`, `text`, `idempotencyKey`; optional `replyTo`, `expectsReply` | Persist one targeted message or result and return its ID, `deliveryStage` and delivery evidence. Claude inbox persistence does not require a running receiver. Text is limited to 32 KiB. Reuse the key only with identical input. |
| `bridge_messages_read` | Optional `messageId`, `limit`, `cursor` | Return incoming history by default, or one authorized sent/received message selected by ID. Only incoming reads record receipt; sent inspection is read-only. |
| `bridge_disconnect` | `sessionId` | Close this caller's connection to one peer in both directions. Return whether a connection was closed. Other peers and native sessions remain unchanged. |

## Native identity and connection

Public addresses are native UUIDs, optionally prefixed `codex:` or `claude:`. Known bare UUIDs resolve locally. An unregistered Codex destination requires `codex:UUID`; an unknown bare UUID returns `activation_required` rather than guessing its provider. A never-registered Claude destination must explicitly activate once before native-ID connection. A retained registered target can accept connections and queued messages while its watcher is unavailable; it needs explicit watcher restart for notification.

Connecting to an unregistered Codex task creates a pending local connection. The first send submits a native queue notification. A targeted read of that incoming message binds the recipient from its own native context; no reciprocal connect is required. `pending` means that local recipient attachment has not occurred. `connected` means an attached relationship, not verified current model activity. Native delivery timing remains subject to the owning client. [Codex queue source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs)

The bridge obtains caller identity per call: Codex supplies `_meta.threadId`; Claude's `PreToolUse` hook inserts the current `session_id` in private `_sessionId` plumbing. Models should not supply or override that field. The Codex CLI uses its own shell's `CODEX_THREAD_ID`; Claude CLI calls require a current session ID from the invoking skill or hook. Missing context fails with guidance rather than selecting another session. [Codex MCP source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/mcp_tool_call.rs#L506), [Claude hook input](https://code.claude.com/docs/en/hooks#common-input-fields)

The local ledger is shared under one OS account. Native context prevents accidental session mix-ups; it is not a security boundary against another process with that account's filesystem access.

## Receiver availability

Each session summary includes `receiver: {state, checkedAt, expiresAt, transport}`. State is `available`, `unavailable` or `unknown`; transport is `inbox` for Claude and `native_queue` for Codex. Times are Unix milliseconds or null when unobserved. Claude availability derives from a five-second receiver ownership lease renewed every second. Codex's unobserved native queue owner reports unknown availability rather than pretending to be live.

Connection and receiver are independent. `activationRequired: true` can appear alongside `self` and a nonempty `sessions` list when the current Claude watcher has stopped. Listing preserves that information without restarting anything. Explicit `/session-bridge:connect` starts a persistent native Monitor watcher when required and reuses the same native identity, relationships and history after a crash or ordinary receiver shutdown.

## Messages and receipts

New messages expect one substantive result by default. Set `expectsReply: false` for an informational notice, such as handoff acceptance. To reply, first read the request, then send to its original sender with `replyTo` set to the request ID and a stable result idempotency key. A reply is terminal; `expectsReply: true` is invalid with `replyTo`. Further work starts a new bounded request.

The bridge checks participants, expiry, connection validity and single-result semantics. It manages receipt tokens internally. A notice does not consume the request's final reply. The public `deliveryStage` distinguishes Claude `queued` (stored), `notified` (stdout write completed), `read` (agent read recorded) and `replied` (substantive result). Codex `submitted` is only native queue submission. Low-level delivery/timestamp evidence remains available. Unknown and legacy uncertain delivery is never automatically replayed.

`bridge_messages_read` returns a `messages` array and `nextCursor`. Default history includes previously read incoming messages, rather than just unread items. `previouslyRead`, receipt times and `answeredBy` help the agent inspect prior progress. A returned receipt is not task acceptance or permission to repeat an action. A replacement watcher may notify an eligible unread message again; the same message and receipt prevent that becoming a new assignment. Repeated reads preserve the same receipt; no receipt timer creates a new claim or restarts work. The existing receipt can send its single result until the original request expires, normally after one hour, or is canceled/disconnected.

Bulk history retains entries whose receipt is blocked, with `actionable: false` and `blockedReason`. Selecting a blocked incoming message returns the same non-actionable evidence. A provisional Codex recipient binds only after an eligible targeted read succeeds. Notices, replies and answered requests are not new actionable requests; incorporate useful information without a courtesy response. Selecting a sent message by ID is read-only and cannot claim it.

Both list/read accept a limit of 1–100, default 20, and an opaque cursor. Follow `nextCursor` until it is null to inspect further history. Repeating a page can return existing receipts; it must not cause duplicate external work.

## Self-status

Session summaries include `sessionId`, prefixed `address`, `provider`, `label`, `connection`, `receiver`, and `status`. Status is null until published, otherwise `{text, updatedAt, source: "self_report"}`. Times are Unix milliseconds. Updates are silent and accepted only for the invoking session; there is no target field or native task synchronization.

Show when the text was reported. An old status does not become evidence of “running,” “idle” or “offline.” Update it on meaningful changes of focus, not on every tool call.

## Compatibility and operator controls

The six methods consolidate attachment/pairing and receipt/reply plumbing. `mcp --host codex|claude --legacy-tools` opts into the old ten-method catalog for compatibility; it does not add that catalog to the default six. Old CLI commands remain for diagnostics, exceptional cancellation and full attachment closure. Stop older helpers before upgrading the ledger to v0.3.0 schema 3; older binaries must not share the upgraded ledger. [Operator recovery](support.md#operator-recovery)

The bridge includes no goal, work, handoff, review, subscription or permission methods. Messages and skill instructions express collaboration; actual native tool permissions remain with the host.
