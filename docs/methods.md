# Six methods for connecting and messaging

Implemented interface · [Design](collaboration.md) · [Visual guide](collaboration.html) · [Live validation](validation.md)

The default MCP catalog exposes these six methods. Goals, tasks, handoffs and reviews use native state and the [shared skill](../skills/session-bridge/SKILL.md). There is no collaboration-specific method group or hidden workflow engine.

| Method | Arguments | Result / effect |
| --- | --- | --- |
| `bridge_connect` | `sessionId` | Connect this caller to the selected native session. Return `connected`, `pending` or `activation_required`. Repeated calls reuse the edge; connecting sends no notification. |
| `bridge_sessions_list` | Optional `limit`, `cursor` | Return `self`, `activationRequired`, connected-to-caller `sessions` and `nextCursor`. Each summary has native identity, connection, receiver availability, inbox counts/notification state and latest self-status. A receiver can require activation while connections remain listed. Read only; no wake or discovery scan. |
| `bridge_status_update` | `text` | Replace this caller's one-line status, up to 512 UTF-8 bytes. Return its updated summary. No target identity, assignment or notification. |
| `bridge_message_send` | `sessionId`, `text`, `idempotencyKey`; optional `replyTo`, `expectsReply` | Persist one targeted message or result and return its ID, `deliveryStage`, legacy delivery evidence and shared `recipientInbox` state. Inbox persistence does not require a running receiver. Text is limited to 32 KiB. Reuse the key only with identical input. |
| `bridge_messages_read` | Optional `messageId`, `limit`, `cursor`, `unreadOnly`, `notificationToken` | Keep incoming history by default; select unread messages with `unreadOnly: true`, or one authorized sent/received message by ID. A delivered notification token consumes one bounded page and reports consumption/replay evidence. Ordinary reads never consume a pending notification. |
| `bridge_disconnect` | `sessionId` | Close this caller's connection to one peer in both directions. Return whether a connection was closed. Other peers and native sessions remain unchanged. |

## Native identity and connection

Public addresses are native IDs prefixed `codex:`, `claude:` or `devin:`. Codex and Claude use UUIDs; Devin IDs are opaque, including word pairs, and preserve case. Known bare IDs resolve locally, with exact matching for Devin. An unregistered Codex destination requires `codex:UUID`; an unknown bare ID returns `activation_required` rather than guessing its provider. A never-registered Claude or Devin destination must explicitly activate once. Devin activation occurs through `bridge_connect` with a selected peer; listing cannot activate it. A retained target can accept queued messages while its receiver is unavailable.

Connecting to an unregistered Codex task creates a pending local connection. The first send submits a native queue notification. An eligible incoming read, including the delivered-token read, binds the recipient from its own native context; no reciprocal connect is required. `pending` means that local recipient attachment has not occurred. `connected` means an attached relationship, not verified current model activity. Native delivery timing remains subject to the owning client. [Codex queue source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs)

The bridge obtains caller identity per call: Codex supplies `_meta.threadId`; Claude and Devin `PreToolUse` hooks supply private current-session context. Models should leave those identity fields to their host hooks. The Codex CLI uses its own shell's `CODEX_THREAD_ID`; Claude CLI calls require a current session ID from the invoking skill or hook. Missing context fails with guidance rather than selecting another session. [Codex MCP source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/mcp_tool_call.rs#L506), [Claude hook input](https://code.claude.com/docs/en/hooks#common-input-fields)

