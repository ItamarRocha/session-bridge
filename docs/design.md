# Design

## Existing conversations connected by messages

The bridge moves selected messages between existing conversations. Each session can connect to several peers, including peers of the same provider. It has no model credentials, inference client or session-spawning API. Goals, tasks and collaboration decisions remain in the clients. The bridge owns connections, durable messages and a short self-status. [Six-method interface](plugin-methods.md)

```mermaid
flowchart LR
  C[Existing Codex task] -->|CLI or six MCP methods| L[(Local SQLite ledger)]
  A[Existing Claude session] -->|Six MCP methods| L
  L -->|Codex queue helper| C
  L -->|Native Monitor stdout| A
```

The ledger owns registrations, connection edges, message IDs, expiry, receipts and replies. The `Sessions` facade resolves native identities and exposes the six methods over the existing ledger and adapters. Transport notifications carry a reference to a stored message; the receiver reads that record before acting.

## Native identity and connections

Public addresses are native UUIDs with optional `codex:` / `claude:` prefixes. Known bare UUIDs resolve from local registrations. An unknown bare UUID requires provider clarification; only explicit `codex:UUID` can create a provisional Codex recipient. Connecting is silent. The first send can notify that Codex task, whose targeted eligible read binds it from its own native context without a reciprocal connect.

Codex supplies current identity in `_meta.threadId` per MCP call, or `CODEX_THREAD_ID` in the task's own CLI shell. Claude's hook supplies its current `session_id` per call; its explicit activation command starts a receiver using current skill substitution. A stale MCP startup environment does not identify a new Claude conversation. [Codex MCP source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/mcp_tool_call.rs#L506), [Claude hook input](https://code.claude.com/docs/en/hooks#common-input-fields)

Connection edges are explicit and non-transitive. A–B and A–C permit those pairs to exchange messages; they do not connect B–C. `bridge_sessions_list` projects only the invoking session's connected peers. `bridge_disconnect` closes one edge without closing other peers or native sessions.

## Host adapters

**Codex:** the adapter invokes `codex queue --thread <UUID> --message <notification>` with an argument array and ordinary Codex home/configuration. The owning client decides when to consume the item. Unloaded or paused tasks can leave it queued. The adapter does not start another app server or resume the target. Queue writes require access to native Codex storage, including the caller's normal sandbox permission flow when invoked from a task shell. [Published queue source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs)

**Claude Code:** `/session-bridge:connect` explicitly starts Claude's native `Monitor` tool running the bridge receiver with the current native session ID. The receiver owns a local endpoint and emits stored-message references to its owning conversation through stdout. It binds its own registration internally; the normal six-method workflow needs no private ticket exchange. There is no automatically started monitor declaration. [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool), [skill substitutions](https://code.claude.com/docs/en/skills#available-string-substitutions)

The helpers share the ledger without a central coordination daemon. MCP stdout is protocol-only; monitor stdout carries notifications; diagnostics use stderr. Native model consumption and wake timing require [live validation](live-validation.md).

## Scope and authority

A connection permits messages between selected sessions. It does not grant broader execution, publication, spending or native permission authority. Each request states enough scope for the receiver to evaluate it against the user's task. Status is a self-published one-liner with an update timestamp, not a task assignment or verified activity signal.

The shared skill supplies delegation, handoff acceptance, snapshot-bound review and continuation instructions. Native goals or conversation state retain the plan and pending dependencies. There is no bridge goal table, work engine, review subscription, scheduler or cross-agent permission supervisor.

The CLI is a local operator interface. Processes with access to this OS account and bridge files already have that authority; native context guards accidental session mix-ups, not mutually untrusted processes under the same account.

## Message lifecycle

| Field or state | Meaning |
| --- | --- |
| `stored` | The ledger has the message; submission has not completed. |
| `dispatching` | An adapter attempt has started. |
| `submitted` | The adapter reports handing off the notification. |
| `unknown` | An attempt may have reached the destination; inspect before retrying. |
| `acknowledgedAt` | The destination recorded an incoming receipt. |
| `answeredBy` | One recorded substantive reply answers the request. |
| `cancelledAt` / `expiresAt` | The request is no longer eligible for new work. |

Idempotency keys deduplicate local creation. They cannot make native queue delivery or external actions exactly-once. An adapter crash after submission can leave an uncertain result, so the bridge never automatically retries uncertain delivery.

Receipt tokens remain inside the facade. Repeated reads expose prior receipt and reply evidence so the agent can inspect earlier work. Incoming history includes already-read entries; blocked receipts return `actionable: false` and a reason. Selecting an authorized sent message is read-only. A receipt establishes neither work acceptance nor completion.

The default receipt lease is 30 minutes, capped by message expiry. An expired receipt cannot be reclaimed automatically. Cancellation, expiry and disconnection fence new claims and replies; they cannot retract native notifications or undo actions. Recovery requires inspecting what happened before sending a new authorized request.

Only a request can receive one substantive reply. Informational notices and replies are terminal. Use an informational notice for handoff acceptance before the final result; it leaves the request's substantive reply available. Receipts do not wake the sender, preventing acknowledgment-only loops in the transport contract.

## Data and extension boundaries

The ledger stores selected message bodies and metadata locally. It does not scan transcripts, synchronize native task databases, read provider credentials or use proprietary client inbox protocols. Message text can still disclose selected content to the receiving model provider.

New delivery adapters must preserve explicit identity, connection checks and submission uncertainty. Remote relays and actual cloud-session routing are outside this local version. A native UUID is an address within the configured local bridge, not a network route.

The default catalog has six methods; `--legacy-tools` selects the old catalog only for the v0.2 migration window. Legacy CLI operations retain diagnostics, exceptional cancellation and full receiver shutdown. [Operator recovery](support.md#operator-recovery)
