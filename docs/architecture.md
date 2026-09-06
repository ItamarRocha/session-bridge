# Design

## Existing conversations connected by messages

The bridge moves selected messages between existing conversations. Each session can connect to several peers, including peers of the same provider. It has no model credentials, inference client or session-spawning API. Goals, tasks and collaboration decisions remain in the clients. The bridge owns connections, durable messages and a short self-status. [Six-method interface](methods.md)

```mermaid
flowchart LR
  C[Existing Codex task] -->|CLI or six MCP methods| L[(Local SQLite ledger)]
  A[Existing Claude session] -->|Six MCP methods| L
  L -->|Codex queue helper| C
  L -->|Native Monitor stdout| A
```

The ledger owns native session identity, connection edges, durable inboxes, receiver leases, message IDs, expiry, receipts and replies. The `Sessions` facade resolves native identities and exposes the six methods over the existing ledger and adapters. Transport notifications carry a reference to a stored message; the receiver reads that record before acting.

## Native identity and connections

Public addresses are native UUIDs with optional `codex:` / `claude:` prefixes. Known bare UUIDs resolve from local registrations. An unknown bare UUID requires provider clarification; only explicit `codex:UUID` can create a provisional Codex recipient. Connecting is silent. The first send can notify that Codex task, whose targeted eligible read binds it from its own native context without a reciprocal connect.

Codex supplies current identity in `_meta.threadId` per MCP call, or `CODEX_THREAD_ID` in the task's own CLI shell. Claude's hook supplies its current `session_id` per call; its explicit activation command starts a receiver using current skill substitution. A stale MCP startup environment does not identify a new Claude conversation. [Codex MCP source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/mcp_tool_call.rs#L506), [Claude hook input](https://code.claude.com/docs/en/hooks#common-input-fields)

Connection edges are explicit and non-transitive. A–B and A–C permit those pairs to exchange messages; they do not connect B–C. `bridge_sessions_list` projects only the invoking session's connected peers. `bridge_disconnect` closes one edge without closing other peers or native sessions.

## Host adapters

**Codex:** the adapter invokes `codex queue --thread <UUID> --message <notification>` with an argument array and ordinary Codex home/configuration. The owning client decides when to consume the item. Unloaded or paused tasks can leave it queued. The adapter does not start another app server or resume the target. Queue writes require access to native Codex storage, including the caller's normal sandbox permission flow when invoked from a task shell. [Published queue source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs)

**Claude Code:** `/session-bridge:connect` explicitly starts Claude's native `Monitor` tool with `persistent: true`, running the bridge receiver with the current native session ID. The receiver watches the durable SQLite inbox and emits eligible stored-message references through native monitor stdout. Per-message delivery needs no Unix socket or live sender-to-receiver connection. The normal six-method workflow needs no private ticket exchange. Opening a terminal or listing sessions does not start a monitor. [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool), [skill substitutions](https://code.claude.com/docs/en/skills#available-string-substitutions)

A Claude native identity and its history/connections survive receiver exit. A five-second ownership lease, renewed every second, permits one watcher for that identity; release or expiry lets an explicitly started replacement take over without reconnecting peers. This is transport ownership, not a work assignment or model scheduler.

The helpers share the ledger without a central coordination daemon. MCP stdout is protocol-only; monitor stdout carries notifications; diagnostics use stderr. Native model consumption and wake timing require [live validation](validation.md).

## Scope and authority

A connection permits messages between selected sessions. It does not grant broader execution, publication, spending or native permission authority. Each request states enough scope for the receiver to evaluate it against the user's task. Status is a self-published one-liner with an update timestamp. A separate receiver projection reports `state`, `checkedAt`, `expiresAt` and `transport`; a connected peer can have an unavailable receiver. Codex native-queue receiver availability remains unknown when the bridge cannot observe its owner. Neither projection proves model activity or receipt.

The shared skill supplies delegation, handoff acceptance, snapshot-bound review and continuation instructions. Native goals or conversation state retain the plan and pending dependencies. There is no bridge goal table, work engine, review subscription, scheduler or cross-agent permission supervisor.

The CLI is a local operator interface. Processes with access to this OS account and bridge files already have that authority; native context guards accidental session mix-ups, not mutually untrusted processes under the same account.

## Message lifecycle

The public `deliveryStage` separates the observable steps:

| Stage | Evidence |
| --- | --- |
| `queued` | Stored in the durable inbox; no completed native notification yet. |
| `notified` | Claude receiver stdout completed its write callback and the ledger recorded `notifiedAt`. The model has not necessarily read it. |
| `submitted` | Codex's native queue accepted a notification. This does not establish model receipt. |
| `read` | The receiving agent called the read method and recorded `acknowledgedAt`. |
| `replied` | The request has one substantive result identified by `answeredBy`. |
| `uncertain` | Native submission or a legacy delivery has an unresolved outcome. |
| `cancelled` | The request was explicitly canceled before a later stage was recorded. |

Low-level `delivery`, timestamps and cancellation/expiry fields remain available as evidence; stages are a summary, not work ownership or permission grants. Reading records receipt, not acceptance or completion.

A Claude-bound send persists without requiring a running watcher. Once explicitly activated, its receiver emits eligible unread messages. It records notification only after stdout completion. Each receiver generation suppresses duplicate notices; a replacement can notify a still-unread message again. The durable message and receipt remain the same, so the agent inspects prior progress before any repeated external action. An ambiguous write/crash boundary cannot guarantee exactly-once native notification.

Idempotency keys deduplicate message creation. They cannot make external actions exactly-once. Codex delivery and legacy uncertain/dispatching messages are never automatically replayed. The new inbox watcher processes eligible queued messages and its own recorded notifications from an earlier receiver generation; it does not reinterpret legacy uncertain delivery as a fresh send.

Receipt tokens remain internal. Repeated reads return the existing receipt and never allocate a replacement claim. The retired 30-minute `claimExpiresAt` remains only as internal schema-compatibility data; the six-method interface does not expose it. The original request stays authoritative: one late result remains eligible until its expiry, normally one hour from creation, or cancellation/disconnection. Inspecting prior work is required before continuing after a restart. Incoming history includes read and blocked entries; an authorized sent-message inspection is read-only.

Cancellation, expiry and explicit disconnection fence new claims and replies. Receiver exit alone preserves the relationship and inbox. Neither operation can undo external actions or retract an already emitted native notice.

Only a request accepts one substantive reply. Notices and replies are terminal. An informational handoff acceptance leaves the final result available; receipts and terminal replies do not create automatic acknowledgment loops.

## Data and extension boundaries

The ledger stores selected message bodies and metadata locally. It does not scan transcripts, synchronize native task databases, read provider credentials or use proprietary client inbox protocols. Message text can still disclose selected content to the receiving model provider.

New delivery adapters must preserve explicit identity, connection checks and submission uncertainty. Remote relays and actual cloud-session routing are outside this local version. A native UUID is an address within the configured local bridge, not a network route.

The default catalog has six methods; `--legacy-tools` selects the old catalog only for compatibility with the previous interface. Legacy CLI operations retain diagnostics, exceptional cancellation and full receiver shutdown. [Operator recovery](support.md#operator-recovery)
