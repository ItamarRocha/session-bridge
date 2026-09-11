# Collaborating across sessions

Session Bridge lets existing Codex, Claude Code and Devin CLI conversations exchange messages while keeping their own goals, plans and permissions. A session can work with several peers, including peers from the same provider.

[Visual guide](collaboration.html) · [Method reference](methods.md) · [Validation](validation.md)

## Connect the conversations you need

Address peers by native session ID with `codex:`, `claude:` or `devin:` prefixes. Preserve Devin IDs exactly, including case. An unregistered Codex task requires `codex:UUID`; the bridge does not guess the provider of an unknown bare ID.

Connect saves a relationship silently. The first message can notify the selected Codex task; its eligible read binds it without a reciprocal connect. The owning client controls queue consumption.

Claude's `/session-bridge:connect` explicitly starts its persistent native Monitor receiver. Opening a terminal or listing peers leaves activation unchanged. Registered conversations can receive queued messages while their receiver is stopped; restarting it preserves identity, history and connections.

Devin's `/session-bridge:connect PEER_NATIVE_ID` activates and pairs the current conversation; it requires a selected peer. Its hooks collect inbox notices after tool completion or at the next prompt. An already-idle Devin needs a later prompt or explicit read, so factor that limit into a handoff. Opening a terminal or listing peers does not activate it.

Peers share a local bridge directory and OS account; native IDs do not route between machines. Connecting A–B and A–C does not connect B–C.

## Six methods

| Method | Use it to… |
| --- | --- |
| `bridge_connect` | Connect to one selected native session. |
| `bridge_sessions_list` | See your connected peers, receiver availability and latest status. |
| `bridge_status_update` | Publish your own short “working on” line. |
| `bridge_message_send` | Send a bounded request, informational update or result. |
| `bridge_messages_read` | Read incoming messages or inspect an exchange. |
| `bridge_disconnect` | Close one connection while retaining the others. |

The [shared skill](../skills/session-bridge/SKILL.md) supplies collaboration instructions. Each client keeps its plan in the native task facilities available to it, or in the conversation.

## Choose a useful exchange

### Delegate and continue

> Run benchmark B at this commit and return the measurements and commands. Leave source files unchanged. I’ll prepare the comparison while you run it.

Specify the result, snapshot and execution scope. Keep the dependency in your own plan and continue independent work. The recipient reads the request and returns one substantive result for you to incorporate.

### Hand off responsibility

> Can you take the parser fix from this checkpoint? The remaining work is the failing case and its regression test. I’ll retain responsibility until you accept.

Retain responsibility until the peer accepts explicitly. Send early acceptance with `expectsReply: false`, leaving the request's final reply available for the result. A receipt alone is not acceptance.

### Review while building

> Review this commit for the identity bug. Return findings with evidence. I’ll continue the unrelated tests while you inspect it.

Review the named snapshot while the author continues independent work. Check returned findings against the current version. Ongoing review uses a fresh bounded request at each meaningful checkpoint.

## Keep useful signals clear

Publish routine progress through `bridge_status_update`: “running tests” or “still reviewing” should not wake another model. Send messages for a question, blocker, newly actionable finding, or final result/handoff. An informational notice can still wake its recipient; `expectsReply: false` removes the reply expectation, not notification.

## Make the message contract clear

New messages expect one result. Read before replying, then send to the original sender with `replyTo` set to the request ID. Use `expectsReply: false` for information needing no result. Notices and replies need no courtesy acknowledgment. Reuse an idempotency key only for identical input.

Several incoming messages share one outstanding inbox notification per recipient and bridge directory. Handle its opaque token with the read method to consume a bounded page; ordinary polling does not clear a native wakeup still waiting to arrive. More unread messages can produce a later notification.

Inspect prior receipts and results before repeating side effects: another notification is not a new assignment. The same receipt supports one late result while the original request remains valid, until expiry, cancellation or disconnection.

Native permission decisions stay with the client. An “approved” message cannot resolve a native tool prompt.

## Read connection, receiver and status separately

A session list separates saved connections, receiver availability, self-status and inbox state:

| Field | Meaning |
| --- | --- |
| Connection | A saved relationship that permits messages. |
| Receiver | Transport, availability and observation/expiry times. `idleWakeAvailable` is false for Devin; its hook receiver and Codex's unobserved queue owner report `unknown`. |
| Status | The peer's last self-published “working on” line and its timestamp. |
| Inbox | `unreadCount`, `pendingRequestCount` and notification state. Pending requests include already-read work awaiting a result. |

A stopped Claude receiver retains its connections and last status; listing can show that explicit activation is needed. Neither receiver availability nor a self-report proves current model activity.

New messages remain `queued` until read, then become `read` or `replied`. Shared notification submission is reported separately in the inbox. A submitted wakeup does not prove any message was read. On receiver restart, notifications whose submission already started are not re-emitted; inspect their state and use ordinary history/unread reads to recover stored work.

## Continue within the native task

After useful feedback, resume unfinished work. Before waiting, preserve a next step or dependency in native task state or the conversation, using available native continuation facilities.

Durable delivery cannot guarantee progress after clients become idle, interrupted or exited. Disconnecting one peer fences its pending exchange without stopping native sessions or undoing actions. See [support](support.md) for recovery and [validation](validation.md) for observed behavior.
