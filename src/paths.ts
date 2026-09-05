import { mkdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function defaultHome(): string {
  return resolve(process.env.SESSION_BRIDGE_HOME ?? join(homedir(), '.local/state/session-bridge'));
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Bridge directory must be owned by you, private (0700), and not a symlink: ${path}`);
  }
}

export function newSocketPath(home: string): string {
  let parent = join(home, 'ipc');
  const name = `${randomUUID().slice(0, 18)}.sock`;
  if (Buffer.byteLength(join(parent, name)) > 100) {
    parent = `/tmp/session-bridge-${process.getuid?.() ?? 'local'}`;
  }
  privateDirectory(parent);
  return join(parent, name);
}
