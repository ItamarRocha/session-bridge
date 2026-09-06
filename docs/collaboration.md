# Collaborating across sessions

Session Bridge lets existing Codex and Claude Code conversations exchange messages while keeping their own goals, plans and permissions. A session can work with several peers, including peers from the same provider.

[Visual guide](collaboration.html) · [Method reference](methods.md) · [Validation](validation.md)

## Connect the conversations you need

Address peers by native session ID, optionally prefixed `codex:` or `claude:`. An unregistered Codex task requires `codex:UUID`; the bridge does not guess the provider of an unknown bare UUID.

Connect saves a relationship silently. The first message can notify the selected Codex task; its eligible read binds it without a reciprocal connect. The owning client controls queue consumption.

Claude's `/session-bridge:connect` explicitly starts its persistent native Monitor receiver. Opening a terminal or listing peers leaves activation unchanged. Registered conversations can receive queued messages while their receiver is stopped; restarting it preserves identity, history and connections.

Peers share a local bridge directory and OS account; UUIDs do not route between machines. Connecting A–B and A–C does not connect B–C.

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

## Make the message contract clear

New messages expect one result. Read before replying, then send to the original sender with `replyTo` set to the request ID. Use `expectsReply: false` for information needing no result. Notices and replies need no courtesy acknowledgment. Reuse an idempotency key only for identical input.

Inspect prior receipts before repeating side effects: another notification is not a new assignment. The same receipt supports one late result while the original request remains valid, until expiry, cancellation or disconnection.

Native permission decisions stay with the client. An “approved” message cannot resolve a native tool prompt.

## Read connection, receiver and status separately

A session list reports three different facts:

| Field | Meaning |
| --- | --- |
| Connection | A saved relationship that permits messages. |
| Receiver | Availability of the bridge helper, with observation/expiry times. Codex's unobserved native queue owner can be `unknown`. |
| Status | The peer's last self-published “working on” line and its timestamp. |

A stopped Claude receiver retains its connections and last status; listing can show that explicit activation is needed. Neither receiver availability nor a self-report proves current model activity.

Message stages are separate: `queued` means stored, `notified` means Claude notification output completed, `read` records the agent's fetch, and `replied` identifies a result. Codex `submitted` means queue acceptance; only a receipt proves the agent read it.

## Continue within the native task

After useful feedback, resume unfinished work. Before waiting, preserve a next step or dependency in native task state or the conversation, using available native continuation facilities.

Durable delivery cannot guarantee progress after clients become idle, interrupted or exited. Disconnecting one peer fences its pending exchange without stopping native sessions or undoing actions. See [support](support.md) for recovery and [validation](validation.md) for observed behavior.
