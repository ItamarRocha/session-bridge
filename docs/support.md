# Support and validation

The bridge is designed for local macOS sessions under one OS account. Node.js 24 or newer is required. The initial development environment had Codex CLI 0.153.1 and Claude Code 2.1.261; a client already running can be older than the binary currently on disk.

## Codex

Run `codex queue --help` to confirm the queue interface is available. The bridge must use the same Codex home and queue configuration as the owning task. A queue write is useful only when that owning client notices and consumes it; the bridge does not open an unloaded task for you.

An already-running task can call the CLI through its shell tool without new plugin tools. The user or task supplies its exact native UUID. When available, `CODEX_THREAD_ID` from that task's own shell environment is the intended source. Shell environment propagation into an MCP helper is not assumed.

The packaged Codex MCP configuration sets `cwd` to `.`. The published [plugin MCP parser](https://github.com/openai/codex/blob/rust-v0.153.1/codex-rs/codex-mcp/src/plugin_config.rs) resolves a relative working directory against the plugin root. It does not depend on a Claude-specific plugin-root variable.

A successful queue command does not prove that the model observed a message. Check for the bridge claim and reply. Idle delivery timing, interaction with a busy turn, paused tasks, and approval prompts need live verification on each supported host/version. There is no promised wake-up latency.

## Claude Code

Use an interactive CLI session with a personal plugin. Project-scope skills-directory plugins do not load monitors. `/reload-plugins` loads changed components and starts eligible monitors; disabling a plugin alone does not stop an already-running monitor. See the official [plugin reference](https://code.claude.com/docs/en/plugins-reference#skills-directory-plugins).

The [Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool) is unavailable on Amazon Bedrock, Google Cloud's Agent Platform, Microsoft Foundry, and when `DISABLE_TELEMETRY` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set. Respect those host choices; this project does not switch flags or bypass availability checks. Plugin monitors are experimental and their behavior can change.

The monitor and MCP helper must use the same Node installation and bridge directory. If the host cannot find `node`, correct its launch environment or use the absolute Node path in the two Claude plugin commands. Keep that local configuration out of shared commits when the path is machine-specific.

A monitor attachment ticket belongs to one receiver process and is single-use. If the MCP connection restarts, restart the bridge monitor and attach to its new ticket. Treat the new peer as a new connection and pair it explicitly. The ledger preserves history; it does not silently reauthorize a replacement connection.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Build fails or SQLite cannot load | Confirm `node --version` is 24+ and run `npm ci` before building. |
| Claude tools are absent | Check `/plugin` errors and `/mcp`; reload the personal plugin. |
| Claude monitor never appears | Check interactive CLI mode, personal scope, and Monitor availability. |
| Attachment ticket is rejected | Use the ticket from this session's live monitor; restart that monitor after a lost MCP binding. |
| A peer is unavailable | Run `peers` and inspect whether the peer is closed or its monitor stopped. |
| Codex stays at `submitted` | Check the exact task, owning client, native queue, and any approval or pause state. |
| Delivery is `unknown` | Inspect the destination and ledger. Do not automatically create a replacement send. |
| A claim expired | Check what work happened. A new claim must not repeat uncertain side effects. |
| Files were edited by both sessions | Scope ownership in the next request; file ownership is advisory. |

Use `node dist/cli.js doctor` for local capabilities and `status --self <peer-ID>` for bridge state. The bridge does not inspect account secrets or private client internals to diagnose failures.

## What automated checks establish

Run `npm run verify`. The suite validates the local implementation with isolated state and test clients, including ledger transitions, argument handling, adapter failures, and MCP request/reply behavior. No existing user's model session is contacted by these tests.

These checks do **not** prove the real agent follows the skill, that host notifications wake every idle session, or that permission prompts and busy turns behave correctly. An end-to-end trial must observe all of: the original destination receives the request, that session claims it once, it produces one substantive reply, the original sender receives the reply, and both sessions remain under their original owners.

## Live acceptance checklist

Before treating the bridge as ready for unattended work, explicitly select two test sessions and a harmless request, then record:

1. Exact client versions, host, and task/peer identities.
2. One request/reply in each direction while idle.
3. A request delivered while the destination is busy, with no replacement session.
4. Cancellation and disconnection before claim, including a notification already queued.
5. A monitor/MCP restart that requires fresh attachment rather than inheriting authority.
6. An interrupted delivery that remains visibly uncertain and is not replayed.
7. Normal client approval behavior when a request needs a permission-gated action.

The repository's initial build has not performed this live acceptance trial.
