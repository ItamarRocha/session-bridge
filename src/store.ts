import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, lstatSync, mkdirSync, openSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Claim, ConnectedPeer, DeliveryResult, Host, Message, Pairing, Peer, SendInput, StoreContract,
} from './types.js';

type Row = Record<string, unknown>;
const SCHEMA_VERSION = 2;
const MAX_BODY_BYTES = 32 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, field: string, limit: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > limit) {
    throw new Error(`${field} must be nonempty text of at most ${limit} bytes without NUL characters`);
  }
}

function seconds(value: number, field: string, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${field} must be an integer between 1 and ${max}`);
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Store file must be a regular file: ${path}`);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`Store file has a different owner: ${path}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Store file must have private permissions (0600): ${path}`);
  if (stat.nlink !== 1) throw new Error(`Store file must not have hard links: ${path}`);
}

function secureHome(home: string): string {
  const absolute = resolve(home);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Store home must be a real directory');
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('Store home has a different owner');
  if ((stat.mode & 0o077) !== 0) throw new Error('Store home must have private permissions (0700)');
  const file = join(absolute, 'bridge.sqlite');
  try {
    const fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = file + suffix;
    // lstat also catches dangling links, which existsSync would overlook.
    try { privateFile(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!suffix) throw error;
    }
  }
  return file;
}

function peerRow(row: Row): Peer {
  return {
    id: String(row.id), host: row.host as Host, label: String(row.label),
    nativeSessionId: row.native_session_id as string | null,
    endpoint: row.endpoint as string | null,
    createdAt: Number(row.created_at), closedAt: row.closed_at as number | null,
    attachedAt: row.attached_at as number | null,
    statusText: row.status_text as string | null,
    statusUpdatedAt: row.status_updated_at as number | null,
  };
}

function pairingRow(row: Row): Pairing {
  return {
    id: String(row.id), a: String(row.a), b: String(row.b),
    createdAt: Number(row.created_at), closedAt: row.closed_at as number | null,
  };
}

function messageRow(row: Row): Message {
  return {
    id: String(row.id), pairingId: String(row.pairing_id),
    from: String(row.from_peer), to: String(row.to_peer), kind: row.kind as Message['kind'],
    body: String(row.body), replyTo: row.reply_to as string | null,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    delivery: row.delivery as Message['delivery'], deliveryDetail: row.delivery_detail as string | null,
    acknowledgedAt: row.acknowledged_at as number | null,
    claimId: row.claim_id as string | null, claimExpiresAt: row.claim_expires_at as number | null,
    answeredBy: row.answered_by as string | null, cancelledAt: row.cancelled_at as number | null,
  };
}

