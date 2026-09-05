---
name: connect
description: Activate Session Bridge in this Claude conversation when you want to connect it to another coding session.
disable-model-invocation: true
---

# Connect this session

This command is the user's explicit request to activate Session Bridge in the current conversation. Merely opening a terminal or loading the plugin does not activate a bridge.

1. Check `bridge_status` first. If this MCP connection has an open attachment, reuse its peer and pairing instead of redeeming another ticket. The error "Attach this session with bridge_attach first" means it is unbound. A closed attachment needs monitor recovery through the support guide, not a reused ticket.
2. If unbound, use the private ticket from this session's inbox monitor startup notification with `bridge_attach({ticket})`. Invoking this command starts the plugin monitor once. If no notification arrives, inspect plugin/monitor availability; do not invent a ticket or create another model session.
3. Pair only with the peer selected by the user. If none was supplied, return this session's shareable peer ID. Keep attachment tickets in this conversation.
4. Continue with `${CLAUDE_PLUGIN_ROOT}/skills/session-bridge/SKILL.md` for request/reply handling within the user's scope.

The current release still uses `sb_...` peer IDs. Native-ID invitations and delegated permissions are proposed in the collaboration design; do not claim they are available before implementation.
