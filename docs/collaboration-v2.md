# Session Bridge: collaboration that survives a turn

Design proposal · 2026-09-05 · [Interactive document](collaboration-v2.html)

Extension: [multiple sessions and the proposed plugin method catalog](plugin-methods.md).

**Decision:** keep the existing local message transport and add a durable collaboration contract above it. Users connect existing conversations by their native IDs. Each goal has a coordinator, owned work, acceptance criteria, and a recorded next action. An agent finishing its response is not a goal completing.

The model supports more than two participants: sessions form explicit pairwise connections, and each goal names its own participants and roles. A session may belong to several goals. Completing one goal does not detach it from the others. The current ledger already permits multiple connections and both same-provider combinations; native multi-session execution still needs a live test.

**Implementation status:** this revision changes Claude's monitor from automatic startup to explicit `/session-bridge:connect` activation. Native-ID connections, recipient bootstrap, permission supervision, and goal orchestration below are proposed, not implemented. The existing release still uses `sb_...` peer IDs and bounded request/reply exchanges. This document is a build plan, not evidence of a completed live collaboration test.

**Validation for this revision:** TypeScript checks and all 33 existing isolated tests passed; both plugin validators passed. The visual document's script passed syntax and static interaction checks for all three modes, replay/back controls, and four failure views. Browser security policy blocked local rendered preview, so visual layout and a fresh Claude terminal's activation behavior have not been verified in a live journey.

## 1. The user contract

1. **Install once; activate deliberately.** Opening a terminal makes the installed tools available but does not register a bridge peer or send setup instructions. Invoke `/session-bridge:connect` to activate this Claude conversation. Permission supervision is a separate opt-in grant.
2. **Share the ID already in the client.** Accept `codex:<native UUID>` and `claude:<native UUID>`. Accept a bare UUID only when provider and machine resolve unambiguously. Internal message, goal, work, and connection-generation IDs still exist; users do not need another session ID.
3. **One instruction can authorize both ends.** “Connect this Claude session to Codex X for this experiment” creates a scoped invitation. A reachable recipient verifies and acknowledges that invitation without another manual pairing step. Display `pending` until the actual recipient accepts.
4. **Keep responsibility visible.** An unfinished goal has a coordinator. Each required work item has an owner or is ready for the coordinator to assign. Finishing a turn records what happens next.
5. **Stop on evidence or an explicit interruption.** Completion requires acceptance against the goal's criteria. A user pause, cancellation, unavailable host, budget limit, or missing approval records why work stopped; none counts as completion.

Example proposed interaction:

> Connect to Codex `<UUID>`. Compare approaches A and B. You run the benchmark; Codex reviews the harness while you continue. Finish when the reproducible results and reviewed recommendation are accepted.

The response should report the two native identities, who coordinates, work ownership, completion criteria, and current connection status. It should not ask the user to copy a second identifier into the other conversation.

## 2. Explicit activation and honest reachability

The startup bug is `monitors/monitors.json` setting `when: "always"`. It now uses `on-skill-invoke:connect`, with a manual-only connect skill. Claude documents this dispatch trigger. Existing monitor processes are not retroactively stopped by a plugin change; the new condition applies when loaded. An enabled plugin's MCP server can still start silently to expose tools; it must not enroll a session. [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference#monitors)

Model activation and connection separately:

```text
Session:     dormant → listening → detached
Connection:  invited → connected → closed
                 ↘ expired / rejected
Reachability: available | busy | paused | offline | activation_required | unknown
```

`listening` means a receiver is available, not that collaboration was authorized. `connected` requires a valid grant and recipient acknowledgement. Reachability observations include their source and timestamp: missing acknowledgement or successful queue submission alone cannot establish busy, paused, or offline. When no current observation exists, show `unknown` or awaiting acknowledgement. An observed offline peer may retain a valid connection contract without being runnable. User pause suppresses automatic work delivery until explicit resume.

### What one-sided connection can actually do