Devin uses native `session_id` from command-hook stdin and validates hook-supplied context for the MCP call. Caller identity comes from that hook payload, not the startup environment; no `DEVIN_SESSION_ID` variable is documented. [Devin command hooks](https://docs.devin.ai/cli/extensibility/hooks/overview#command-hooks)

The local ledger is shared under one OS account. Native context prevents accidental session mix-ups; it is not a security boundary against another process with that account's filesystem access.

## Receiver availability

Each session summary includes `receiver: {state, checkedAt, expiresAt, transport, idleWakeAvailable}`. State is `available`, `unavailable` or `unknown`; times are Unix milliseconds or null when unobserved.

| Host | Transport | `idleWakeAvailable` | Availability |
| --- | --- | --- | --- |
| Codex | `native_queue` | `true` | `unknown`; queue ownership is unobserved. |
| Claude | `inbox` | `true` | A five-second receiver lease renewed every second. |
| Devin | `hooks` | `false` | `unknown`; notices need tool completion or a user prompt. |

Idle-wake capability describes the adapter, not a guarantee that a particular model is running or consuming notifications. An already-idle Devin conversation needs its next prompt or an explicit read.

Connection and receiver are independent. `activationRequired: true` can appear alongside `self` and a nonempty `sessions` list when the current Claude watcher has stopped. Listing preserves that information without restarting anything. Explicit `/session-bridge:connect` starts a persistent native Monitor watcher when required and reuses the same native identity, relationships and history after a crash or ordinary receiver shutdown.

## Inbox notifications

The bridge keeps at most one outstanding wakeup for each native recipient in one bridge directory. Additional messages accumulate in its durable inbox behind that notification. The notification carries an opaque `notificationToken`; it identifies the delivered wakeup, not a task or a new identity.

Read the delivered token with `bridge_messages_read({notificationToken})`, optionally supplying `limit`. The token implies an unread batch: default 20 messages, maximum 100. `messageId` and `cursor` cannot accompany a token. The result is `{messages, nextCursor: null, notification: {consumed, replayed, remaining}, inbox, instruction}`. The first read claims at most one page and permits a later wakeup if unread messages remain. An exact-token replay returns prior receipt evidence with `previouslyRead: true` and `actionable: false`; it cannot claim a fresh page or consume a newer notification.

To recover an unfinished request from a replay, inspect prior work and use ordinary history or an explicit `messageId` read. Manual `unreadOnly` reads, history and selected-message inspection do not consume notification state. A late wakeup can therefore return an empty page after independent reads; it needs no acknowledgment.

`self.inbox`, `sessions[].inbox` and send's `recipientInbox` share this shape:

```text
{ unreadCount, pendingRequestCount,
  notification: { state, createdAt, detail, nativeQueueId } | null }
```

`pendingRequestCount` includes already-read unanswered requests. Notification state is `pending`, `submitting`, `submitted` or `unknown`; it is separate from message receipt and receiver availability. Status deliberately omits the notification token: only the delivered notice supplies it.

A Claude watcher restart can resume a never-started `pending` notification. `submitting`, `submitted` and `unknown` notifications stay outstanding without re-emission, preserving uncertainty. Inspect inbox state and recover stored work through ordinary unread/history reads; do not manufacture a token from status or force a new wakeup with a new message key. Native backlog cannot be recalled.

Devin's `PostToolUse` and `UserPromptSubmit` hooks can deliver one coalesced token notice after explicit activation. Hook execution alone records no message receipt and emits no peer message body. Inactive hooks stay silent; no `SessionStart` enrollment or `Stop` continuation loop is installed. Hooks leave older ledgers unchanged, and Devin MCP opens its ledger lazily; an explicit connect can initialize or migrate it after the operator completes the upgrade steps. [Devin lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks)

Use status updates for routine progress. Every send, including an informational notice, is eligible to notify its recipient; reserve messages for meaningful questions, blockers, actionable findings and results/handoffs.

## Messages and receipts

New messages expect one substantive result by default. Set `expectsReply: false` for an informational notice, such as handoff acceptance. To reply, first read the request, then send to its original sender with `replyTo` set to the request ID and a stable result idempotency key. A reply is terminal; `expectsReply: true` is invalid with `replyTo`. Further work starts a new bounded request.

The bridge checks participants, expiry, connection validity and single-result semantics. It manages receipt tokens internally. A notice does not consume the request's final reply. For new batched delivery, a message remains `queued` until its agent read, then becomes `read` or `replied`. Shared notification submission lives in `recipientInbox`, not the individual message. Existing legacy delivery/timestamp evidence, including `notified` or `submitted`, remains readable. Unknown and legacy uncertain delivery is never automatically replayed.

`bridge_messages_read` returns a `messages` array and `nextCursor`. Default history includes previously read incoming messages. Set `unreadOnly: true` for unread inspection; use ordinary history or `messageId` to recover an already-read unanswered request. `previouslyRead`, receipt times and `answeredBy` help the agent inspect prior progress. A returned receipt is not task acceptance or permission to repeat an action. An outstanding notification survives watcher restart without retrying a submission already started. Existing message/receipt identity and token replay evidence prevent duplicate handling from becoming a new assignment. Repeated reads preserve the same receipt; no receipt timer creates a new claim or restarts work. The existing receipt can send its single result until the original request expires, normally after one hour, or is canceled/disconnected.

Bulk history retains entries whose receipt is blocked, with `actionable: false` and `blockedReason`. Selecting a blocked incoming message returns the same non-actionable evidence. A provisional Codex recipient binds only after an eligible incoming read succeeds, including a delivered-token read. Notices, replies and answered requests are not new actionable requests; incorporate useful information without a courtesy response. Selecting a sent message by ID is read-only and cannot claim it. `messageId` cannot be combined with `cursor` or `unreadOnly: true`.

Both list/read accept a limit of 1–100, default 20, and an opaque cursor. Follow `nextCursor` to inspect further ordinary history. A notification token handles only its bounded page; unread remainder can trigger a later notification. Repeating a page can return existing receipts; it must not cause duplicate external work.

## Self-status

Session summaries include `sessionId`, prefixed `address`, `provider`, `label`, `connection`, `receiver`, `inbox`, and `status`. Status is null until published, otherwise `{text, updatedAt, source: "self_report"}`. Times are Unix milliseconds. Updates are silent and accepted only for the invoking session; there is no target field or native task synchronization.

Show when the text was reported. An old status does not become evidence of “running,” “idle” or “offline.” Update it on meaningful changes of focus, not on every tool call.

## Compatibility and operator controls

The six methods consolidate attachment/pairing and receipt/reply plumbing. `mcp --host codex|claude --legacy-tools` opts into the old ten-method catalog for compatibility; it does not add that catalog to the default six. Old CLI commands remain for diagnostics, exceptional cancellation and full attachment closure. Stop older helpers before upgrading the ledger to v0.5.0 schema 5; older binaries must not share the upgraded ledger. [Operator recovery](support.md#operator-recovery)

The bridge includes no goal, work, handoff, review, subscription or permission methods. Messages and skill instructions express collaboration; actual native tool permissions remain with the host.
