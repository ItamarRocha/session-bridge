# Session Bridge

Connect existing Codex and Claude Code sessions by their native IDs. Each session can connect to multiple peers, publish a short “working on” line, and exchange bounded messages in its original conversation.

The bridge keeps a local message ledger and delivers through Codex's `queue` command and Claude Code's native `Monitor` tool. It does not launch or resume model sessions. Small MCP and receiver helpers run alongside your clients; Codex delivery uses a brief CLI helper. Goals, tasks, model authentication and permissions stay with the official clients.

**Status:** the six-method interface, native session addressing, explicit Claude activation and self-status are implemented for one OS user on one machine. Automated checks exercise isolated clients and state. Native idle, busy and restart behavior needs separate evidence; see the [live validation record](docs/live-validation.md) and [support guide](docs/support.md).

| MCP method | Purpose |
| --- | --- |
| `bridge_connect` | Connect to a selected native session ID. |
| `bridge_sessions_list` | List your connected peers and their latest status. |
| `bridge_status_update` | Publish your own one-line status. |
| `bridge_message_send` | Send a request, informational update or reply. |
| `bridge_messages_read` | Read incoming messages or inspect an exchange. |
| `bridge_disconnect` | Disconnect one peer; leave other connections intact. |

[Visual guide](docs/collaboration-v2.html) · [Method contract](docs/plugin-methods.md) · [Collaboration design](docs/collaboration-v2.md)

## Build

Requires Node.js 24+, npm, Codex with `codex queue`, and interactive Claude Code with `Monitor` available. Both clients and all bridge helpers must use the same OS account and bridge data directory. Data defaults to `~/.local/state/session-bridge`; `SESSION_BRIDGE_HOME` or CLI `--home /absolute/path` selects another private local directory.

```bash
gh repo clone ItamarRocha/session-bridge
cd session-bridge
npm ci
npm run verify
node dist/cli.js doctor
```

Keep this checkout in a durable location. The plugin needs the locally built `dist/cli.js` and installed `node_modules`; rebuild after updating source. Building does not change client configuration.