| Initiator → target | Proposed behavior | Evidence or limit |
| --- | --- | --- |
| Claude → existing loaded Codex on this Mac | Queue an invitation; the original task attaches through the local CLI, fetches the contract, and acknowledges it. | Public `codex queue` supports native UUID addressing. Bootstrap compliance still needs a live journey test. |
| Either → Codex busy with current work | Keep invitation/work pending until the native owner can consume it. | Do not interrupt or create another model session. |
| Either → paused or unloaded Codex | Retain pending work; label paused/offline only when observed, otherwise awaiting acknowledgement. | Do not resume the task automatically. |
| Codex → Claude with activated bridge | Deliver through its existing monitor and await acknowledgement. | Existing transport; new invitation semantics still need implementation. |
| Codex → Claude whose receiver never activated | Return `activation_required`. | No verified public external sender interface for starting that dormant receiver. |
| Actual remote/cloud session → Mac | Require an explicitly installed, authenticated remote adapter. | A UUID supplies neither a network route nor authority. Local SQLite and Unix sockets do not span machines. |

The first milestone is the requested **Claude-to-Codex** flow. Completely dormant receivers and universal zero-touch inbound access are incompatible without an additional host-supported entry point. Do not install an always-on listener to conceal that tradeoff. The Codex queue behavior is grounded in the published [v0.153.1 queue service](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs). Claude's documented [native cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) is not proof of an external bridge protocol or permission-consent channel.

### Identity and authority

Use `(deviceNamespace, provider, nativeSessionId)` as the session key. Keep private connection generations to reject stale attachments. Preserve existing `sb_...` records as migration aliases, without relabeling historical messages or reviving closed peers.

