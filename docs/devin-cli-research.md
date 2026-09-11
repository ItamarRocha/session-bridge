# Devin CLI integration research

Checked 2026-09-11 against current first-party documentation. Target installed release: `3000.10.21 (611c1cba)`. The official stable changelog identifies `3000.10.21` as the September 10, 2026 release. [Stable changelog](https://docs.devin.ai/cli/changelog/stable#v3000-10-21)

## Recommendation

Add Devin as a native-session, hook-assisted mailbox client using the same six Session Bridge methods. Make its receiver capability explicit: it can collect messages at lifecycle boundaries and on an explicit inbox read; a supported unsolicited wakeup of an already-idle local Devin session has **not been found**. Do not promise the Codex queue or Claude Monitor experience for Devin yet.

This is an integration recommendation derived from the documented interfaces below, not a claim of a completed native trial.

## Supported interfaces

| Need | Evidence | Implication |
| --- | --- | --- |
| Plugin packaging | Devin manifests live at `.devin-plugin/plugin.json`; plugins can contribute skills, rules, hooks, and MCP servers. Manifest precedence is Devin, then Claude, then root Agent Plugins format. [Plugins](https://docs.devin.ai/cli/extensibility/plugins/overview#compatible-formats) | Supply an explicit Devin manifest so the Claude fallback cannot select the wrong host configuration. |
| Installation | `devin plugins install --local PATH` installs on this machine. Without `--local`, installation updates the personal cloud plugin manifest. Local-folder plugins link to the folder; edits apply to the next session. [Installation](https://docs.devin.ai/cli/extensibility/plugins/overview#installing-a-plugin) | Use a local installation for this local bridge. |
| MCP declaration | Manifest `mcpServers` supports a file path or an inline map; an exclusive paths declaration suppresses conventional root configs. [Plugin MCP servers](https://docs.devin.ai/cli/extensibility/plugins/overview#mcp-servers) | Reuse the existing server with a Devin-specific host argument. |
| MCP runtime | Devin launches configured stdio tool servers and calls their tools; HTTP is also supported. Dedicated user config is `~/.config/devin/mcp_config.json` since v3000.3. [MCP overview](https://docs.devin.ai/cli/extensibility/mcp/overview#how-it-works), [configuration](https://docs.devin.ai/cli/extensibility/mcp/configuration#via-config-file) | Tool-server subprocesses are supported; no model subprocess is required. |
| Current native identity | Every command-hook stdin payload contains stable `session_id`; `prompt_id` changes each user turn. `DEVIN_PROJECT_DIR` supplies the project root. [Command hooks](https://docs.devin.ai/cli/extensibility/hooks/overview#command-hooks) | Bind to host-supplied identity. No documented MCP per-call identity or `DEVIN_SESSION_ID` environment variable was found. |
| Per-call argument adaptation | `PreToolUse` can return `hookSpecificOutput.updatedInput`, merged into the tool arguments. Matchers are regexes against names such as `mcp__server__tool`. [Hook output](https://docs.devin.ai/cli/extensibility/hooks/overview#output-format), [matching](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks#using-the-matcher) | A hook can supply current-session context to the bridge without asking the model to choose its own identity. |
| Active-turn inbox notice | `PostToolUse` and `UserPromptSubmit` can inject `additionalContext`; `SessionStart` can also add context. [Lifecycle hooks](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks) | After explicit activation, emit a small pending-inbox hint at a supported boundary; the model reads the existing durable inbox. |
| End-of-turn check | `Stop` can return a blocking reason that continues the current turn; the documentation warns that unconditional blocking can loop. [Stop hook](https://docs.devin.ai/cli/extensibility/hooks/lifecycle-hooks#stop) | At most use a bounded check for newly actionable work. Do not convert it into perpetual polling. |
| Session discovery | `devin list --format json` lists sessions in the current directory; `--resume` and `--continue` resume sessions. [Commands](https://docs.devin.ai/cli/reference/commands#devin-list) | Discovery is not delivery. A saved session need not have a live receiver. |
| Inline commands | Skills run inside the current conversation by default. `subagent`/`agent` fields opt into independent workers. [Creating skills](https://docs.devin.ai/cli/extensibility/skills/creating-skills) | Keep bridge skills inline, with no model or subagent override. |

## Identity and delivery boundaries

The changelog says newer native sessions use memorable word-pair IDs. Hook identity fields arrived in v3000.2.17; plugin hooks gained `DEVIN_PLUGIN_ROOT` in v3000.5.20. v3000.10.21 adds `tool_provenance` to `PreToolUse`. Treat native IDs as opaque, case-preserving values; do not assume UUID syntax, normalize case, or infer identity from the newest session in a directory. [Stable changelog](https://docs.devin.ai/cli/changelog/stable)

Plugin hooks are documented as best effort and fail open. The bridge rejects missing or invalid per-call identity; its hook overwrites stale supplied context on every bridge call. This follows the existing same-user local tool trust model: the hook argument is not cryptographic authentication against another process running as that OS user. Registration and message collection remain inactive until the user connects. [Plugin hooks](https://docs.devin.ai/cli/extensibility/plugins/overview)

No documented local external enqueue command, attachment socket, MCP channel, or asynchronous monitor callback was found in the command reference, extensibility pages, configuration reference, or stable changelog. The configurable terminal notifications announce completion/input requests to the human terminal; they do not inject messages into the agent. Consequently an idle session may retain unread messages until the next user turn. [Commands](https://docs.devin.ai/cli/reference/commands), [notification settings](https://docs.devin.ai/cli/reference/configuration/config-file#notify)

## Interfaces that do not satisfy this task

- `devin acp` starts a JSON-RPC stdio server intended to be launched by an editor as a subprocess. This is not a documented attachment to an existing interactive TUI. Do not launch it or resume a replacement model process to simulate wakeups. [ACP command](https://docs.devin.ai/cli/reference/commands#devin-acp), [Zed integration](https://docs.devin.ai/cli/acp/zed#notes-and-limitations)
- Devin Cloud and Devin CLI are separate products. The hosted Devin MCP server exposes cloud session management, including interaction, but that does not establish access to a local CLI task. [CLI versus cloud](https://docs.devin.ai/cli#devin-cli-vs-devin), [hosted Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp#session-management)
- The public `CognitionAI/devin-cli` repository contains a README, release workflow, and manifest-release script; it does not expose the local agent implementation needed to verify undocumented IPC. [Repository](https://github.com/CognitionAI/devin-cli), [release script](https://github.com/CognitionAI/devin-cli/blob/main/scripts/release_from_manifest.py)

## Native acceptance checks before claiming support

1. Two existing Devin sessions bind different host-provided identities, including word-pair IDs, while sharing one directory.
2. Opening a new terminal loads the plugin without connecting, registering a receiver, or reading peer messages.
3. Explicit connection supports send/list/status/read/disconnect through the existing public method names.
4. Several arrivals during work produce one bounded hint and no automatic acknowledgement loop; reading receipts does not erase unfinished requests.
5. An idle Devin session is reported honestly as awaiting a lifecycle boundary; no hidden process, synthetic terminal input, or cloud API supplies a wakeup.
6. An absent hook leaves context unavailable; an installed hook clears missing/invalid identity and replaces stale tool arguments with the current native session. Closed sessions remain fenced.

No installation, cloud API request, or message delivery was performed as part of this documentation research.
