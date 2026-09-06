import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { claudeContextHook } from '../src/context-hook.js';

test('Claude context hook replaces a stale MCP identity with the current native session on every bridge method', () => {
  const nativeId = randomUUID();
  const toolInput = { sessionId: randomUUID(), text: 'Keep this input', _sessionId: randomUUID() };
  const before = { ...toolInput };
  const config = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  const matcher = new RegExp(config.hooks.PreToolUse[0].matcher);
  for (const prefix of ['mcp__session-bridge__', 'mcp__plugin_session-bridge_session-bridge__']) {
    for (const method of [
      'bridge_connect', 'bridge_sessions_list', 'bridge_status_update',
      'bridge_message_send', 'bridge_messages_read', 'bridge_disconnect',
    ]) {
      const toolName = `${prefix}${method}`;
      assert.equal(matcher.test(toolName), true);
      assert.deepEqual(claudeContextHook({
        hook_event_name: 'PreToolUse', tool_name: toolName, session_id: nativeId, tool_input: toolInput,
      }), {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse', updatedInput: { ...toolInput, _sessionId: nativeId },
        },
      });
    }
  }
  assert.deepEqual(toolInput, before);
});

test('Claude context hook leaves other tools and lifecycle events unchanged', () => {
  for (const toolName of [
    'Bash', 'bridge_connect', 'mcp__other__bridge_connect',
    'mcp__plugin_session-bridge_other__bridge_connect',
    'mcp__session-bridge__bridge_attach', 'mcp__session-bridge__bridge_connect_extra',
  ]) {
    assert.equal(claudeContextHook({
      hook_event_name: 'PreToolUse', tool_name: toolName, session_id: randomUUID(), tool_input: {},
    }), null);
  }
  assert.equal(claudeContextHook({
    hook_event_name: 'SessionStart', tool_name: 'mcp__session-bridge__bridge_connect',
    session_id: randomUUID(), tool_input: {},
  }), null);
  assert.equal(claudeContextHook(null), null);
});

test('missing fresh identity clears a supplied identity so the bridge fails closed', () => {
  for (const sessionId of [undefined, '', 'not-a-uuid', 123]) {
    assert.deepEqual(claudeContextHook({
      hook_event_name: 'PreToolUse', tool_name: 'mcp__session-bridge__bridge_connect',
      session_id: sessionId, tool_input: { sessionId: 'selected-peer', _sessionId: randomUUID() },
    }), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse', updatedInput: { sessionId: 'selected-peer', _sessionId: null },
      },
    });
  }
});


test('CLI hook accepts a maximum-size message after JSON escaping expands its envelope', () => {
  const sessionId = 'abcdef01-2222-4333-8444-555555555555';
  const input = {hook_event_name: 'PreToolUse', session_id: sessionId,
    tool_name: 'mcp__session-bridge__bridge_message_send', tool_input: {text: '"'.repeat(32768)}};
  const output = JSON.parse(execFileSync(process.execPath, [resolve('dist/cli.js'), 'context-hook'], {input: JSON.stringify(input), encoding: 'utf8'}));
  assert.equal(output.hookSpecificOutput.updatedInput._sessionId, sessionId);
  assert.equal(output.hookSpecificOutput.updatedInput.text, input.tool_input.text);
});

test('CLI hook preserves multibyte characters split across stdin writes', {timeout: 5000}, async t => {
  const text = 'Review résumé and 🧪 results';
  const body = Buffer.from(JSON.stringify({hook_event_name: 'PreToolUse', session_id: randomUUID(),
    tool_name: 'mcp__session-bridge__bridge_message_send', tool_input: {text}}));
  const child = spawn(process.execPath, [resolve('dist/cli.js'), 'context-hook'], {stdio: ['pipe', 'pipe', 'pipe']});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  const accent = body.indexOf(Buffer.from('é')) + 1;
  const emoji = body.indexOf(Buffer.from('🧪')) + 2;
  child.stdin.write(body.subarray(0, accent));
  await delay(250);
  child.stdin.write(body.subarray(accent, emoji));
  await delay(100);
  child.stdin.end(body.subarray(emoji));
  const [code] = await exited;
  assert.equal(code, 0, errors);
  assert.equal(JSON.parse(output).hookSpecificOutput.updatedInput.text, text);
});
