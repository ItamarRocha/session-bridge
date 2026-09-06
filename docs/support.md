# Troubleshooting and support

This implementation connects local macOS sessions under one OS account. Node.js 24+ is required. The development compatibility baseline is Codex CLI 0.153.1 and Claude Code 2.1.261; a running client can be older than the binary on disk. Native-session evidence and its remaining gaps belong in the [live validation record](validation.md).

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

Use `/session-bridge:sessions` to list the current conversation's connected peers, receiver availability and latest reported status. Retained peers remain visible even when the current receiver needs explicit activation. The command reads all result pages without activating the bridge. Run `/reload-plugins` after updating the checkout to make a new command available in an existing conversation.

Install the built checkout as a personal plugin and run `/reload-plugins` in the intended conversation. `/session-bridge:connect` is the explicit activation command. It starts Claude's native `Monitor` tool with `persistent: true` and `monitor --session-id "${CLAUDE_SESSION_ID}"`; no automatically declared plugin monitor starts on terminal creation. A regular background Bash process cannot replace native model notifications. [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool), [skill substitutions](https://code.claude.com/docs/en/skills#available-string-substitutions)

The plugin's `PreToolUse` hook passes the current hook `session_id` to bridge calls as private context. It does not trust an MCP startup environment surviving `/clear` or a conversation change. After either, explicitly activate the new conversation again. When MCP reconnects within the same native conversation, fresh per-call identity can reuse its active receiver without a ticket exchange. [Hook input](https://code.claude.com/docs/en/hooks#common-input-fields)

The [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool) is unavailable on Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, and when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Respect those host choices. This project does not change those flags or use private inbox protocols as a fallback.

The receiver watches the durable SQLite inbox rather than a per-message Unix socket. Claude-bound messages can remain queued while it is unavailable. A completed stdout write records notification, and only an actual agent read records receipt. A new watcher can notify eligible unread entries from an earlier receiver generation again; agents inspect the existing receipt before continuing. Native Monitor persistence preserves the helper across turns, not an autonomous model loop.

A normal receiver shutdown or crash preserves its native session identity, history and connections. Its ownership lease lasts five seconds and is renewed every second. After abrupt loss, availability becomes unavailable on lease expiry. Invoke `/session-bridge:connect` explicitly in that same conversation to restart; a retained connection does not require pairing again. If another watcher still owns the lease, reuse that watcher instead of launching a duplicate. `receiver.checkedAt` and `expiresAt` explain the observed availability; they do not measure model activity.

The receiver, context hook and MCP helper need the same Node installation and bridge directory. If `node` is unavailable in the host launch environment, correct that environment or configure an absolute Node path consistently. Keep machine-specific paths out of shared commits.

An existing receiver from an older installation does not disappear when configuration changes. Stop old helpers before upgrading as described below. For ordinary v0.3.0 watcher restart, use native Monitor controls; full operator `stop` intentionally closes connections. An old registration lacking a native ID cannot be addressed through the new native-ID methods.

## Upgrading to v0.3.0

Stop every older bridge receiver and MCP helper before opening their shared ledger with v0.3.0. Reloading a plugin does not by itself establish that an old monitor exited. Check the native monitor/task controls and helper ownership first. Then build/load the new checkout and explicitly activate the intended Claude conversation.

The upgrade writes ledger schema 3 and preserves native identities, history and connection records. Older binaries cannot safely share the upgraded database; use v0.3.0 helpers consistently, including any `--legacy-tools` compatibility mode. A legacy endpoint still registered in the ledger is an explicit upgrade conflict, not evidence that a new inbox watcher is running. Inspect and stop that old attachment through the operator controls, then activate and reconnect only the intended peers.