export class Store implements StoreContract {
  readonly home: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(home: string, now: () => number = Date.now) {
    this.home = resolve(home);
    this.now = now;
    const file = secureHome(home);
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      this.transaction(() => {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        if (version < 0 || version > SCHEMA_VERSION) throw new Error(`Unsupported store schema version: ${version}`);
        if (version === 0) {
          this.db.exec(`
            CREATE TABLE peers (
              id TEXT PRIMARY KEY, host TEXT NOT NULL CHECK (host IN ('codex','claude')),
              label TEXT NOT NULL, native_session_id TEXT, endpoint TEXT,
              created_at INTEGER NOT NULL, closed_at INTEGER,
              ticket_hash TEXT UNIQUE, attached_at INTEGER
            );
            CREATE TABLE pairings (
              id TEXT PRIMARY KEY, a TEXT NOT NULL REFERENCES peers(id), b TEXT NOT NULL REFERENCES peers(id),
              created_at INTEGER NOT NULL, closed_at INTEGER, CHECK (a < b)
            );
            CREATE UNIQUE INDEX active_pair ON pairings(a,b) WHERE closed_at IS NULL;
            CREATE TABLE messages (
              id TEXT PRIMARY KEY, pairing_id TEXT NOT NULL REFERENCES pairings(id),
              from_peer TEXT NOT NULL REFERENCES peers(id), to_peer TEXT NOT NULL REFERENCES peers(id),
              kind TEXT NOT NULL CHECK (kind IN ('request','reply','notice')), body TEXT NOT NULL,
              reply_to TEXT UNIQUE REFERENCES messages(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
              delivery TEXT NOT NULL DEFAULT 'stored' CHECK (delivery IN ('stored','dispatching','submitted','unknown')),
              delivery_detail TEXT, acknowledged_at INTEGER, claim_id TEXT, claim_expires_at INTEGER,
              answered_by TEXT REFERENCES messages(id), cancelled_at INTEGER,
              idempotency_key TEXT, input_hash TEXT,
              UNIQUE(from_peer,idempotency_key), CHECK (from_peer <> to_peer)
            );
            CREATE INDEX inbox ON messages(to_peer,acknowledged_at,created_at);
          `);
        }
        if (version < 2) {
          this.db.exec(`
            ALTER TABLE peers ADD COLUMN status_text TEXT;
            ALTER TABLE peers ADD COLUMN status_updated_at INTEGER;
            PRAGMA user_version=${SCHEMA_VERSION};
          `);
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS peer_native_identity ON peers(native_session_id COLLATE NOCASE,host) WHERE closed_at IS NULL;
          CREATE INDEX IF NOT EXISTS message_history_from ON messages(from_peer,created_at DESC,id DESC);
          CREATE INDEX IF NOT EXISTS message_history_to ON messages(to_peer,created_at DESC,id DESC);
        `);
      });
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(file + suffix)) privateFile(file + suffix);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private activePeer(id: string): Peer {
    const peer = this.peer(id);
    if (peer.closedAt !== null) throw new Error('Peer is closed');
    return peer;
  }

  private activePair(id: string): Pairing {
    const row = this.db.prepare('SELECT * FROM pairings WHERE id=?').get(id);
    if (!row || row.closed_at !== null) throw new Error('Pairing is disconnected');
    const pair = pairingRow(row);
    this.activePeer(pair.a);
    this.activePeer(pair.b);
    return pair;
  }

  private rawMessage(id: string): Message {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    if (!row) throw new Error('Unknown message');
    return messageRow(row);
  }

  private eligible(message: Message): void {
    this.activePair(message.pairingId);
    if (message.cancelledAt !== null) throw new Error('Message is cancelled');
    if (message.expiresAt <= this.now()) throw new Error('Message is expired');
  }

  createPeer(input: {host: Host; label: string; nativeSessionId?: string; endpoint?: string}): {peer: Peer; ticket: string} {
    if (input.host !== 'codex' && input.host !== 'claude') throw new Error('Host must be codex or claude');
    text(input.label, 'Label', 128);
    if (input.host === 'codex' && (!input.nativeSessionId || !UUID.test(input.nativeSessionId))) {
      throw new Error('Codex native session ID must be a UUID');
    }
    if (input.nativeSessionId !== undefined && !UUID.test(input.nativeSessionId)) {
      throw new Error('Native session ID must be a UUID');
    }
    if (input.endpoint !== undefined) text(input.endpoint, 'Endpoint', 1024);
    const id = `sb_${randomUUID()}`;
    const ticket = `sbt_${randomBytes(32).toString('base64url')}`;
    const peer = this.transaction(() => {
      if (input.nativeSessionId && this.findNativePeer(input.nativeSessionId, input.host)) {
        throw new Error('Native session already has an active peer; reuse it or close it before registering again');
      }
      this.db.prepare(`INSERT INTO peers(id,host,label,native_session_id,endpoint,created_at,ticket_hash)
        VALUES(?,?,?,?,?,?,?)`).run(id, input.host, input.label, input.nativeSessionId?.toLowerCase() ?? null,
        input.endpoint ?? null, this.now(), hash(ticket));
      return this.peer(id);
    });
    return { peer, ticket };
  }

  ensureCodexPeer(input: {nativeSessionId: string; label?: string; attach?: boolean}): Peer {
    const label = input.label ?? 'Codex';
    text(label, 'Label', 128);
    if (!UUID.test(input.nativeSessionId)) throw new Error('Codex native session ID must be a UUID');
    return this.transaction(() => {
      const previous = this.findNativePeer(input.nativeSessionId, 'codex');
      if (previous) {
        if (input.attach !== false && previous.attachedAt === null) {
          this.db.prepare('UPDATE peers SET attached_at=?,ticket_hash=NULL WHERE id=?').run(this.now(), previous.id);
          return this.peer(previous.id);
        }
        return previous;
      }
      const id = `sb_${randomUUID()}`;
      const now = this.now();
      this.db.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,attached_at)
        VALUES(?,'codex',?,?,?,?)`).run(id, label, input.nativeSessionId.toLowerCase(), now, input.attach === false ? null : now);
      return this.peer(id);
    });
  }

