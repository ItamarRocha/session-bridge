import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { claudeContextHook, devinContextHook } from '../src/context-hook.js';

test('Claude context hook replaces a stale MCP identity with the current native session on every bridge method', () => {
  const nativeId = randomUUID();
  const toolInput = { sessionId: randomUUID(), text: 'Keep this input', _sessionId: randomUUID() };
  const before = { ...toolInput };
  const config = JSON.parse(readFileSync(new URL('../claude-hooks.json', import.meta.url), 'utf8'));
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


test('Devin context hook preserves native word-pair case and replaces stale identity on all six methods', () => {
  const nativeId = 'Gentle-Falcon';
  const config = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url), 'utf8'));
  const matcher = new RegExp(config.hooks.PreToolUse[0].matcher);
  assert.deepEqual(Object.keys(config.hooks).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptSubmit']);
  const input = { sessionId: 'codex:abcdef01-2222-4333-8444-555555555555', text: 'Review the snapshot', _sessionId: 'Old-Session' };
  const original = { ...input };
  for (const method of [
    'bridge_connect', 'bridge_sessions_list', 'bridge_status_update',
    'bridge_message_send', 'bridge_messages_read', 'bridge_disconnect',
  ]) {
    assert.equal(matcher.test(`mcp__session-bridge__${method}`), true);
    const result = devinContextHook({hook_event_name: 'PreToolUse', session_id: nativeId,
      tool_name: `mcp__session-bridge__${method}`, tool_input: input});
    assert.deepEqual(result, {hookSpecificOutput: {
      hookEventName: 'PreToolUse', updatedInput: {...input, _sessionId: nativeId},
    }});
  }
  const changed = devinContextHook({hook_event_name: 'PreToolUse', session_id: 'gentle-falcon',
    tool_name: 'mcp__session-bridge__bridge_messages_read', tool_input: input});
  assert.equal(changed!.hookSpecificOutput.updatedInput._sessionId, 'gentle-falcon');
  assert.deepEqual(input, original);
});

test('Devin hook clears missing and invalid native context without intercepting unrelated tools', () => {
  for (const sessionId of [undefined, null, 123, '', '../session', 'has space', 'bad\nidentity', 'x'.repeat(129)]) {
    const result = devinContextHook({hook_event_name: 'PreToolUse', session_id: sessionId,
      tool_name: 'mcp__session-bridge__bridge_messages_read', tool_input: {_sessionId: 'Old-Session'}});
    assert.deepEqual(result, {hookSpecificOutput: {
      hookEventName: 'PreToolUse', updatedInput: {_sessionId: null},
    }});
  }
  for (const name of ['Bash', 'bridge_connect', 'mcp__other__bridge_connect',
    'mcp__plugin_session-bridge_session-bridge__bridge_connect', 'mcp__session-bridge__bridge_attach']) {
    assert.equal(devinContextHook({hook_event_name: 'PreToolUse', session_id: 'Gentle-Falcon', tool_name: name, tool_input: {}}), null);
  }
  assert.equal(devinContextHook({hook_event_name: 'SessionStart', session_id: 'Gentle-Falcon',
    tool_name: 'mcp__session-bridge__bridge_connect', tool_input: {}}), null);
  assert.throws(() => devinContextHook({hook_event_name: 'PreToolUse', session_id: 'Gentle-Falcon',
    tool_name: 'mcp__session-bridge__bridge_connect', tool_input: null}), /object tool input/);
});


test('Devin CLI context hook uses the native host flag and clears invalid stdin identity', () => {
  const input = {hook_event_name: 'PreToolUse', session_id: 'Gentle-Falcon',
    tool_name: 'mcp__session-bridge__bridge_message_send', tool_input: {text: 'Review résumé 🧪', _sessionId: 'Old-Session'}};
  const invoke = (sessionId: unknown) => JSON.parse(execFileSync(process.execPath,
    [resolve('dist/cli.js'), 'context-hook', '--host', 'devin'],
    {input: JSON.stringify({...input, session_id: sessionId}), encoding: 'utf8'}));
  const result = invoke(input.session_id);
  assert.equal(result.hookSpecificOutput.updatedInput._sessionId, 'Gentle-Falcon');
  assert.equal(result.hookSpecificOutput.updatedInput.text, input.tool_input.text);
  assert.equal(invoke(null).hookSpecificOutput.updatedInput._sessionId, null);
});