Use an isolated `SESSION_BRIDGE_HOME` to try an update before upgrading a shared ledger.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build fails or SQLite cannot load | Confirm Node 24+; run `npm ci` and rebuild. |
| Claude bridge tools are absent | Inspect `/plugin` errors and `/mcp`, then reload the personal plugin. |
| No Claude receiver after explicit connect | Check native `Monitor` availability, `persistent: true`, startup output and `self.receiver`. A ready native monitor is not itself message receipt. |
| Connected peers remain but `activationRequired` is true | The saved relationships survived receiver loss. Explicitly invoke `/session-bridge:connect` in this conversation to restart the watcher. |
| Receiver reports unavailable after a crash | Inspect its lease timestamps; abrupt loss can take up to five seconds to expire. Reuse a still-owned watcher or explicitly restart after expiry. |
| Claude-bound send remains `queued` | The message is stored. Inspect the selected receiver's availability and activate it explicitly; keep the same message ID. |
| Claude message is `notified` but not `read` | The notice reached the native stdout stream. The owning model has not recorded its read yet; inspect the original conversation. |
| New Claude conversation sees an old identity | Confirm the current plugin hook is loaded; missing fresh context must fail. Reactivate after `/clear`. |
| Unknown bare UUID gives `activation_required` | Use `codex:UUID` for an unregistered Codex destination, or explicitly activate the selected Claude receiver. |
| Connect returns `pending` | Connection is saved; connect itself sends nothing. The first message can notify the Codex target, and its eligible targeted read binds it. |
| Codex stays at `submitted` | Inspect the exact message's receipt; compare the helper's Codex home and SQLite settings with the owning task, then inspect its native queue, loaded state, and pause or permission state. |
| Claude inherits another Codex account profile | Set an absolute `SESSION_BRIDGE_CODEX_HOME` for the intended destination and relaunch the helper. Inspect the original queued message before any new send. |
| CLI can store a message but cannot queue it | Check the task shell's permission to access native Codex queue storage. |
| Delivery is `unknown` | Inspect destination and ledger before considering a new request. No automatic resend occurs. |
| History says `previouslyRead` or names a reply | Inspect prior work and existing result before repeating actions. |
| A message has `blockedReason` | Inspect cancellation, original request expiry and connection state. Blocked history is not authority for new work. |
| A result takes longer than 30 minutes | Reuse the original receipt. It is never reclaimed; one late result is allowed while the original request remains valid, normally for one hour, unless canceled/disconnected. |
| A session status is old | It is the last self-report, not verified current activity. |
| Both agents edited the same files | State file/snapshot ownership in the next bounded request. The bridge does not enforce work ownership. |

## Operator recovery

The six methods cover normal collaboration. A routine watcher restart uses Claude's native Monitor controls and preserves connections. The local CLI keeps diagnostics, exceptional cancellation and full attachment closure:

```bash
node dist/cli.js doctor
node dist/cli.js peers
node dist/cli.js status --self PEER_ID
node dist/cli.js status --self PEER_ID --message MESSAGE_ID
node dist/cli.js cancel --self PEER_ID --message MESSAGE_ID
node dist/cli.js stop --self PEER_ID
```

Read `PEER_ID` from `peers`; these operator IDs still use `sb_…`. Inspect the native ID/provider before selecting one. `cancel` fences one request; `stop` closes that peer and all its connections, and its Claude monitor exits shortly afterward. Neither operation undoes external work or terminates a native model session. A full operator `stop` is different from receiver exit: it deliberately closes connections. Reusing that native identity afterward retains its history but requires explicit reconnection of those closed edges. Use ordinary native Monitor shutdown/restart when the intention is only to replace a watcher.

Use only v0.3.0 helpers against schema 3, even when exposing the legacy catalog. The upgrade preserves existing peers, pairings and message evidence; old helpers must be stopped before migration.

For compatibility with the previous interface, `mcp --host codex|claude --legacy-tools` exposes the previous ten tools instead of the default six. Legacy attachment tickets remain single-use; use the operator recovery flow for a lost legacy binding. Normal six-method callers use native IDs and do not manage those tickets. The old CLI attach/pair/receive/reply commands also remain; consult `--help` rather than mixing public native IDs with operator peer IDs.

## Validation

See [validation](validation.md) for the tested baseline, automated coverage, native roundtrip evidence, and remaining client scenarios. A queue submission or healthy helper alone is not proof that a model read or completed a request. For isolated development and native trial guidance, see [contributing](../CONTRIBUTING.md).