  findNativePeer(nativeSessionId: string, host?: Host): Peer | null {
    if (!UUID.test(nativeSessionId)) throw new Error('Native session ID must be a UUID');
    if (host !== undefined && host !== 'codex' && host !== 'claude') throw new Error('Host must be codex or claude');
    const rows = host === undefined
      ? this.db.prepare('SELECT * FROM peers WHERE native_session_id=? COLLATE NOCASE AND closed_at IS NULL').all(nativeSessionId)
      : this.db.prepare('SELECT * FROM peers WHERE native_session_id=? COLLATE NOCASE AND host=? AND closed_at IS NULL').all(nativeSessionId, host);
    if (rows.length > 1) throw new Error('Native session ID is ambiguous; specify its provider or close duplicate registrations');
    return rows[0] ? peerRow(rows[0]) : null;
  }

  attach(ticket: string): Peer {
    text(ticket, 'Attach ticket', 256);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM peers WHERE ticket_hash=? AND attached_at IS NULL AND closed_at IS NULL').get(hash(ticket));
      if (!row) throw new Error('Invalid or already used attach ticket');
      this.db.prepare('UPDATE peers SET attached_at=?,ticket_hash=NULL WHERE id=?').run(this.now(), String(row.id));
      return this.peer(String(row.id));
    });
  }

  peer(id: string): Peer {
    const row = this.db.prepare('SELECT * FROM peers WHERE id=?').get(id);
    if (!row) throw new Error('Unknown peer');
    return peerRow(row);
  }

  peers(): Peer[] {
    return this.db.prepare('SELECT * FROM peers WHERE closed_at IS NULL ORDER BY created_at,id').all().map(peerRow);
  }

  connectedPeers(self: string): ConnectedPeer[] {
    this.activePeer(self);
    return this.db.prepare(`SELECT peer.*, pair.id AS pair_id, pair.a AS pair_a, pair.b AS pair_b,
      pair.created_at AS pair_created_at FROM pairings pair
      JOIN peers peer ON peer.id=CASE WHEN pair.a=? THEN pair.b ELSE pair.a END
      WHERE (pair.a=? OR pair.b=?) AND pair.closed_at IS NULL AND peer.closed_at IS NULL
      ORDER BY pair.created_at,pair.id`).all(self, self, self).map((row) => ({
        peer: peerRow(row),
        pairing: { id: String(row.pair_id), a: String(row.pair_a), b: String(row.pair_b),
          createdAt: Number(row.pair_created_at), closedAt: null },
      }));
  }

  updateStatus(self: string, status: string): Peer {
    text(status, 'Status', 512);
    if (/[\r\n\u0085\u2028\u2029]/.test(status)) throw new Error('Status must be a single line');
    return this.transaction(() => {
      this.activePeer(self);
      this.db.prepare('UPDATE peers SET status_text=?,status_updated_at=? WHERE id=?')
        .run(status.trim(), this.now(), self);
      return this.peer(self);
    });
  }

  setEndpoint(id: string, endpoint: string | null): void {
    if (endpoint !== null) text(endpoint, 'Endpoint', 1024);
    this.transaction(() => {
      this.activePeer(id);
      this.db.prepare('UPDATE peers SET endpoint=? WHERE id=?').run(endpoint, id);
    });
  }

  closePeer(id: string): void {
    this.transaction(() => {
      const peer = this.peer(id);
      if (peer.closedAt !== null) return;
      const now = this.now();
      this.db.prepare('UPDATE peers SET closed_at=?,endpoint=NULL,ticket_hash=NULL WHERE id=?').run(now, id);
      this.db.prepare('UPDATE pairings SET closed_at=? WHERE closed_at IS NULL AND (a=? OR b=?)').run(now, id, id);
    });
  }

  pair(self: string, other: string): Pairing {
    if (self === other) throw new Error('Cannot pair a peer with itself');
    return this.transaction(() => {
      this.activePeer(self);
      this.activePeer(other);
      const [a, b] = [self, other].sort() as [string, string];
      const previous = this.db.prepare('SELECT * FROM pairings WHERE a=? AND b=? AND closed_at IS NULL').get(a, b);
      if (previous) return pairingRow(previous);
      const pair = { id: `pair_${randomUUID()}`, a, b, createdAt: this.now(), closedAt: null };
      this.db.prepare('INSERT INTO pairings(id,a,b,created_at) VALUES(?,?,?,?)').run(pair.id, a, b, pair.createdAt);
      return pair;
    });
  }

  pairings(self: string): Pairing[] {
    this.peer(self);
    return this.db.prepare('SELECT * FROM pairings WHERE (a=? OR b=?) AND closed_at IS NULL ORDER BY created_at,id')
      .all(self, self).map(pairingRow);
  }

  disconnect(self: string, pairingId: string): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM pairings WHERE id=?').get(pairingId);
      if (!row || (row.a !== self && row.b !== self)) throw new Error('Not a participant in this pairing');
      this.db.prepare('UPDATE pairings SET closed_at=COALESCE(closed_at,?) WHERE id=?').run(this.now(), pairingId);
    });
  }

  send(self: string, input: SendInput): Message {
    text(input.body, 'Body', MAX_BODY_BYTES);
    text(input.idempotencyKey, 'Idempotency key', 256);
    const kind = input.kind ?? 'request';
    if (kind !== 'request' && kind !== 'notice') throw new Error('Send kind must be request or notice');
    const ttl = input.ttlSeconds ?? 3600;
    seconds(ttl, 'TTL seconds', 86400);
    const fingerprint = hash(JSON.stringify([input.to, input.body, kind, ttl]));
    return this.transaction(() => {
      this.activePeer(self);
      this.activePeer(input.to);
      const [a, b] = [self, input.to].sort() as [string, string];
      const pair = this.db.prepare('SELECT * FROM pairings WHERE a=? AND b=? AND closed_at IS NULL').get(a, b);
      if (!pair) throw new Error('Peers are not paired');
      const previous = this.db.prepare('SELECT * FROM messages WHERE from_peer=? AND idempotency_key=?').get(self, input.idempotencyKey);
      if (previous) {
        if (previous.input_hash !== fingerprint) throw new Error('Idempotency key was used with different message input');
        this.activePair(String(previous.pairing_id));
        return messageRow(previous);
      }
      const id = `msg_${randomUUID()}`;
      const now = this.now();
      this.db.prepare(`INSERT INTO messages(id,pairing_id,from_peer,to_peer,kind,body,created_at,expires_at,idempotency_key,input_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, String(pair.id), self, input.to, kind, input.body, now, now + ttl * 1000,
        input.idempotencyKey, fingerprint);
      return this.rawMessage(id);
    });
  }

  message(self: string, id: string): Message {
    const message = this.rawMessage(id);
    if (message.from !== self && message.to !== self) throw new Error('Not a participant in this message');
    return message;
  }

  inbox(self: string): Message[] {
    this.activePeer(self);
    return this.db.prepare(`SELECT m.* FROM messages m
      JOIN pairings p ON p.id=m.pairing_id
      JOIN peers sender ON sender.id=m.from_peer
      WHERE m.to_peer=? AND m.acknowledged_at IS NULL AND m.cancelled_at IS NULL AND m.expires_at>?
      AND p.closed_at IS NULL AND sender.closed_at IS NULL ORDER BY m.created_at,m.id`).all(self, this.now()).map(messageRow);
  }

  incoming(self: string): Message[] {
    this.activePeer(self);
    return this.db.prepare('SELECT * FROM messages WHERE to_peer=? ORDER BY created_at,id').all(self).map(messageRow);
  }

  history(self: string, limit = 100): Message[] {
    this.peer(self);
    seconds(limit, 'History limit', 100);
    return this.db.prepare(`
      SELECT * FROM (SELECT * FROM messages WHERE from_peer=? ORDER BY created_at DESC,id DESC LIMIT ?)
      UNION ALL
      SELECT * FROM (SELECT * FROM messages WHERE to_peer=? ORDER BY created_at DESC,id DESC LIMIT ?)
      ORDER BY created_at DESC,id DESC LIMIT ?
    `).all(self, limit, self, limit, limit).map(messageRow);
  }

  claim(self: string, id: string, leaseSeconds = 1800): Claim {
    seconds(leaseSeconds, 'Lease seconds', 3600);
    return this.transaction(() => {
      const message = this.rawMessage(id);
      if (message.to !== self) throw new Error('Only the recipient can claim a message');
      this.eligible(message);
      if (message.claimId !== null) {
        if (message.claimExpiresAt! <= this.now()) throw new Error('Claim lease expired; automatic re-claim is disabled');
        return { message, claimId: message.claimId, alreadyClaimed: true };
      }
      const claimId = `claim_${randomUUID()}`;
      const now = this.now();
      this.db.prepare('UPDATE messages SET acknowledged_at=?,claim_id=?,claim_expires_at=? WHERE id=?')
        .run(now, claimId, Math.min(now + leaseSeconds * 1000, message.expiresAt), id);
      return { message: this.rawMessage(id), claimId, alreadyClaimed: false };
    });
  }

  reply(self: string, id: string, claimId: string, body: string, idempotencyKey?: string): Message {
    text(body, 'Body', MAX_BODY_BYTES);
    if (idempotencyKey !== undefined) text(idempotencyKey, 'Idempotency key', 256);
    return this.transaction(() => {
      const original = this.rawMessage(id);
      if (original.to !== self) throw new Error('Only the recipient can reply');
      this.activePair(original.pairingId);
      if (original.kind !== 'request') throw new Error('Only a request accepts a reply');
      if (!original.claimId || original.claimId !== claimId) throw new Error('A valid claim is required to reply');
      const fingerprint = hash(JSON.stringify([original.from, body, 'reply', id]));
      if (idempotencyKey !== undefined) {
        const previous = this.db.prepare('SELECT * FROM messages WHERE from_peer=? AND idempotency_key=?').get(self, idempotencyKey);
        if (previous) {
          if (previous.input_hash !== fingerprint) throw new Error('Idempotency key was used with different message input');
          return messageRow(previous);
        }
      }
      if (original.answeredBy) {
        const previous = this.rawMessage(original.answeredBy);
        if (previous.body !== body) throw new Error('Request already has a different reply');
        if (idempotencyKey !== undefined) {
          const row = this.db.prepare('SELECT idempotency_key FROM messages WHERE id=?').get(previous.id)!;
          if (row.idempotency_key !== null) throw new Error('Request already has a reply with a different idempotency key');
          this.db.prepare('UPDATE messages SET idempotency_key=?,input_hash=? WHERE id=?')
            .run(idempotencyKey, fingerprint, previous.id);
        }
        return previous;
      }
      this.eligible(original);
      if (original.claimExpiresAt! <= this.now()) throw new Error('Claim lease expired; reply is no longer accepted');
      const replyId = `msg_${randomUUID()}`;
      const now = this.now();
      this.db.prepare(`INSERT INTO messages(id,pairing_id,from_peer,to_peer,kind,body,reply_to,created_at,expires_at,idempotency_key,input_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(replyId, original.pairingId, self, original.from, 'reply', body, id, now, original.expiresAt,
          idempotencyKey ?? null, idempotencyKey === undefined ? null : fingerprint);
      this.db.prepare('UPDATE messages SET answered_by=? WHERE id=?').run(replyId, id);
      return this.rawMessage(replyId);
    });
  }

  cancel(self: string, id: string): Message {
    return this.transaction(() => {
      const message = this.rawMessage(id);
      if (message.from !== self) throw new Error('Only the sender can cancel a message');
      this.db.prepare('UPDATE messages SET cancelled_at=COALESCE(cancelled_at,?) WHERE id=?').run(this.now(), id);
      return this.rawMessage(id);
    });
  }

  beginDelivery(id: string): boolean {
    return this.transaction(() => {
      const message = this.rawMessage(id);
      if (message.delivery !== 'stored' || message.acknowledgedAt !== null || message.cancelledAt !== null || message.expiresAt <= this.now()) return false;
      const pair = this.db.prepare(`SELECT p.id FROM pairings p JOIN peers a ON a.id=p.a JOIN peers b ON b.id=p.b
        WHERE p.id=? AND p.closed_at IS NULL AND a.closed_at IS NULL AND b.closed_at IS NULL`).get(message.pairingId);
      if (!pair) return false;
      return Number(this.db.prepare("UPDATE messages SET delivery='dispatching',delivery_detail=NULL WHERE id=? AND delivery='stored'").run(id).changes) === 1;
    });
  }

  finishDelivery(id: string, result: DeliveryResult): void {
    if (!['stored', 'submitted', 'unknown'].includes(result.state)) throw new Error('Invalid delivery result state');
    if (typeof result.detail !== 'string') throw new Error('Delivery detail must be text');
    this.db.prepare("UPDATE messages SET delivery=?,delivery_detail=? WHERE id=? AND delivery='dispatching'")
      .run(result.state, result.detail.slice(0, 4096), id);
  }

  close(): void {
    this.db.close();
  }
}
