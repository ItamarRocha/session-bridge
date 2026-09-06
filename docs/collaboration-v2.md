# Session Bridge: messages between existing sessions

Implemented design · 2026-09-05 · [Visual document](collaboration-v2.html) · [Six-method interface](plugin-methods.md)

**The bridge connects sessions and carries messages. The agents manage their work.** Use each client's existing goals, tasks and conversation state. There is no bridge goal, work queue, review object, ownership engine or collaboration scheduler.

The six-method interface, native-ID connections, self-status and explicit Claude receiver activation are implemented. v0.3.0 adds durable inbox watching, receiver availability and native-identity continuity across receiver restarts without changing those six methods. Native client acceptance is tracked separately in the [live validation record](live-validation.md); automated transport checks alone do not prove the agent journey.

## What belongs where

| Agent and native client | Session Bridge |
| --- | --- |
| Goals, plans, tasks and completion decisions | Identity and explicit connections |
| Deciding who handles which part | Sending and receiving selected messages |
| Handoffs and review requests expressed in messages | Durable message storage, deduplication and receipts |
| Continuing independent work; remembering a pending reply | A short status published by each session |
| Native waiting, resumption and permission handling | Delivery through the existing client adapters |

The bridge has no workflow tables, state machines, scheduler, work leases, review subscriptions or policy engine. Message receipt leases remain transport bookkeeping; they do not assign ownership of work.

## Six methods

| Method | Purpose |
| --- | --- |
| `bridge_connect` | Connect to a selected native session ID. |
| `bridge_sessions_list` | List sessions connected to this caller and their latest status one-liners. |
| `bridge_status_update` | Publish this session's own short “working on” statement. |
| `bridge_message_send` | Send a message or reply to one connected session. |
| `bridge_messages_read` | Read incoming messages or inspect a selected exchange and its receipt metadata. |
| `bridge_disconnect` | Disconnect from a selected session. |

Attachment tickets, receipt tokens and provider routing stay inside the implementation. The public interface does not ask models to operate a transport state machine. Installation and full shutdown remain normal plugin/operator controls.

## What a session list shows

Each row contains native ID, provider, label, connection state, receiver availability and the latest self-published status with a timestamp. For example: **“Claude · connected · running benchmark B · updated 2 minutes ago.”** A short update can mention a file or native task when useful; it does not create a shared work record.

Status updates are silent metadata changes. They do not wake other models or become assignments. The timestamp shows when a status was reported; callers can display its age. An old report does not prove the model is running, idle or offline. The bridge does not scan transcripts or synchronize native task databases to reconstruct status.

Receiver availability is separate from both connection and self-status. A stopped Claude watcher leaves connections/history visible and reports that explicit activation is required. A five-second receiver lease tracks the helper, not model activity. Codex's unobserved native queue owner reports unknown availability. Listing never starts or restarts a watcher.

Native goal/task facilities are not a common cross-provider interface. Use what the current client actually exposes; otherwise preserve the plan and pending response in its conversation. Claude's documented task tools are conditional on model/configuration, so even native task-tool availability should not be assumed universally. [Claude task tool availability](https://code.claude.com/docs/en/tools-reference#task-tool-availability)

## Collaboration is an instruction convention

The [shared skill](../skills/session-bridge/SKILL.md) supplies the behavior:

- **Delegate:** request a bounded result and state the execution/file scope. Continue independent authorized work while the peer handles it.
- **Handoff:** explain what remains and obtain an explicit acceptance before assuming responsibility moved. A transport receipt is not acceptance.
- **Review while building:** name the commit or snapshot being reviewed. The author continues independent work and evaluates returned findings against the current version.
- **Ongoing feedback:** send another message at a meaningful checkpoint when it needs a fresh review. No subscription API or scheduled model polling.
- **Continue:** incorporate a peer's result into the original task and resume the next useful step. Use native waiting/continuation facilities where available; preserve a clear dependency if blocked.
- **Stop:** follow the user's scope and native task completion, pause and approval rules. Do not send courtesy acknowledgements that produce a reply loop.

These are model behaviors, not transactional guarantees. This simpler bridge does not guarantee that two idle, interrupted or exited clients will resume themselves. It retains messages and delivers through the supported native mechanisms; native execution and the agents' instructions determine continuation. If a real experiment reveals a specific gap, address that gap rather than adding a second task manager in advance.

## Multiple peers and one-sided setup

One session can connect to many others, regardless of provider. Connections stay explicit; A–B and A–C do not silently establish B–C. Disconnecting one peer leaves other connections intact. Local automated checks exercise this topology; native multi-session evidence is recorded separately.

Native UUIDs are the public address, with optional `codex:` or `claude:` prefixes. Known bare IDs resolve locally. An unregistered Codex target requires `codex:UUID`; unknown bare IDs return `activation_required` rather than guessing their provider. Claude uses fresh hook `session_id` for each MCP call and the current skill ID for explicit receiver startup. Codex supplies current `_meta.threadId`, or its task shell supplies `CODEX_THREAD_ID`. [Claude hook input](https://code.claude.com/docs/en/hooks#common-input-fields), [Codex MCP source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/mcp_tool_call.rs#L506)

Connecting to an unregistered Codex task silently saves a pending edge. The first send queues a notification; an eligible targeted read binds that existing task from its own context without a reciprocal connect. A pending relationship is not evidence of offline status. Delivery requires the owning client to consume its queue and the helper to have access to native queue storage. A dormant Claude receiver still needs `/session-bridge:connect`; opening a terminal leaves it dormant. That command starts a native Monitor with `persistent: true`. Its SQLite inbox survives receiver loss, and restarting the same native conversation retains connections and history. [Codex queue source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs), [Claude Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool)

Actual remote/cloud transport is outside this local version. A session UUID alone is not a route between machines.

## Permissions stay native

Permission methods and automatic cross-agent approval are outside this version. Agents may discuss an action, but an “approved” chat message does not approve a blocked tool. Implementing that later would need a real, explicitly authorized native hook adapter; instructions alone cannot do it. It is not a required stage of this plan. [Claude PermissionRequest](https://code.claude.com/docs/en/hooks#permissionrequest)

## Implementation and acceptance

1. **Six-method facade — implemented.** The `Sessions` facade consolidates attach/pair and message/receipt operations over the existing store and adapters. Default MCP exposes six tools. `--legacy-tools` selects the previous catalog for compatibility; exceptional recovery remains in operator CLI controls.
2. **Native addressing and self-status — implemented.** Connections use native IDs; status stores only text and a timestamp. Claude activation uses an explicit persistent native Monitor call, a durable inbox and fresh per-call identity. Receiver availability is observed separately from saved connections. Codex supports a pending one-sided connection and targeted recipient binding.
3. **Real-session acceptance — evidence required.** Use selected sessions to connect, list status, request a review, continue independent work, receive findings and resume the original task. Repeat with multiple peers and a busy destination. Record observations and remaining gaps in [live-validation.md](live-validation.md).

The bridge preserves cancellation, duplicate-send protection, durable receipt history and conservative uncertain delivery. It introduces no model session spawning, workflow scheduler or provider credential handling. Queued persistence, completed notification output, an agent's read and a substantive result remain separate facts. Receipt records are reused rather than reclaimed after 30 minutes; a single late result stays eligible until the original request expires or is canceled/disconnected.

The [support guide](support.md) distinguishes automated checks from native idle/busy, restart and permission behavior. The visual document has structural checks; browser-rendered acceptance is a separate check.