Claude's MCP environment can retain a startup ID after `/clear` or a resume operation. Bind using fresh hook `session_id` or the skill's `${CLAUDE_SESSION_ID}`; never let a stale MCP environment override that identity. Discover native Claude sessions using the documented `claude agents --json` fields, not its separate short background-job IDs. [Environment variables](https://code.claude.com/docs/en/env-vars), [skill substitutions](https://code.claude.com/docs/en/skills), [agent discovery](https://code.claude.com/docs/en/agent-view#list-sessions-as-json)

The local user's explicit connect action establishes scope; knowing a UUID does not. Store the grant before dispatching the invitation. The recipient verifies it through the trusted bridge installation and binds its own current identity. Bootstrap notifications contain a bounded reference, not arbitrary executable commands from the sender. Expire invitations and consume their acceptance nonce once. This remains a same-OS-user trust model: the current local CLI and database are not an isolation boundary against hostile processes with that user's filesystem access.

## 3. Three layers of progress

Keep the existing distinction between message storage, transport submission, and receipt. Add work and goal state without turning a request into an infinite conversation.

| Object | Main states | What advances it |
| --- | --- | --- |
| Message | `stored → dispatching → submitted`, or `unknown` | Adapter evidence, then a separate receive acknowledgement. |
| Work item | `ready → active → submitted → accepted` | Atomic assignment, checkpointed execution, evidence submission, designated acceptance. |
| Goal | `draft → active → verifying → completed` | Authorized contract, required work accepted, acceptance criteria verified. |

Additional work states: `blocked`, `outcome_unknown`, and `cancelled`. A rejected submission returns to `active` with a recorded revision request. `outcome_unknown` means a possibly completed external action needs reconciliation before retrying.

Additional goal states: `blocked`, `paused`, and `cancelled`. `blocked` requires an owner and a concrete dependency or recovery condition. `paused` requires explicit resume. A failed verification returns to `active` with required follow-up work. A completed or cancelled goal is terminal; a new objective creates a new linked goal.

### Guarded transitions

| Event | Preconditions | Atomic result |
| --- | --- | --- |
| Activate goal | Objective, coordinator, scope, acceptance authority and criteria recorded | Goal becomes active; initial work and wake records created. |
| Claim work | Work ready; dependencies satisfied; expected version matches | One owner and ownership epoch assigned. |
| Submit result | Caller owns current epoch; work not cancelled | Immutable artifact references and evidence stored; work submitted; reviewer/coordinator notified. |
| Accept result | Designated authority; reviewed revision matches; required checks satisfied | Work accepted; dependent work becomes eligible. |
| Request revision | Submission has an actionable defect or missing criterion | Follow-up recorded and ownership retained or explicitly reassigned. |
| Verify goal | All required work accepted; no unresolved blocking items | Goal enters verifying against current artifact revisions. |
| Complete goal | Every acceptance criterion has accepted evidence; required reviews cover current results | Goal completed; remaining optional work/subscriptions explicitly cancelled or closed. |
| Pause/cancel | Authorized user or delegated control scope | Pending work wakes suppressed; owners checkpoint; in-flight effects reconciled. |

Transport receipt never claims work implicitly. A model's final response, an expired lease, or a green process-health check never completes a goal.

## 4. The three collaboration modes

### Delegate and continue

The coordinator owns the experiment and creates a bounded child item for the peer. While the peer runs its item, the coordinator advances independent work. If it eventually depends on that result, it records `blocked_on: childItem` and a result-triggered wake. Delegating work does not transfer the whole goal. Completion of the child submits evidence; the coordinator accepts it and integrates the result.

### Review while implementation continues

The implementer publishes a checkpoint with a commit or content digest, creates a review item, and continues work that does not rely on the pending verdict. The reviewer returns findings against that exact snapshot. Findings become required revision work or explicitly nonblocking observations. Review of revision A cannot approve revision B; changes in the reviewed scope invalidate or require revalidation of the corresponding acceptance.

### Parallel experiment with ongoing feedback

The coordinator splits the experiment into independently owned items, preferably in separate worktrees or explicitly reserved resources. Both agents publish meaningful checkpoints. A review subscription selects relevant checkpoint types and coalesces obsolete intermediate revisions; it does not generate a wake for every progress message. The coordinator integrates results and resolves conflicting feedback. If both need to edit the same resource, ownership is negotiated before writing. A reservation is advisory unless the actual tools enforce it.

These are reusable arrangements of work and dependencies, not three different transport protocols. A goal can use all three at different stages.

## 5. Handoffs transfer responsibility atomically

A message saying “your turn” is insufficient. Use a handoff record with a nonce, expected ownership epoch, snapshot, and deadline.

1. A checkpoints the item and quiesces its in-flight mutations for that item. A may continue unrelated work.
2. A offers the exact checkpoint to B. A remains responsible while the offer is pending.
3. B acknowledges readiness for that snapshot and epoch; receiving a notification alone does not qualify.
4. One compare-and-swap transaction checks the offer, quiescence and old epoch, moves ownership to B, increments the epoch, and records the wake in the outbox.
5. A and B read the committed ledger state. If an acknowledgement was lost, they reconcile that state rather than repeating the transfer or external effects.

An offer timing out before commit leaves A responsible. An old owner cannot submit an authoritative result with a stale epoch. The ledger guarantees one recorded owner; it cannot fence arbitrary shell commands already running outside the bridge. Uncertain external effects must be inspected before work is retried or reassigned.

## 6. Progress without a model keepalive loop

**Invariant:** every unfinished active goal has owned work with fresh evidence of execution, a durable wake with a due time or event, or a named blocker with a responsible party. An `active` database label alone does not prove execution. The coordinator owns unassigned ready work. A status view must explain who is responsible and what happens next.

Before yielding, an agent records one of:

- Its checkpoint, next owned action, and a continuation event or due time, recorded atomically. An actually running external operation can instead record its completion event and bounded recovery deadline.
- A committed handoff.
- A dependency, external operation, review, permission, or human response it is waiting for, including who/what resolves it.
- A submitted result awaiting designated acceptance.
- An explicit pause or cancellation.

An opt-in deterministic worker within the bridge helper processes the durable outbox and due checks. It dispatches only to the existing sessions. Relevant events include assignment, committed handoff, dependency completion, a review result, a permission request, and a recovery checkpoint. Receipt acknowledgements and unchanged status do not wake models.

Coalesce wakes by target and relevant goal revision. After a missed checkpoint, send one actionable reconciliation wake, then back off and expose a named blocker. Detect dependency cycles and wake the coordinator once to resolve the deadlock. Never implement periodic “keep working” prompts as a substitute for ownership.

Both agents being idle is valid while a benchmark runs. It is a fault when ready work exists and there is neither an owner executing it nor a scheduled wake. If all bridge helpers or native clients exit, automatic progress cannot be guaranteed: preserve the ledger and overdue wakes for the next activation. Unattended operation would require a separately chosen persistent local service, not a replacement model process. User pause always wins.

Unknown native delivery and unknown external execution are separate uncertainties. The existing conservative delivery rule remains: do not automatically resubmit an uncertain native notification. Reconcile receipts first; consumers deduplicate by work/event ID. This provides recoverable coordination, not exactly-once external effects.

## 7. Codex supervising Claude permissions

Add this as a distinct opt-in capability, using Claude's documented `PermissionRequest` hook. A hook can return allow or deny for the pending action; it cannot override deny rules and does not cover sandbox network prompts. Use a direct hook response, not a normal message to the blocked Claude model. [PermissionRequest reference](https://code.claude.com/docs/en/hooks#permissionrequest)

```text
Claude tool needs permission
    → hook records exact pending request
    → designated Codex supervisor receives bounded notice
    → supervisor fetches full action + grant + context
    → approve once / deny / ask user
    → matching blocked hook consumes decision
    → Claude's ordinary permission machinery proceeds
```

The user grants supervisor, target Claude identity, project/action scope, expiry and optional per-goal limits. Connecting sessions alone grants no approval rights. Keep supervision acyclic; an agent waiting on its supervisee must not be the only possible approver. A busy supervisor may not answer before the deadline, so preserve the ordinary human route.

Bind each request to a new hook-invocation ID, native session and generation, full tool name, canonical tool arguments and digest, cwd, grant version, and deadline. The hook input has no `tool_use_id`; do not invent one from a truncated preview. A decision is single-use and valid only for that pending invocation. Do not write permanent allow rules or silently broaden permissions. Late, mismatched, revoked, or replayed approvals are rejected.

Use an already connected `mcp_tool` hook or a small command-hook adapter calling the same permission ledger. Both return through the original hook invocation. The permission wait must allow concurrent MCP calls so resolving an approval cannot deadlock behind its own waiter. The hook-facing method should not appear as an ordinary model-callable request-creation tool. [MCP tool hook fields](https://code.claude.com/docs/en/hooks#mcp-tool-hook-fields)

No active grant, unsupported prompt, hook failure, timeout, or `ask_user` returns no automated decision and preserves Claude's native handling. Whether a human can actually answer depends on the host; noninteractive execution must not become an implicit allow. A user revocation or pause cancels unresolved delegations. Record request, decision, supervisor, scope and consumption for inspection, without exporting entire transcripts.

Initial supervision should approve only actions within the user's explicit scope and route scope expansion or uncertain consequences to the user. Native workspace trust, MCP installation consent and unsupported prompts stay with their host. Codex's own permission decisions remain authoritative; the bridge cannot route an action through Claude to evade a Codex restriction. This is delegated authority for Claude's action, not transferred privileges between platforms.

## 8. Small, durable modules

Retain `Bridge`, `Store`, and the delivery adapters. Add a collaboration module that owns transition rules and a permission module that owns the hook rendezvous. CLI and MCP expose the same application operations instead of implementing their own state logic.

| Location | Change |
| --- | --- |
| `monitors/monitors.json`, `commands/connect.md` | Explicit Claude activation; implemented in this revision. The manual-only command stays outside the shared Codex skills directory. |
| `src/types.ts` | Native session address, attachment generation, connection grant, goal, work, review, handoff and permission records. Keep message lifecycle independent. |
| `src/store.ts` | Versioned SQLite migrations; unique native bindings, atomic ownership/acceptance, event/outbox writes in the same transaction as state changes. |
| New `src/collaboration.ts` | Goal/work transitions, completion predicates, handoff transaction preconditions, revision-bound review, dependency/cycle checks. |
| New `src/permissions.ts` | Scoped grants, exact-action requests, decision validation, single consumption and expiry. |
| `src/bridge.ts` | Application facade for connect/invite/accept and collaboration operations; current messaging remains available. |
| `src/transport.ts` | Native-address routing and capability reports; queue invitations only to existing owners. No private host IPC. |
| New `src/outbox.ts`, existing `src/monitor.ts` / `src/mcp.ts` | Deduplicated wake processing with exclusive worker leases; monitor starts only after activation; resume reconciliation and bounded retries. |
| `src/cli.ts`, `src/mcp.ts` | Thin command/tool adapters; expose status showing owner, next step, blocker, delivery uncertainty and current artifact revision. |
| New `hooks/hooks.json` + hook adapter | PermissionRequest integration gated by an explicit active grant. No startup enrollment. |
| `src/doctor.ts` | Report native queue support, receiver activation, identity freshness, observed reachability with source/time or unknown, hook support and unresolved work. |
| `skills/session-bridge/SKILL.md`, new receive/review guidance | End-of-turn responsibility contract, native-ID usage and acceptance criteria; recipient acceptance separate from the manual activation skill. |

The [method catalog](plugin-methods.md) defines explicit session, message, goal, work, handoff, review and permission operations. Start with `bridge_sessions_list`, `bridge_session_get`, and a separate `bridge_sessions_discover`: connected peers, detailed status, and discovery are different questions. Keep consequential transitions clearly named rather than placing them behind a universal action switch. Publish only implemented methods, and update skills and CLI help alongside a deliberate interface revision.

Store required work dependencies and exact reviewed artifact revisions, not complete mirrored client transcripts. Keep original native IDs stable across restart and preserve message history. A session's new generation invalidates old transport/approval capabilities but does not discard its goal history. Migration must never reopen cancelled messages or silently migrate old pairing authority into supervision grants.

## 9. Build order and proof

| Phase | Deliverable | Acceptance evidence |
| --- | --- | --- |
| 0 — activation | Manual connect skill and on-invocation monitor. | Plugin validation; a fresh Claude terminal emits no bridge setup until the user invokes connect. Configuration validation is complete; live-terminal behavior remains to be observed. |
| 1 — session reads + native invitation | Connected-session lists and detailed status first, followed by native addresses, generation binding and one-sided Claude → Codex bootstrap. | Lists never enroll or wake a peer and expose unknown activity honestly. Paste one Codex UUID from Claude; the same existing Codex task acknowledges and replies without a second user setup step. Multiple edges, busy, paused, offline, duplicate invitation, `/clear` and resume cases behave correctly. |
| 2 — permission supervision | Scoped grant and direct hook rendezvous, human fallback. | Harmless prompted action resolves once through Codex; another action outside scope goes to the user. Expired/revoked/replayed decisions, mismatched arguments, missing supervisor and unsupported prompt tests pass. No new model session starts. |
| 3 — durable collaboration | Goals, owned work, dependencies, acceptance and transactional outbox. | Delegation and parallel experiments survive turn endings and helper restart; no active goal loses its next action. Completion requires recorded evidence. |
| 4 — handoff + live review | Atomic ownership transfer, snapshot review, checkpoint subscriptions. | Lost ACK does not duplicate ownership; stale owner/result and review of old revision cannot pass acceptance; both-waiting deadlock produces one actionable recovery. |
| 5 — remote transport, only if needed | Authenticated device/relay adapter with explicit installation and revocation. | A real remote existing session reaches the actual Mac owner; no provider credentials are proxied and the interface reports offline/pause honestly. |

Use deterministic ledger tests for concurrency, versions, idempotency, restart recovery and permission binding. Use real existing sessions for activation, delivery, wake timing and host approval behavior. A mocked adapter or healthy helper proves neither that the model saw a message nor that the human journey worked. Do not send test traffic to unrelated live sessions.

## 10. Research: borrow mechanisms, keep the bridge small

| Project | Useful mechanism | What it does not establish |
| --- | --- | --- |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail#api-quick-reference) | Durable threads, distinct read/ACK and advisory file reservations. | Mail delivery is not accepted work or guaranteed model wake. Its [contact policy](https://github.com/Dicklesworthstone/mcp_agent_mail#contact-model-and-consent-lite-messaging) requires authority beyond merely knowing an ID. |
| [Beads](https://github.com/gastownhall/beads#essential-commands) | Durable dependency graph, ready work and atomic claims. | It is work tracking, not an adapter into existing model sessions. Borrow the ownership contract rather than adding a second work database. |
| [A2A](https://a2a-protocol.org/latest/topics/life-of-a-task/) | Separate messages, contexts, tasks and artifacts; explicit interrupted/terminal states. | Protocol completion does not establish this experiment's evidence-based acceptance. Use its distinctions without introducing an A2A server in v2. |
| [agent-channel](https://github.com/fl4p/agent-channel#receive-primitives) | Durable cursors and filesystem-event receive. | Host-specific wake limitations remain; a shared temporary directory is not remote connectivity. |
| [osteele/agent-mail](https://github.com/osteele/agent-mail) | Local durable spools with Claude channel delivery and Codex inbox tools. | Having both client integrations does not demonstrate symmetric push into two unactivated sessions. |
| [Ruflo](https://github.com/ruvnet/ruflo/blob/main/plugins/ruflo-workflows/README.md) | Workflow persistence, review gates and coordination concepts. | Its broader agent harness is not evidence of seamless attachment to the two terminals the user already owns. |

Sources were inspected on 2026-09-05. Default-branch repository links can change; host behavior must be rechecked against installed versions. The state machine, module boundaries and implementation sequence here are our design synthesis, not claims that any single reference implements this complete contract.
