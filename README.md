# Session Bridge

Connect Codex and Claude Code sessions that are already running. A session can pair with multiple peers, including peers of the same provider. Share peer IDs, send bounded requests to selected peers, and get replies in the original conversations.

The bridge keeps a local message ledger and uses the clients' existing delivery mechanisms: Codex's `queue` command and Claude Code's plugin monitors. It does not launch or resume model sessions. Small MCP and monitor helpers run alongside your clients; Codex delivery uses a brief CLI helper. Model authentication and usage remain with the official clients.

**Status:** private, early implementation for one user on one machine. The automated suite exercises the ledger, transports, and MCP with isolated test clients. Real model sessions have not yet been exercised for idle, busy, approval, or restart behavior. See [support and validation](docs/support.md) before relying on unattended delivery.

**Simplified next design:** [visual plan](docs/collaboration-v2.html) · [implementation plan](docs/collaboration-v2.md) · [six-method interface](docs/plugin-methods.md). Connect existing sessions by native ID, exchange messages, and share a short status. Goals and tasks stay native; collaboration belongs in the shared skill. Explicit Claude activation is available now.

The six-method facade, native-ID connection and status updates are not yet registered in the plugin. There is no planned bridge-owned goal/work engine or automatic permission supervisor. Current multi-peer behavior has been checked in an isolated ledger experiment; live multi-session delivery remains unverified.

## Build

Requires Node.js 24+, npm, Codex with `codex queue`, and interactive Claude Code with plugin monitors available. Both clients must run as the same OS user and use the same bridge data directory. Data defaults to `~/.local/state/session-bridge`; use `SESSION_BRIDGE_HOME` or CLI `--home /absolute/path` to select another private local directory. Apply the same choice to both clients and every bridge helper.

```bash
gh repo clone ItamarRocha/session-bridge
cd session-bridge
npm ci
npm run verify
node dist/cli.js doctor
```

Keep this checkout in a durable location. The plugin runs the built `dist/cli.js` and uses the installed `node_modules`; these are generated locally and are not checked into Git. Rebuild after updating the source.

## Connect two open sessions

### 1. Load the bridge in Claude Code

From the built checkout, make it a personal Claude plugin:

```bash
bridge_project="$PWD"
mkdir -p "$HOME/.claude/skills"
ln -s "$bridge_project" "$HOME/.claude/skills/session-bridge"
```

This command deliberately fails if that destination already exists. Inspect an existing installation before updating it. It does not replace a plugin or edit project settings.

In the **existing Claude session**, run `/reload-plugins` to load the plugin, then explicitly run `/session-bridge:connect` when you want to activate the bridge. Opening another Claude terminal leaves its bridge dormant. The connect command starts the monitor and posts a private attachment ticket into that conversation. Claude uses that ticket with `bridge_attach` and returns an `sb_...` ID. Share that ID with Codex. The attachment ticket stays in the Claude conversation; it is not the pairing code.

