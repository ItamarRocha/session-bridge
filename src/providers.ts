import type { Host } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVIN_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isHost(input: unknown): input is Host {
  return input === 'codex' || input === 'claude' || input === 'devin';
}

export function canonicalSessionId(host: Host, value: unknown): string {
  if (!isHost(host)) throw new Error('Host must be codex, claude or devin');
  if (host === 'devin') {
    if (typeof value !== 'string' || !DEVIN_SESSION_ID.test(value)) {
      throw new Error('Devin native session ID must be 1-128 letters, digits, underscores or hyphens, starting with a letter or digit');
    }
    return value;
  }
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`${host === 'codex' ? 'Codex' : 'Claude'} native session ID must be a UUID`);
  }
  return value.toLowerCase();
}
