# Session Bridge: messages between existing sessions

Revised plan · 2026-09-05 · [Visual document](collaboration-v2.html) · [Six-method interface](plugin-methods.md)

**The bridge connects sessions and carries messages. The agents manage their work.** Use each client's existing goals, tasks and conversation state. There is no bridge goal, work queue, review object, ownership engine or collaboration scheduler.

This replaces the earlier workflow-engine proposal. The six-method interface, native-ID connection and status one-liners remain planned. Explicit Claude activation and the existing message transport are implemented; the collaboration instructions are updated in this revision.

## What belongs where

| Agent and native client | Session Bridge |
| --- | --- |
| Goals, plans, tasks and completion decisions | Identity and explicit connections |
| Deciding who handles which part | Sending and receiving selected messages |
| Handoffs and review requests expressed in messages | Durable message storage, deduplication and receipts |
| Continuing independent work; remembering a pending reply | A short status published by each session |
| Native waiting, resumption and permission handling | Delivery through the existing client adapters |

Removing the public workflow methods also removes their proposed tables, state machines, scheduler, leases, subscriptions and policy engine. They are not retained as a hidden service behind the skill.

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

Each row contains native ID, provider, label, connection state and the latest self-published status with a timestamp. For example: **“Claude · connected · running benchmark B · updated 2 minutes ago.”** A short update can mention a file or native task when useful; it does not create a shared work record.

Status updates are silent metadata changes. They do not wake other models or become assignments. A stale update stays labelled stale; it does not prove the model is running, idle or offline. The first version does not scan transcripts or synchronize native task databases to reconstruct status.

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

## Multiple peers and one-sided setup remain

One session can connect to many others, regardless of provider. The existing ledger already passed a four-peer isolated check with both same-provider combinations. Connections stay explicit; A–B and A–C do not silently establish B–C. Completing an agent's task does not disconnect its other peers.

Keep native IDs as the intended address. The existing release still exposes bridge IDs; migration needs a stable native identity and a fresh connection generation. A fresh Claude identity must not be inferred solely from a stale MCP startup environment. [Claude identity variables](https://code.claude.com/docs/en/env-vars)

Claude initiating toward a loaded Codex task can use the supported native queue for an invitation and recipient bootstrap, subject to a live test. A dormant Claude receiver still requires explicit activation. An invitation stays pending until the recipient acknowledges it; absent acknowledgement is not proof of offline status. [Codex queue source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs), [Claude plugin monitors](https://code.claude.com/docs/en/plugins-reference#monitors)

Actual remote/cloud transport is outside this local version. A session UUID alone is not a route between machines.

## Permissions stay native

Remove permission methods and automatic cross-agent approval from this version. Agents may discuss an action, but an “approved” chat message does not approve a blocked tool. Implementing that later would need a real, explicitly authorized native hook adapter; instructions alone cannot do it. It is not a required stage of this plan. [Claude PermissionRequest](https://code.claude.com/docs/en/hooks#permissionrequest)

## Small implementation plan

1. **Simplify the facade.** Consolidate existing attach/pair and message/receipt operations behind the six methods. Keep the current transport's cancellation, deduplication and conservative handling of uncertain delivery. Migrate existing callers deliberately.
2. **Add status and native addressing.** Store only each session's short status and update time alongside connection metadata. Implement native-ID binding and one-sided bootstrap without enrolling unrelated sessions.
3. **Prove the human journey.** Use selected existing sessions to connect, list status, send a review request, continue independent work, receive findings and resume the original task. Then repeat with multiple peers and one busy destination.

The bridge keeps its current Codex queue and Claude monitor adapters. No new model sessions, workflow scheduler or provider credential handling are introduced. Preserve the distinction between transport submission, receipt and an actual substantive response.

Validation should cover explicit activation, native-ID reuse, stale status, exact recipient scope, durable receipts, duplicate sends and one-peer disconnection preserving the others. Native idle/busy behavior still requires live testing. These documents were checked structurally; rendered preview was previously blocked by browser policy.