Personal plugin loading and monitors triggered by skill invocation are documented by [Claude Code](https://code.claude.com/docs/en/plugins-reference#monitors). Monitor availability varies by host and configuration; [the support guide](docs/support.md#claude-code) lists the constraints. If no notification arrives after the connect command, inspect the plugin errors and task panel before trying to attach. Monitors already running from an older installation remain running until explicitly stopped or the session exits.

### 2. Attach the open Codex task

An existing Codex task can use the CLI through its shell tool immediately. Ask it to read `skills/session-bridge/SKILL.md` from this checkout, then run the following **inside that task's shell tool**, replacing the absolute path:

```bash
node /absolute/path/session-bridge/dist/cli.js attach \
  --host codex --session-id "$CODEX_THREAD_ID" --label "Implementation"
```

The result contains this task's own `sb_...` peer ID. Use the exact native task UUID from its own environment; an empty or guessed ID cannot identify the intended task.

This route does not require a new Codex task or loading an MCP server into the active task. For MCP tools in future tasks, use [optional Codex installation](#optional-codex-mcp-installation).

### 3. Pair and send

Give Codex the Claude peer ID and a concrete task:

> Pair this task with `sb_…`. Ask it to review the proposed change in `/absolute/path/to/file`. Request findings only and leave file edits to this task.

The equivalent CLI calls are below. Replace the example IDs with the returned IDs. The bridge stores your explicit message body; it does not collect conversation history or attach files automatically.

```bash
node /absolute/path/session-bridge/dist/cli.js pair \
  --self sb_CODEX --peer sb_CLAUDE

node /absolute/path/session-bridge/dist/cli.js send \
  --self sb_CODEX --peer sb_CLAUDE \
  --body "Review /absolute/path/to/file for correctness. Return findings only." \
  --key review-001
```

Use `--body-file /absolute/path/request.txt` for longer requests. Repeating the same key and request returns the same ledger message; changing a request requires a new key. An ambiguous transport result is never an invitation to resend blindly.

The receiving session claims the message with `bridge_receive`, completes the authorized request, then calls `bridge_reply` with its claim ID. A reply returns to the original Codex task through its native queue. The bundled skill supplies this workflow to both agents. `notice` messages and replies are terminal; acknowledgments do not create another model turn.

## Check or stop an exchange

All CLI results are JSON. The same operations are exposed as MCP tools after attachment.

```bash
node dist/cli.js peers
node dist/cli.js status --self sb_CODEX
node dist/cli.js status --self sb_CODEX --message msg_ID
node dist/cli.js cancel --self sb_CODEX --message msg_ID
node dist/cli.js disconnect --self sb_CODEX --pairing pair_ID
node dist/cli.js stop --self sb_CODEX
```

Read IDs from command output; the illustrative values above are not valid identities. `cancel` closes an individual request, `disconnect` closes a pairing, and `stop` closes the peer. They cannot undo work already performed. Stopping a bridge peer does not stop its model session.

`submitted` means a transport accepted the wake-up attempt. `acknowledgedAt` means the destination explicitly claimed the message. `answeredBy` identifies its recorded reply. An `unknown` delivery outcome needs inspection; it is not automatically retried. [The lifecycle](docs/design.md#message-lifecycle) explains these distinctions.

## Optional Codex MCP installation

For tasks that can load newly configured MCP tools:

```bash
bridge_project="$PWD"
codex mcp add session-bridge -- node "$bridge_project/dist/cli.js" mcp --host codex
mkdir -p "$HOME/.agents/skills"
ln -s "$bridge_project/skills/session-bridge" "$HOME/.agents/skills/session-bridge"
```

These are installation commands for you to run; building the repository does not change your client configuration. Follow the host's refresh or session-start flow, then confirm that `bridge_attach` is available. Codex's documented plugin installation flow uses a [new conversation](https://learn.chatgpt.com/docs/plugins); use the CLI route above for an already running task that cannot reload tools.

Ask the agent to attach with its exact native task UUID. The MCP process is bound to one peer, so other tools do not take a caller-supplied `self` ID. The `.codex-plugin` package is also included for a personal marketplace installation. Its MCP configuration uses a plugin-relative working directory; a marketplace copy must include the locally built output and installed dependencies.

## Scope

- Pair only sessions you control, with a specific request and a clear owner for file changes.
- Keep the bridge's data directory local to this OS account. Local CLI access is operator authority, not a security boundary against other programs running as you.
- Messages can contain private project content. Only include material the other model provider is allowed to process.
- Client permissions, usage limits, and organizational controls still apply. This project does not modify clients or their account credentials and does not implement proprietary inbox protocols.

[Architecture](docs/design.md) · [Support and validation](docs/support.md) · [Agent workflow](skills/session-bridge/SKILL.md)

Private project. `UNLICENSED`; no public distribution license is granted.
