# Support and validation

This implementation connects local macOS sessions under one OS account. Node.js 24+ is required. The development compatibility baseline is Codex CLI 0.153.1 and Claude Code 2.1.261; a running client can be older than the binary on disk. Native-session evidence and its remaining gaps belong in the [live validation record](live-validation.md).

## Codex

Run `codex queue --help` to confirm availability. Delivery uses the same Codex home and queue configuration as the owning task. The owning client must consume the item; the bridge does not open an unloaded task or promise that a paused one will resume. [Published queue implementation](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs)

An existing task can use the CLI through its shell tool without loading new MCP tools. Its caller identity comes from its own `CODEX_THREAD_ID`. The six-method MCP server requires the current call's `_meta.threadId`, as supplied by the pinned Codex client; it never falls back to startup identity. If that native context is absent, use the current task's CLI route rather than borrowing an ID from another session. [MCP call source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/mcp_tool_call.rs#L506)

CLI delivery needs permission to write the native Codex queue storage as well as the bridge directory. A shell sandbox may allow the bridge ledger write while denying access to the native queue. Use the client's normal permission flow for the required queue access. An `unknown` outcome still requires inspection before a new send; a sandbox failure is not permission to replay an uncertain message. An MCP helper runs in its host launch environment, which can differ from a task shell's sandbox.

The packaged Codex MCP configuration sets `cwd` to `.`. The published [plugin MCP parser](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/codex-mcp/src/plugin_config.rs) resolves that directory against the plugin root. A packaged copy needs its built output and dependencies.

A successful queue command proves submission only. Inspect the receiving session's receipt and substantive reply to establish that its agent acted. There is no promised wake-up latency.

### Codex profile routing

The Codex child command preserves inherited `CODEX_HOME` unless `SESSION_BRIDGE_CODEX_HOME` explicitly selects another absolute path. A terminal launched through an account manager can inherit a Codex home different from the destination desktop task's home. Both profiles can contain the same native task ID, so the CLI can accept a message into the other profile's queue while the intended task receives nothing.

Use the destination client's actual Codex home. For a session-scoped override, launch Claude from the built checkout with:

```bash
SESSION_BRIDGE_CODEX_HOME=/absolute/path/to/destination-codex-home \
  claude --plugin-dir "$PWD"
```

Set the same `SESSION_BRIDGE_HOME` as the other participants if the test uses an isolated bridge ledger. The Codex home override changes only the environment passed to child Codex commands; it does not mutate the parent process environment, rewrite client configuration, or move an already queued item. Existing deliberate `CODEX_HOME` profiles remain in effect when the override is absent. An existing helper needs to be relaunched with the changed environment before it can use that override.

Run doctor from the helper's launch environment to inspect the selected route:

```bash
SESSION_BRIDGE_CODEX_HOME=/absolute/path/to/destination-codex-home \
  node dist/cli.js doctor
```

Doctor invokes Codex with the same child environment used for delivery. Its reported Codex home identifies the selected profile, not proof of the destination's effective queue directory. Published Codex resolves queue storage as `sqlite_home` configuration, otherwise `CODEX_SQLITE_HOME`, otherwise its Codex home, then appends `queue_1.sqlite`. An explicit SQLite setting remains honored even when `SESSION_BRIDGE_CODEX_HOME` changes the profile. [Configuration precedence](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/config/mod.rs#L3953), [queue database path](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/state/src/sqlite.rs#L154)

If delivery remains `submitted`, inspect the exact message's bridge receipt and compare the sender helper's selected Codex profile with the owning task's profile and SQLite settings. Then check the intended task's native queue, loaded state and permission or pause state. Do not automatically resend: the original notification may still be queued in another profile. Correcting routing alone does not prove that the original request moved or arrived.

## Claude Code

Install the built checkout as a personal plugin and run `/reload-plugins` in the intended conversation. `/session-bridge:connect` is the explicit activation command. It starts Claude's native `Monitor` tool with `monitor --session-id "${CLAUDE_SESSION_ID}"`; no automatically declared plugin monitor starts on terminal creation. A regular background Bash process cannot replace native model notifications. [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool), [skill substitutions](https://code.claude.com/docs/en/skills#available-string-substitutions)

The plugin's `PreToolUse` hook passes the current hook `session_id` to bridge calls as private context. It does not trust an MCP startup environment surviving `/clear` or a conversation change. After either, explicitly activate the new conversation again. When MCP reconnects within the same native conversation, fresh per-call identity can reuse its active receiver without a ticket exchange. [Hook input](https://code.claude.com/docs/en/hooks#common-input-fields)

The [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool) is unavailable on Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, and when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Respect those host choices. This project does not change those flags or use private inbox protocols as a fallback.

The receiver, context hook and MCP helper need the same Node installation and bridge directory. If `node` is unavailable in the host launch environment, correct that environment or configure an absolute Node path consistently. Keep machine-specific paths out of shared commits.

An existing receiver from an older installation does not disappear when configuration changes. Stop that exact receiver through the native task controls or [operator recovery](#operator-recovery) before activating a replacement. An old registration lacking a native ID cannot be addressed through the new native-ID methods.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build fails or SQLite cannot load | Confirm Node 24+; run `npm ci` and rebuild. |
| Claude bridge tools are absent | Inspect `/plugin` errors and `/mcp`, then reload the personal plugin. |
| No Claude receiver after explicit connect | Check native `Monitor` availability and the tool's startup result. |
| New Claude conversation sees an old identity | Confirm the current plugin hook is loaded; missing fresh context must fail. Reactivate after `/clear`. |
| Unknown bare UUID gives `activation_required` | Use `codex:UUID` for an unregistered Codex destination, or explicitly activate the selected Claude receiver. |
| Connect returns `pending` | Connection is saved; connect itself sends nothing. The first message can notify the Codex target, and its eligible targeted read binds it. |
| Codex stays at `submitted` | Inspect the exact message's receipt; compare the helper's Codex home and SQLite settings with the owning task, then inspect its native queue, loaded state, and pause or permission state. |
| Claude inherits another Codex account profile | Set an absolute `SESSION_BRIDGE_CODEX_HOME` for the intended destination and relaunch the helper. Inspect the original queued message before any new send. |
| CLI can store a message but cannot queue it | Check the task shell's permission to access native Codex queue storage. |
| Delivery is `unknown` | Inspect destination and ledger before considering a new request. No automatic resend occurs. |
| History says `previouslyRead` or names a reply | Inspect prior work and existing result before repeating actions. |
| A message has `blockedReason` | Its receipt is unavailable; it is history, not authority for new work. Inspect abandoned work before recovery. |
| A session status is old | It is the last self-report, not verified current activity. |
| Both agents edited the same files | State file/snapshot ownership in the next bounded request. The bridge does not enforce work ownership. |

## Operator recovery

The six methods cover normal collaboration. The existing local CLI keeps diagnostics, exceptional cancellation and full receiver shutdown:

```bash
node dist/cli.js doctor
node dist/cli.js peers
node dist/cli.js status --self PEER_ID
node dist/cli.js status --self PEER_ID --message MESSAGE_ID
node dist/cli.js cancel --self PEER_ID --message MESSAGE_ID
node dist/cli.js stop --self PEER_ID
```

Read `PEER_ID` from `peers`; these operator IDs still use `sb_…`. Inspect the native ID/provider before selecting one. `cancel` fences one request; `stop` closes that peer and all its connections, and its Claude monitor exits shortly afterward. Neither operation undoes external work or terminates a native model session. Replacing a stopped receiver requires explicit activation and new connections; history remains in the ledger.

The v0.2 ledger migration preserves existing peers, pairings and message evidence. A v0.1 binary cannot open the upgraded schema; use v0.2 with its legacy catalog during migration.

For v0.2 migration only, `mcp --host codex|claude --legacy-tools` exposes the previous ten tools instead of the default six. Legacy attachment tickets remain single-use, and a lost legacy MCP binding needs a new ticket. Normal six-method callers use native IDs and do not manage those tickets. The old CLI attach/pair/receive/reply commands also remain; consult `--help` rather than mixing public native IDs with operator peer IDs.

## What automated checks establish

`npm run verify` exercises isolated ledger transitions, native addressing, per-call context, pagination, self-status, MCP calls and adapter failures. These checks do not establish that a real agent follows the skill or that every host consumes an idle notification. A successful model exchange must show the original destination receiving and reading a request, one substantive result, delivery back to the original sender, and both native sessions remaining under their original owners.

## Live acceptance

Use selected test sessions and a harmless bounded request. Record exact versions, native identities and evidence in [live-validation.md](live-validation.md). Cover:

1. Explicit activation, one-sided Codex bootstrap, and no enrollment when a new Claude terminal opens.
2. One request/reply in each direction while idle, without creating replacement model sessions.
3. A busy recipient, multiple peers, stale self-status and disconnecting only one connection.
4. Cancellation or disconnection before receipt, including an already queued notification.
5. Receiver/MCP restart and `/clear`, verifying current identity and required activation.
6. An interrupted or sandbox-blocked delivery that remains uncertain without automatic replay.
7. A permission-gated request following the client's normal approval behavior.

Only rows backed by observed native behavior count as live acceptance. Unit tests, a healthy receiver process and native queue submission are separate layers of evidence.
