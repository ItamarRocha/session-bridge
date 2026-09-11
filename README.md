# Session Bridge

[![Verify](https://github.com/ItamarRocha/session-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ItamarRocha/session-bridge/actions/workflows/ci.yml)

**Connect your running Codex, Claude Code and Devin CLI sessions.**

Ask Claude to review a commit while Codex keeps building. Delegate a benchmark to another session. Share a result without copying it between terminals. Each session keeps its own conversation, tools, and permissions.

```mermaid
flowchart LR
    Codex["Existing Codex task"] <--> Bridge["Session Bridge<br/>connections · messages · receipts"]
    Bridge <--> Claude["Existing Claude Code session"]
    Bridge <--> Devin["Existing Devin CLI session"]
```

Sessions connect by their native IDs. Each can talk to multiple peers, publish quiet “working on” status, and exchange meaningful requests and results. Incoming messages share one outstanding inbox notification per recipient and bridge directory. The bridge uses Codex's native queue, Claude's native Monitor and Devin's lifecycle hooks. Devin receives notices after tool activity or at its next prompt; it cannot be woken while already idle. Small local helpers carry messages between the existing model sessions.

**v0.5.0 · experimental · local macOS sessions under one OS account.** Devin CLI joins the same six-method interface. Its native acceptance is pending, as is the v0.4 notification-batching trial. The confirmed native Claude → Codex → Claude roundtrip used v0.3.0; see [validation](docs/validation.md).

## Quick start

You need **Node.js 24+**, npm and the supported interface for each participating client: Codex with `codex queue`, interactive Claude Code with native `Monitor`, or Devin CLI with plugin hooks. Availability depends on the client and configuration; see [requirements](docs/getting-started.md#requirements).

### 1. Build the bridge

Keep the checkout in a permanent location: the plugin runs its built files directly.

```bash
git clone https://github.com/ItamarRocha/session-bridge.git
cd session-bridge
npm ci
npm run build
node dist/cli.js doctor
```

### 2. Load it into Claude

From that checkout, register a [personal directory plugin](https://code.claude.com/docs/en/plugins-reference#skills-directory-plugins):

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

If the destination already exists, inspect it before replacing it. In your existing Claude conversation, run:

```text
/reload-plugins
```

Loading the plugin makes the commands available. Receiver activation is explicit.

### 3. Connect and send

Ask your existing Codex task for its native ID—it comes from `CODEX_THREAD_ID` in that task's shell. Then, in Claude:

```text
/session-bridge:connect codex:YOUR_CODEX_TASK_UUID
```

Ask Claude:

> Send the connected Codex task a connectivity test and ask it to reply “pong from Codex.”

The first message notifies that Codex task; reading it binds the connection. A reciprocal connect is unnecessary. To see your peers and their status:

```text
/session-bridge:sessions
```

For Devin, install the built checkout locally with `devin plugins install --local "$PWD"`, then use `/session-bridge:connect PEER_NATIVE_ID` in the intended conversation. A selected peer is required; opening a session or listing peers stays passive. See [Devin setup](docs/getting-started.md#load-the-plugin-in-devin-cli) for the hook and delivery requirements.

For the Codex-first flow, client resume, optional MCP setup, shared data directories, or profile routing, follow the [setup guide](docs/getting-started.md). Existing users should read the [v0.5 upgrade steps](docs/support.md#upgrading-to-v050) before opening an older ledger.

## Six methods

| Method | Purpose |
| --- | --- |
| `bridge_connect` | Connect to one selected native session ID. |
| `bridge_sessions_list` | See connected peers, receiver capability, inbox state, and reported work. |
| `bridge_status_update` | Publish your own short “working on” line. |
| `bridge_message_send` | Send a bounded request, informational update, or reply. |
| `bridge_messages_read` | Read incoming messages or inspect an exchange. |
| `bridge_disconnect` | Disconnect one peer while keeping your other connections. |

Use status for routine progress. Send a message when a peer needs to answer a question, resolve a blocker, consider a new actionable finding, or receive a final result/handoff. Goals, handoffs, and reviews stay in the agents' native task state and conversation. The [shared skill](skills/session-bridge/SKILL.md) explains how to delegate, review, and continue independent work with these methods. See the [method reference](docs/methods.md) for arguments and return values.

## What delivery means

```text
Message:       queued → read → replied
Notification:  pending → submitting → submitted or unknown
```

Several messages share one inbox wakeup. Sending returns `recipientInbox`; session listings expose `self.inbox` and each peer's `inbox`. They contain unread and pending-request counts plus notification state. A message can remain `queued` after the shared notification was submitted; only its read records receipt. Pending-request counts include requests already read but not answered. Receiver summaries also report `idleWakeAvailable`: it is `false` for Devin, whose hook delivery waits for a lifecycle boundary.

A delivered notification carries an opaque token, which is deliberately absent from status responses. Reading with that token consumes one bounded page and permits another wakeup if unread messages remain. Ordinary polling does not consume it. Token replays report prior reads with `actionable: false`; inspect the original request through history or a targeted read before resuming unfinished work.

Messages and connections survive Claude receiver restart. Pending notifications whose submission never started can resume. Notifications already `submitting`, `submitted` or `unknown` are preserved without re-emission. This conservative behavior replaces the v0.3 restart replay: inspect visible notification state and use ordinary history/unread reads to recover stored work when needed. Native queue backlog cannot be recalled.

The bridge stores selected message text locally. Content may be processed by the receiving model provider. It works between sessions sharing one local ledger; cloud routing and automatic cross-agent permission approval are outside this version.

## Documentation

| Guide | Read it for |
| --- | --- |
| [Getting started](docs/getting-started.md) | Installation, connection flows, and configuration. |
| [Method reference](docs/methods.md) | The six tools, identity, message limits, and receipts. |
| [Collaboration](docs/collaboration.md) | Delegation, handoffs, and review examples. |
| [Architecture](docs/architecture.md) | The ledger, receiver lifecycle, and native adapters. |
| [Troubleshooting](docs/support.md) | Receiver recovery, profile routing, and upgrades. |
| [Validation](docs/validation.md) | What automated checks and native trials establish. |
| [Contributing](CONTRIBUTING.md) | Repository layout and development checks. |

A [visual collaboration guide](docs/collaboration.html) is also included; open the local HTML file in a browser after cloning.

## License

Session Bridge is licensed under the [MIT License](LICENSE).

Source builds are supported; the package is not published to npm.
