import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function defaultHome(): string {
  return resolve(process.env.SESSION_BRIDGE_HOME ?? join(homedir(), '.local/state/session-bridge'));
}