Codex delivery inherits the launching environment's `CODEX_HOME` by default. If Claude runs under a different Codex account profile from the destination, set `SESSION_BRIDGE_CODEX_HOME` to the destination's absolute Codex home path when launching Claude or its bridge helper. This override affects the child Codex command only; it does not change Claude's environment or another client's settings. `doctor` checks Codex through that same child environment. `CODEX_SQLITE_HOME` or `sqlite_home` configuration can select a different queue directory; see [Codex profile routing](docs/support.md#codex-profile-routing). A successful submission to another profile's queue does not establish receipt.

## Connect from an existing Claude session

From the built checkout, install the personal Claude plugin:

```bash
bridge_project="$PWD"
mkdir -p "$HOME/.claude/skills"
ln -s "$bridge_project" "$HOME/.claude/skills/session-bridge"
```

The symlink command fails if that destination already exists. Inspect an existing installation before updating it.

In the existing Claude conversation, run `/reload-plugins`, then `/session-bridge:connect` when you want to activate its receiver. Opening another terminal or loading the plugin leaves its bridge dormant. The command uses Claude's native `Monitor` tool with this conversation's current native ID; a `PreToolUse` hook supplies that ID freshly for each bridge tool call. Users and models no longer exchange private attachment tickets. See Claude's [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool), [skill substitutions](https://code.claude.com/docs/en/skills#available-string-substitutions) and [hook input](https://code.claude.com/docs/en/hooks#common-input-fields).

You can supply a destination immediately:

```text
/session-bridge:connect codex:YOUR_CODEX_TASK_UUID
```

Use `codex:UUID` for a Codex task that has not used the bridge yet. Connecting stores a pending connection silently. Claude's first message queues a notification to that task; the target can read it from its own shell and bind the connection without a reciprocal connect or MCP reload. Delivery still depends on the owning Codex client consuming its native queue. A UUID does not open an unloaded task. [Codex queue source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/ext/queue/src/service.rs)

An already registered peer accepts its bare UUID, or a `codex:` / `claude:` prefix. An unknown bare UUID returns `activation_required`; the bridge does not guess its provider. An inactive Claude target must first run `/session-bridge:connect` in that conversation. A UUID alone is not a route to another machine.

To list this conversation's connected peers, run:

```text
/session-bridge:sessions
```

It shows native IDs, providers, connection state and the latest reported status with its timestamp. Listing leaves an inactive bridge dormant. After updating the plugin, run `/reload-plugins` once to load the new command.

## Use an existing Codex task without reloading tools

Ask the task to read `skills/session-bridge/SKILL.md` from the checkout. It can use the CLI through its existing shell tool; caller identity comes from that task's own `CODEX_THREAD_ID`.

```bash
node /absolute/path/session-bridge/dist/cli.js connect \
  --host codex --target claude:CLAUDE_SESSION_UUID

node /absolute/path/session-bridge/dist/cli.js message-send \
  --host codex --target claude:CLAUDE_SESSION_UUID \
  --body-file /absolute/path/review-request.txt --key review-001

node /absolute/path/session-bridge/dist/cli.js sessions --host codex
```

Replace placeholders with actual native UUIDs and file paths. A request should name the desired result, relevant snapshot and execution limits. The bridge stores only the message you provide; it does not copy transcripts or attach file contents automatically.

On notification, the destination uses `bridge_messages_read({messageId})`, completes the authorized request, then sends its one substantive result with `bridge_message_send({sessionId,text,idempotencyKey,replyTo})`. `sessionId` identifies the original sender and `replyTo` the original request. Receipt tokens stay internal. Use `expectsReply: false` for an informational update, such as handoff acceptance. Notices and replies need no courtesy response.

## Inspect or disconnect

```bash
node dist/cli.js status-update --host codex --text "Reviewing the parser change."
node dist/cli.js messages-read --host codex --message MESSAGE_ID
node dist/cli.js disconnect --host codex --target PEER_SESSION_UUID
```

Incoming history includes previously read messages and receipt evidence. Inspect that evidence before repeating side effects. Selecting a sent message is read-only. `submitted` means the adapter handed off a notification; a receipt and a substantive reply are separate facts. An `unknown` outcome requires inspection, not an automatic resend. [Message lifecycle](docs/design.md#message-lifecycle)

Status is a timestamped self-report, not proof that a model is currently running. Disconnecting one peer fences pending bridge work on that connection; it does not undo completed actions or stop either native session.

## Optional Codex MCP installation

For tasks that can load newly configured MCP tools:

```bash
bridge_project="$PWD"
codex mcp add session-bridge -- node "$bridge_project/dist/cli.js" mcp --host codex
mkdir -p "$HOME/.agents/skills"
ln -s "$bridge_project/skills/session-bridge" "$HOME/.agents/skills/session-bridge"
```

Follow the host's refresh or session-start flow, then confirm the six methods above are available. The pinned Codex client sends current task identity in each MCP call's `_meta.threadId`; the bridge requires that fresh identity and never falls back to startup identity. If fresh native context is unavailable, use the CLI from the current task's shell. [Codex MCP call source](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/core/src/mcp_tool_call.rs#L506)

The `.codex-plugin` package also supports a personal marketplace installation. A packaged copy must include the locally built output and installed dependencies. Its MCP working directory is relative to the plugin root.

## Compatibility and scope

The default MCP catalog contains six methods. `mcp --host codex|claude --legacy-tools` explicitly opts into the old ten-tool catalog for the v0.2 migration window. Legacy CLI operations remain available for diagnostics, exceptional cancellation and full receiver shutdown; see [operator recovery](docs/support.md#operator-recovery). Existing `sb_…` IDs remain internal/operator identifiers, not the new public session address.

Connect only sessions within the user's authorized scope. Connections do not grant broader task or native permission authority. Local CLI access is operator authority under this OS account, not isolation against other processes running as you. Message contents may be processed by the receiving model provider. No bridge goal engine, workflow scheduler or automatic permission supervisor is included.

[Architecture](docs/design.md) · [Support and validation](docs/support.md) · [Shared skill](skills/session-bridge/SKILL.md)

Private project. `UNLICENSED`; no public distribution license is granted.
