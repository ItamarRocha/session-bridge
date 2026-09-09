# Getting started

[Overview](../README.md) · [Method reference](methods.md) · [Troubleshooting](support.md)

Session Bridge connects existing conversations. Install the helpers once, activate Claude's receiver when you want to connect, and use native session IDs to address peers.

## Requirements

- macOS, with all participants running under the same OS account.
- Node.js 24+ and npm, available in each client's helper environment.
- A Codex client exposing `codex queue --thread … --message …`.
- Interactive Claude Code with the native `Monitor` tool available.
- The same local bridge data directory for both sides.

The development baseline is Codex CLI **0.153.1** and Claude Code **2.1.261**. A version number alone does not prove that the running host exposes the required capability. Run `doctor` from the environment that launches the helpers and inspect the actual client tools. See [validation](validation.md) for observed behavior and [Claude support](support.md#claude-code) for host restrictions.

## Build from source

```bash
git clone https://github.com/ItamarRocha/session-bridge.git
cd session-bridge
npm ci
npm run build
node dist/cli.js doctor
```

Keep this checkout in a permanent location. `dist/` and `node_modules/` are generated locally and are required at runtime. A source archive or plugin manifest alone is insufficient. Rebuild after updating source; use [the upgrade procedure](support.md#upgrading-to-v040) when an older helper or ledger is involved.

`doctor` checks runtime versions, native queue help, and the selected Codex profile. It does not send a message or establish model receipt.

## Load the plugin in Claude

### Existing interactive conversation

Current Claude Code supports full plugins in its personal skills directory. From the built checkout:

```bash
bridge_project="$PWD"
bridge_plugin="$HOME/.claude/skills/session-bridge"
if [ -e "$bridge_plugin" ] || [ -L "$bridge_plugin" ]; then
  printf 'Inspect the existing plugin path before continuing: %s\n' "$bridge_plugin"
else
  mkdir -p "$HOME/.claude/skills"
  ln -s "$bridge_project" "$bridge_plugin"
fi
```

The check also catches dangling symlinks. Inspect an existing destination before changing it. Keep one installation of this plugin available to the conversation to avoid duplicate tools and hooks.

In the intended Claude conversation, run `/reload-plugins` and confirm that `/session-bridge:connect` and `/session-bridge:sessions` are available. Follow any reload instructions from the client. Installation exposes the MCP tools, commands, and identity hook; it does not start a receiver. [Claude directory plugins](https://code.claude.com/docs/en/plugins-reference#skills-directory-plugins)

### Session-scoped plugin or resumed conversation

If you prefer a plugin for one CLI invocation, use an absolute path to the built checkout:

```bash
claude --plugin-dir /absolute/path/session-bridge
```

To keep an existing conversation, exit its current CLI process and resume the same native session with the plugin loaded:

```bash
claude --resume YOUR_CLAUDE_SESSION_UUID \
  --plugin-dir /absolute/path/session-bridge
```

This is a client launch/resume option, not attachment to an already running process. Choose either this route or the personal directory installation. The bridge itself does not launch a Claude model session. [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)

## Connect from Claude to Codex

1. Ask the existing Codex task for its own native ID, available as `CODEX_THREAD_ID` in that task's shell. A separate ordinary terminal is not the source of that task's identity.
2. In Claude, run `/session-bridge:connect codex:YOUR_CODEX_TASK_UUID`. This explicitly starts its native Monitor receiver when needed and saves the connection.
3. Ask Claude to send a bounded request. Reading the delivered inbox notification binds the Codex recipient without a reciprocal connect. If Codex lacks the MCP tool, its notification includes an absolute CLI fallback.
4. Confirm that the reply was read in the original Claude conversation. Submission alone is not the end-to-end result.

An initial `pending` connection is expected for a Codex task that has not attached yet. Its client must still consume the native queue; connecting does not open an unloaded task.

## Connect from Codex to Claude

In the intended Claude conversation, run `/session-bridge:connect` without a destination. It activates the receiver and returns that conversation's native ID.

Ask the existing Codex task to read the shared skill at `/absolute/path/session-bridge/skills/session-bridge/SKILL.md`. It can run the CLI from its own shell:

```bash
node /absolute/path/session-bridge/dist/cli.js connect \
  --host codex --target claude:YOUR_CLAUDE_SESSION_UUID

node /absolute/path/session-bridge/dist/cli.js message-send \
  --host codex --target claude:YOUR_CLAUDE_SESSION_UUID \
  --body-file /absolute/path/request.txt --key review-001
```

Create `request.txt` with the desired result, the relevant commit or snapshot, and the allowed execution/file scope. Reuse a key only for identical input. The CLI derives the caller's identity from the current Codex task environment.

A never-registered Claude target needs its initial activation. A registered target can accept queued messages while its receiver is unavailable; explicit receiver restart is required for notification.

## List, update, or disconnect

In Claude, `/session-bridge:sessions` shows connected peers, receiver availability, unread counts, notification state and their latest reported work. It leaves an inactive receiver inactive.

From a connected Codex task's shell:

```bash
node /absolute/path/session-bridge/dist/cli.js sessions --host codex
node /absolute/path/session-bridge/dist/cli.js status-update --host codex --text "Reviewing the parser."
node /absolute/path/session-bridge/dist/cli.js messages-read --host codex --notification-token DELIVERED_TOKEN
node /absolute/path/session-bridge/dist/cli.js messages-read --host codex --unread-only
node /absolute/path/session-bridge/dist/cli.js messages-read --host codex --message MESSAGE_ID
node /absolute/path/session-bridge/dist/cli.js disconnect --host codex --target PEER_NATIVE_UUID
```

Status exposes inbox counts and notification state without its opaque token. `DELIVERED_TOKEN` comes from the native notice. The default read remains incoming history. Use `bridge_messages_read({unreadOnly: true})` for manual unread inspection. When handling a delivered notification, pass its `notificationToken` exactly as provided; ordinary polling does not consume the pending wakeup. A token implies an unread page, default 20 and maximum 100; omit `messageId`/`cursor` or CLI `--message`/`--cursor`. Its result includes `notification: {consumed, replayed, remaining}`, `inbox`, and `nextCursor: null`. Replayed messages are non-actionable; inspect prior work and use history or `messageId` to recover unfinished requests.

Native IDs may be provider-prefixed. Use `codex:UUID` for an unregistered Codex destination; unknown bare UUIDs cannot identify their provider. Disconnecting one peer keeps other connections and both native sessions intact.

## Configuration

| Setting | Purpose |
| --- | --- |
| `SESSION_BRIDGE_HOME` | Shared private data directory. Default: `~/.local/state/session-bridge`. CLI `--home` overrides it. |
| `SESSION_BRIDGE_CODEX_COMMAND` | Codex executable used for queue delivery. Default: `codex` on `PATH`; CLI `--codex-command` overrides it. |
| `SESSION_BRIDGE_CODEX_HOME` | Optional absolute Codex profile home for the destination. Applied only to the Codex child command. |

Set launch-time variables consistently before starting the relevant helpers. If Claude was launched by a profile manager, verify that Codex delivery targets the profile owning the selected task. Native `sqlite_home` or `CODEX_SQLITE_HOME` settings can further select queue storage; see [profile routing](support.md#codex-profile-routing).

Prefer one permanent bridge directory for normal use. Each directory has its own notification state, so several test ledgers can each queue a wakeup to the same native task. For an isolated trial, choose a private directory and give that same path to all participants. A selected Codex task's notification includes the ledger path in its CLI fallback. Keep the trial ledger available while testing receipt and restart recovery.

## Optional Codex MCP installation

The CLI fallback works in an existing task without changing its tool catalog. If your Codex client can load new MCP tools, install from the built checkout:

```bash
bridge_project="$PWD"
codex mcp add session-bridge -- node "$bridge_project/dist/cli.js" mcp --host codex
bridge_skill="$HOME/.agents/skills/session-bridge"
if [ -e "$bridge_skill" ] || [ -L "$bridge_skill" ]; then
  printf 'Inspect the existing skill path before continuing: %s\n' "$bridge_skill"
else
  mkdir -p "$HOME/.agents/skills"
  ln -s "$bridge_project/skills/session-bridge" "$bridge_skill"
fi
```

Inspect an existing skill path before replacing it. Follow the host's refresh/session flow, then check that the six bridge methods are available. This path requires fresh per-call native identity; if the host does not provide it, use the CLI from the current task's shell. The bridge never falls back to an MCP startup identity. [Codex identity contract](methods.md#native-identity-and-connection)

The repository also includes a `.codex-plugin` manifest for hosts that support local plugin installation. It needs the same built files and dependencies. Packaged Codex installation has not received a separate native acceptance trial; the verified live route uses the task-shell CLI.
