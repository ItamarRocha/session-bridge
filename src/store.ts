import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, lstatSync, mkdirSync, openSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalSessionId, isHost } from './providers.js';
import type {
  Claim, ConnectedPeer, DeliveryResult, Host, InboxNotification, Message, NotificationRead, Pairing, Peer, ReceiverStatus, SendInput, StoreContract,
} from './types.js';

type Row = Record<string, unknown>;
const SCHEMA_VERSION = 5;
const MAX_BODY_BYTES = 32 * 1024;
const RECEIVER_LEASE_MS = 5_000;

export class StoreSchemaVersionError extends Error {
  constructor(readonly version: number) {
    super(`Unsupported store schema version: ${version}`);
    this.name = 'StoreSchemaVersionError';
  }
}

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
    notifiedAt: row.notified_at as number | null,
  };
}

function notificationRow(row: Row): InboxNotification {
  return {
    id: String(row.id), to: String(row.to_peer), state: row.state as InboxNotification['state'],
    createdAt: Number(row.created_at), consumedAt: row.consumed_at as number | null,
    deliveryDetail: row.delivery_detail as string | null, nativeQueueId: row.native_queue_id as string | null,
  };
}

export class Store implements StoreContract {
  readonly home: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(home: string, now: () => number = Date.now, options: {migrate?: boolean} = {}) {
    this.home = resolve(home);
    this.now = now;
    const file = secureHome(home);
    this.db = new DatabaseSync(file);
    try {
      const initialVersion = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (initialVersion < 0 || initialVersion > SCHEMA_VERSION || (options.migrate === false && initialVersion !== SCHEMA_VERSION)) {
        throw new StoreSchemaVersionError(initialVersion);
      }
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
      // Rebuilding a referenced table requires disabling enforcement before the migration transaction.
      if (initialVersion < 5) this.db.exec('PRAGMA foreign_keys=OFF');
      this.transaction(() => {
        const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
        if (version < 0 || version > SCHEMA_VERSION || (options.migrate === false && version !== SCHEMA_VERSION)) {
          throw new StoreSchemaVersionError(version);
        }
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
          `);
        }
        if (version < 3) {
          this.db.exec(`
            ALTER TABLE peers ADD COLUMN receiver_owner TEXT;
            ALTER TABLE peers ADD COLUMN receiver_checked_at INTEGER;
            ALTER TABLE peers ADD COLUMN receiver_expires_at INTEGER;
            ALTER TABLE messages ADD COLUMN notified_at INTEGER;
            ALTER TABLE messages ADD COLUMN notified_by TEXT;
          `);
        }
        if (version < 4) {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS inbox_notifications (
              id TEXT PRIMARY KEY, recipient_key TEXT NOT NULL, to_peer TEXT NOT NULL REFERENCES peers(id),
              state TEXT NOT NULL CHECK (state IN ('pending','submitting','submitted','unknown')),
              created_at INTEGER NOT NULL, consumed_at INTEGER, delivery_detail TEXT, native_queue_id TEXT,
              dispatch_owner TEXT, successor_id TEXT REFERENCES inbox_notifications(id)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS outstanding_notification ON inbox_notifications(recipient_key)
              WHERE consumed_at IS NULL;
            CREATE TABLE IF NOT EXISTS notification_receipts (
              notification_id TEXT NOT NULL REFERENCES inbox_notifications(id),
              message_id TEXT NOT NULL REFERENCES messages(id), ordinal INTEGER NOT NULL,
              PRIMARY KEY(notification_id,message_id), UNIQUE(notification_id,ordinal)
            );
          `);
        }
        if (version < 5) {
          const indexes = this.db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='peers' AND sql IS NOT NULL").all();
          this.db.exec(`
            CREATE TABLE peers_upgrade (
              id TEXT PRIMARY KEY, host TEXT NOT NULL CHECK (host IN ('codex','claude','devin')),
              label TEXT NOT NULL, native_session_id TEXT, endpoint TEXT,
              created_at INTEGER NOT NULL, closed_at INTEGER, ticket_hash TEXT UNIQUE, attached_at INTEGER,
              status_text TEXT, status_updated_at INTEGER, receiver_owner TEXT,
              receiver_checked_at INTEGER, receiver_expires_at INTEGER
            );
            INSERT INTO peers_upgrade(id,host,label,native_session_id,endpoint,created_at,closed_at,ticket_hash,
              attached_at,status_text,status_updated_at,receiver_owner,receiver_checked_at,receiver_expires_at)
              SELECT id,host,label,native_session_id,endpoint,created_at,closed_at,ticket_hash,
                attached_at,status_text,status_updated_at,receiver_owner,receiver_checked_at,receiver_expires_at FROM peers;
            DROP TABLE peers;
            ALTER TABLE peers_upgrade RENAME TO peers;
          `);
          for (const index of indexes) this.db.exec(String(index.sql));
          if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Store migration failed foreign key validation');
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS peer_native_identity ON peers(native_session_id COLLATE NOCASE,host) WHERE closed_at IS NULL;
          CREATE INDEX IF NOT EXISTS peer_identity_history ON peers(host,native_session_id COLLATE NOCASE);
          CREATE INDEX IF NOT EXISTS peer_identity_exact ON peers(host,native_session_id);
          CREATE INDEX IF NOT EXISTS message_history_from ON messages(from_peer,created_at DESC,id DESC);
          CREATE INDEX IF NOT EXISTS message_history_to ON messages(to_peer,created_at DESC,id DESC);
          PRAGMA user_version=${SCHEMA_VERSION};
        `);
      });
      this.db.exec('PRAGMA foreign_keys=ON');
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

  private historicalPeer(nativeSessionId: string, host: Host): Peer | null {
    const row = this.db.prepare(`SELECT * FROM peers WHERE host=? AND native_session_id=? COLLATE ${host === 'devin' ? 'BINARY' : 'NOCASE'}
      ORDER BY created_at,id LIMIT 1`).get(host, nativeSessionId);
    return row ? peerRow(row) : null;
  }

  private identityIds(id: string): string[] {
    const peer = this.peer(id);
    return this.db.prepare(`SELECT id FROM peers WHERE id=? OR (host=? AND native_session_id=? COLLATE ${peer.host === 'devin' ? 'BINARY' : 'NOCASE'})`)
      .all(id, peer.host, peer.nativeSessionId).map(row => String(row.id));
  }

  sameSession(a: string, b: string): boolean {
    const first = this.peer(a), second = this.peer(b);
    return a === b || (first.nativeSessionId !== null && second.nativeSessionId !== null && first.host === second.host
      && canonicalSessionId(first.host, first.nativeSessionId) === canonicalSessionId(second.host, second.nativeSessionId));
  }

  private previousKey(self: string, key: string): Message | null {
    const ids = this.identityIds(self);
    const rows = this.db.prepare(`SELECT * FROM messages WHERE from_peer IN (${ids.map(() => '?').join(',')}) AND idempotency_key=?`)
      .all(...ids, key);
    if (rows.length > 1) throw new Error('Idempotency key has conflicting historical messages; inspect their evidence before retrying');
    return rows[0] ? messageRow(rows[0]) : null;
  }

  private eligible(message: Message): void {
    this.activePair(message.pairingId);
    if (message.cancelledAt !== null) throw new Error('Message is cancelled');
    if (message.expiresAt <= this.now()) throw new Error('Message is expired');
  }

  createPeer(input: {host: Host; label: string; nativeSessionId?: string; endpoint?: string}): {peer: Peer; ticket: string} {
    if (!isHost(input.host)) throw new Error('Host must be codex, claude or devin');
    text(input.label, 'Label', 128);
    const nativeSessionId = input.nativeSessionId === undefined && input.host === 'claude'
      ? undefined : canonicalSessionId(input.host, input.nativeSessionId);
    if (input.endpoint !== undefined) text(input.endpoint, 'Endpoint', 1024);
    const id = `sb_${randomUUID()}`;
    const ticket = `sbt_${randomBytes(32).toString('base64url')}`;
    const peer = this.transaction(() => {
      if (nativeSessionId && this.findNativePeer(nativeSessionId, input.host)) {
        throw new Error('Native session already has an active peer; reuse it or close it before registering again');
      }
      const previous = nativeSessionId && this.historicalPeer(nativeSessionId, input.host);
      if (previous) {
        this.db.prepare(`UPDATE peers SET closed_at=NULL,label=?,endpoint=?,attached_at=NULL,ticket_hash=? WHERE id=?`)
          .run(input.label, input.endpoint ?? null, hash(ticket), previous.id);
        return this.peer(previous.id);
      }
      this.db.prepare(`INSERT INTO peers(id,host,label,native_session_id,endpoint,created_at,ticket_hash)
        VALUES(?,?,?,?,?,?,?)`).run(id, input.host, input.label, nativeSessionId ?? null,
        input.endpoint ?? null, this.now(), hash(ticket));
      return this.peer(id);
    });
    return { peer, ticket };
  }

  ensureCodexPeer(input: {nativeSessionId: string; label?: string; attach?: boolean}): Peer {
    return this.ensureNativePeer({...input, host: 'codex'});
  }

  ensureNativePeer(input: {host: 'codex' | 'devin'; nativeSessionId: string; label?: string; attach?: boolean}): Peer {
    if (input.host !== 'codex' && input.host !== 'devin') throw new Error('Native attachment host must be codex or devin');
    if (input.host === 'devin' && input.attach === false) throw new Error('Devin sessions must explicitly attach from their own native context');
    const label = input.label ?? (input.host === 'codex' ? 'Codex' : 'Devin');
    text(label, 'Label', 128);
    const nativeSessionId = canonicalSessionId(input.host, input.nativeSessionId);
    return this.transaction(() => {
      const previous = this.findNativePeer(nativeSessionId, input.host);
      if (previous) {
        if (input.attach !== false && previous.attachedAt === null) {
          this.db.prepare('UPDATE peers SET attached_at=?,ticket_hash=NULL WHERE id=?').run(this.now(), previous.id);
          return this.peer(previous.id);
        }
        return previous;
      }
      const historical = this.historicalPeer(nativeSessionId, input.host);
      if (historical) {
        this.db.prepare('UPDATE peers SET closed_at=NULL,attached_at=?,ticket_hash=NULL WHERE id=?')
          .run(input.attach === false ? null : this.now(), historical.id);
        return this.peer(historical.id);
      }
      const id = `sb_${randomUUID()}`;
      const now = this.now();
      this.db.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,attached_at)
        VALUES(?,?,?,?,?,?)`).run(id, input.host, label, nativeSessionId, now, input.attach === false ? null : now);
      return this.peer(id);
    });
  }

  findNativePeer(nativeSessionId: string, host?: Host): Peer | null {
    const canonical = canonicalSessionId(host ?? 'devin', nativeSessionId);
    const rows = host === undefined
      ? this.db.prepare(`SELECT * FROM peers WHERE closed_at IS NULL AND
        ((host IN ('codex','claude') AND native_session_id=? COLLATE NOCASE) OR (host='devin' AND native_session_id=?))`)
        .all(canonical, canonical)
      : this.db.prepare(`SELECT * FROM peers WHERE native_session_id=? COLLATE ${host === 'devin' ? 'BINARY' : 'NOCASE'}
        AND host=? AND closed_at IS NULL`).all(canonical, host);
    if (rows.length > 1) throw new Error('Native session ID is ambiguous; specify its provider or close duplicate registrations');
    return rows[0] ? peerRow(rows[0]) : null;
  }

  acquireReceiver(input: {nativeSessionId?: string; label: string}): {peer: Peer; ownerToken: string; ticket?: string} {
    text(input.label, 'Label', 128);
    const nativeSessionId = input.nativeSessionId === undefined ? undefined : canonicalSessionId('claude', input.nativeSessionId);
    return this.transaction(() => {
      let peer = nativeSessionId
        ? this.findNativePeer(nativeSessionId, 'claude') ?? this.historicalPeer(nativeSessionId, 'claude')
        : null;
      const now = this.now();
      let ticket: string | undefined;
      if (peer) {
        const row = this.db.prepare('SELECT * FROM peers WHERE id=?').get(peer.id)!;
        if (row.receiver_owner !== null && Number(row.receiver_expires_at) > now) throw new Error('A receiver is already active for this native session');
        if (row.endpoint !== null) {
          throw new Error('A legacy receiver endpoint is registered; stop that receiver explicitly before upgrading its receiver lease');
        }
      } else {
        const id = `sb_${randomUUID()}`;
        if (!nativeSessionId) ticket = `sbt_${randomBytes(32).toString('base64url')}`;
        this.db.prepare(`INSERT INTO peers(id,host,label,native_session_id,created_at,attached_at,ticket_hash)
          VALUES(?,'claude',?,?,?,?,?)`).run(id, input.label, nativeSessionId ?? null, now,
          nativeSessionId ? now : null, ticket ? hash(ticket) : null);
        peer = this.peer(id);
      }
      const ownerToken = `receiver_${randomBytes(32).toString('base64url')}`;
      this.db.prepare(`UPDATE peers SET receiver_owner=?,receiver_checked_at=?,receiver_expires_at=?,endpoint=NULL,
        closed_at=NULL,label=?,attached_at=CASE WHEN native_session_id IS NULL THEN attached_at ELSE COALESCE(attached_at,?) END,
        ticket_hash=CASE WHEN native_session_id IS NULL THEN ticket_hash ELSE NULL END WHERE id=?`)
        .run(hash(ownerToken), now, now + RECEIVER_LEASE_MS, input.label, now, peer.id);
      return {peer: this.peer(peer.id), ownerToken, ...(ticket ? {ticket} : {})};
    });
  }

  renewReceiver(peerId: string, ownerToken: string): boolean {
    return this.transaction(() => {
      const now = this.now();
      return Number(this.db.prepare(`UPDATE peers SET receiver_checked_at=?,receiver_expires_at=?
        WHERE id=? AND closed_at IS NULL AND receiver_owner=? AND receiver_expires_at>?`)
        .run(now, now + RECEIVER_LEASE_MS, peerId, hash(ownerToken), now).changes) === 1;
    });
  }

  releaseReceiver(peerId: string, ownerToken: string): void {
    const now = this.now();
    this.db.prepare(`UPDATE peers SET receiver_owner=NULL,receiver_checked_at=?,receiver_expires_at=?,endpoint=NULL
      WHERE id=? AND receiver_owner=?`).run(now, now, peerId, hash(ownerToken));
  }

  receiverStatus(peerId: string): ReceiverStatus {
    const row = this.db.prepare('SELECT * FROM peers WHERE id=?').get(peerId);
    if (!row) throw new Error('Unknown peer');
    if (row.host === 'devin') return {state: 'unknown', checkedAt: null, expiresAt: null};
    if (row.closed_at === null && row.endpoint !== null) return {state: 'unknown', checkedAt: null, expiresAt: null};
    const checkedAt = row.receiver_checked_at as number | null;
    const expiresAt = row.receiver_expires_at as number | null;
    const state = row.closed_at !== null ? 'unavailable' : checkedAt === null ? 'unknown'
      : row.receiver_owner !== null && expiresAt !== null && expiresAt > this.now() ? 'available' : 'unavailable';
    return {state, checkedAt, expiresAt};
  }

  private notifications(peerId: string, ownerToken: string, limit: number, messageId?: string): Message[] {
    const owner = hash(ownerToken), now = this.now();
    return this.db.prepare(`SELECT m.* FROM messages m JOIN peers receiver ON receiver.id=m.to_peer
      JOIN peers sender ON sender.id=m.from_peer JOIN pairings p ON p.id=m.pairing_id
      WHERE receiver.id=? AND receiver.receiver_owner=? AND receiver.receiver_expires_at>?
      AND receiver.closed_at IS NULL AND sender.closed_at IS NULL AND p.closed_at IS NULL
      AND m.acknowledged_at IS NULL AND m.cancelled_at IS NULL AND m.expires_at>?
      AND (m.delivery='stored' OR (m.delivery='submitted' AND m.notified_at IS NOT NULL AND m.notified_by<>?))
      ${messageId === undefined ? '' : 'AND m.id=?'} ORDER BY m.created_at,m.id LIMIT ?`)
      .all(peerId, owner, now, now, owner, ...(messageId === undefined ? [] : [messageId]), limit).map(messageRow);
  }

  pendingNotifications(peerId: string, ownerToken: string, limit = 20): Message[] {
    seconds(limit, 'Notification limit', 100);
    return this.notifications(peerId, ownerToken, limit);
  }

  markNotified(peerId: string, ownerToken: string, messageId: string): boolean {
    return this.transaction(() => {
      if (!this.notifications(peerId, ownerToken, 1, messageId).length) return false;
      this.db.prepare(`UPDATE messages SET notified_at=?,notified_by=?,delivery='submitted',
        delivery_detail='Written to the native receiver notification stream; model receipt is pending.' WHERE id=?`)
        .run(this.now(), hash(ownerToken), messageId);
      return true;
    });
  }

  private eligibleIncoming(self: string, unreadOnly: boolean): {sql: string; params: (string | number)[]} {
    const ids = this.identityIds(self);
    return {
      sql: `FROM messages m JOIN pairings p ON p.id=m.pairing_id
        JOIN peers sender ON sender.id=m.from_peer JOIN peers receiver ON receiver.id=m.to_peer
        WHERE m.to_peer IN (${ids.map(() => '?').join(',')})
        AND p.closed_at IS NULL AND sender.closed_at IS NULL AND receiver.closed_at IS NULL
        AND m.cancelled_at IS NULL AND m.expires_at>? ${unreadOnly ? 'AND m.acknowledged_at IS NULL' : ''}`,
      params: [...ids, this.now()],
    };
  }

  private unread(self: string, limit: number, storedOnly = false): Message[] {
    const query = this.eligibleIncoming(self, true);
    return this.db.prepare(`SELECT m.* ${query.sql} ${storedOnly ? "AND m.delivery='stored'" : ''}
      ORDER BY m.created_at,m.id LIMIT ?`).all(...query.params, limit).map(messageRow);
  }

  private notificationKey(peer: Peer): string | null {
    return peer.nativeSessionId === null ? null : `${peer.host}:${canonicalSessionId(peer.host, peer.nativeSessionId)}`;
  }

  private reserveInboxNotification(to: string, includePreviouslyDispatched = false): InboxNotification | null {
    const peer = this.peer(to), key = this.notificationKey(peer);
    if (key === null) return null;
    const active = this.findNativePeer(peer.nativeSessionId!, peer.host);
    // Message reads and expiry cannot retract a native queue item; only its token read retires the slot.
    const existing = this.db.prepare('SELECT * FROM inbox_notifications WHERE recipient_key=? AND consumed_at IS NULL').get(key);
    if (existing) return notificationRow(existing);
    if (!active || !this.unread(active.id, 1, !includePreviouslyDispatched).length) return null;
    const id = `notification_${randomUUID()}`;
    this.db.prepare(`INSERT INTO inbox_notifications(id,recipient_key,to_peer,state,created_at)
      VALUES(?,?,?,'pending',?)`).run(id, key, active.id, this.now());
    return notificationRow(this.db.prepare('SELECT * FROM inbox_notifications WHERE id=?').get(id)!);
  }

  reserveNotification(to: string): InboxNotification | null {
    return this.transaction(() => this.reserveInboxNotification(to));
  }

  private notificationOwner(row: Row, ownerToken?: string): {owner: string | null; peer: Peer} | null {
    const recipient = this.peer(String(row.to_peer));
    const peer = recipient.nativeSessionId && this.findNativePeer(recipient.nativeSessionId, recipient.host);
    if (!peer) return null;
    if (peer.host === 'codex' || peer.host === 'devin') return {owner: null, peer};
    if (!ownerToken) return null;
    const owner = hash(ownerToken);
    const lease = this.db.prepare(`SELECT id FROM peers WHERE id=? AND receiver_owner=?
      AND receiver_expires_at>? AND closed_at IS NULL`).get(peer.id, owner, this.now());
    return lease ? {owner, peer} : null;
  }

  beginNotificationDelivery(id: string, ownerToken?: string): boolean {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM inbox_notifications WHERE id=? AND consumed_at IS NULL').get(id);
      if (!row || row.state !== 'pending') return false;
      const receiver = this.notificationOwner(row, ownerToken);
      if (!receiver || !this.unread(receiver.peer.id, 1).length) return false;
      return Number(this.db.prepare(`UPDATE inbox_notifications SET state='submitting',dispatch_owner=?,
        delivery_detail=NULL,native_queue_id=NULL WHERE id=? AND consumed_at IS NULL AND state='pending'`)
        .run(receiver.owner, id).changes) === 1;
    });
  }

  finishNotificationDelivery(id: string, result: DeliveryResult, ownerToken?: string): void {
    if (!['stored', 'submitted', 'unknown'].includes(result.state)) throw new Error('Invalid delivery result state');
    if (typeof result.detail !== 'string') throw new Error('Delivery detail must be text');
    if (result.nativeQueueId !== undefined && result.nativeQueueId !== null) text(result.nativeQueueId, 'Native queue ID', 512);
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM inbox_notifications WHERE id=? AND consumed_at IS NULL').get(id);
      if (!row || row.state !== 'submitting') return;
      const receiver = this.notificationOwner(row, ownerToken);
      if (!receiver || receiver.owner !== row.dispatch_owner) return;
      this.db.prepare(`UPDATE inbox_notifications SET state=?,delivery_detail=?,native_queue_id=? WHERE id=?`)
        .run(result.state === 'stored' ? 'pending' : result.state, result.detail.slice(0, 4096), result.nativeQueueId ?? null, id);
    });
  }

  consumeNotification(self: string, id: string, limit = 20): NotificationRead {
    seconds(limit, 'Notification read limit', 100);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM inbox_notifications WHERE id=?').get(id);
      if (!row) throw new Error('Unknown inbox notification');
      if (!this.sameSession(self, String(row.to_peer))) throw new Error('Only the recipient can read an inbox notification');
      const recipient = this.peer(self);
      if (recipient.nativeSessionId !== null) this.findNativePeer(recipient.nativeSessionId, recipient.host);
      if (row.consumed_at !== null) {
        // Replaying a receipt must not consume newer arrivals or retire a successor notification.
        const claims = this.db.prepare(`SELECT m.* FROM notification_receipts r JOIN messages m ON m.id=r.message_id
          WHERE r.notification_id=? ORDER BY r.ordinal`).all(id).map(messageRow)
          .map(message => ({message, claimId: message.claimId!, alreadyClaimed: true}));
        const successor = row.successor_id === null ? undefined : this.db.prepare(`SELECT * FROM inbox_notifications
          WHERE id=? AND consumed_at IS NULL`).get(String(row.successor_id));
        return {claims, consumed: false, notification: successor ? notificationRow(successor) : null,
          remaining: this.unread(self, 1).length > 0};
      }
      const messages = this.unread(self, limit);
      const claims = messages.map((message, ordinal) => {
        const claim = this.claimMessage(self, message.id, 1800);
        this.db.prepare('INSERT INTO notification_receipts(notification_id,message_id,ordinal) VALUES(?,?,?)')
          .run(id, message.id, ordinal);
        return claim;
      });
      this.db.prepare('UPDATE inbox_notifications SET consumed_at=? WHERE id=?').run(this.now(), id);
      const remaining = this.unread(self, 1).length > 0;
      const notification = remaining ? this.reserveInboxNotification(self, true) : null;
      if (notification) this.db.prepare('UPDATE inbox_notifications SET successor_id=? WHERE id=?').run(notification.id, id);
      return {claims, consumed: true, notification, remaining};
    });
  }

  notificationStatus(self: string): {unreadCount: number; pendingRequestCount: number; notification: InboxNotification | null} {
    return this.transaction(() => {
      const peer = this.peer(self), key = this.notificationKey(peer);
      if (peer.nativeSessionId !== null) this.findNativePeer(peer.nativeSessionId, peer.host);
      const query = this.eligibleIncoming(self, false);
      const counts = this.db.prepare(`SELECT COUNT(CASE WHEN m.acknowledged_at IS NULL THEN 1 END) AS unread,
        COUNT(CASE WHEN m.kind='request' AND m.answered_by IS NULL THEN 1 END) AS pending ${query.sql}`).get(...query.params)!;
      const row = key === null ? undefined : this.db.prepare(`SELECT * FROM inbox_notifications
        WHERE recipient_key=? AND consumed_at IS NULL`).get(key);
      return {unreadCount: Number(counts.unread), pendingRequestCount: Number(counts.pending), notification: row ? notificationRow(row) : null};
    });
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
      const row = this.db.prepare('SELECT receiver_owner FROM peers WHERE id=?').get(id)!;
      if (row.receiver_owner !== null) throw new Error('A receiver lease owns this peer; legacy endpoint changes are unavailable');
      this.db.prepare('UPDATE peers SET endpoint=? WHERE id=?').run(endpoint, id);
    });
  }

  closePeer(id: string): void {
    this.transaction(() => {
      const peer = this.peer(id);
      if (peer.closedAt !== null) return;
      const now = this.now();
      this.db.prepare(`UPDATE peers SET closed_at=?,endpoint=NULL,ticket_hash=NULL,
        receiver_owner=NULL,receiver_expires_at=? WHERE id=?`).run(now, now, id);
      this.db.prepare('UPDATE pairings SET closed_at=? WHERE closed_at IS NULL AND (a=? OR b=?)').run(now, id, id);
    });
  }

  pair(self: string, other: string): Pairing {
    if (this.sameSession(self, other)) throw new Error('Cannot pair a peer with itself');
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
      const previous = this.previousKey(self, input.idempotencyKey);
      if (previous) {
        if (!this.sameSession(previous.to, input.to) || previous.body !== input.body || previous.kind !== kind
          || previous.expiresAt - previous.createdAt !== ttl * 1000) throw new Error('Idempotency key was used with different message input');
        return previous;
      }
      const [a, b] = [self, input.to].sort() as [string, string];
      const pair = this.db.prepare('SELECT * FROM pairings WHERE a=? AND b=? AND closed_at IS NULL').get(a, b);
      if (!pair) throw new Error('Peers are not paired');
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
    if (!this.sameSession(message.from, self) && !this.sameSession(message.to, self)) throw new Error('Not a participant in this message');
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

  incoming(self: string, input: {limit?: number; after?: {createdAt: number; id: string}; unreadOnly?: boolean} = {}): Message[] {
    this.activePeer(self);
    const ids = this.identityIds(self), placeholders = ids.map(() => '?').join(',');
    const limit = input.limit ?? 100;
    seconds(limit, 'Incoming limit', 101);
    if (input.after) {
      text(input.after.id, 'Incoming cursor ID', 128);
      if (!Number.isSafeInteger(input.after.createdAt)) throw new Error('Incoming cursor timestamp must be a safe integer');
    }
    const query = input.unreadOnly ? this.eligibleIncoming(self, true)
      : {sql: `FROM messages m WHERE m.to_peer IN (${placeholders})`, params: ids};
    return this.db.prepare(`SELECT m.* ${query.sql} ${input.after ? 'AND (m.created_at,m.id)>(?,?)' : ''}
      ORDER BY m.created_at,m.id LIMIT ?`)
      .all(...query.params, ...(input.after ? [input.after.createdAt, input.after.id] : []), limit).map(messageRow);
  }

  history(self: string, limit = 100): Message[] {
    this.peer(self);
    seconds(limit, 'History limit', 100);
    const ids = this.identityIds(self), placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(`
      SELECT * FROM (SELECT * FROM messages WHERE from_peer IN (${placeholders}) ORDER BY created_at DESC,id DESC LIMIT ?)
      UNION ALL
      SELECT * FROM (SELECT * FROM messages WHERE to_peer IN (${placeholders}) ORDER BY created_at DESC,id DESC LIMIT ?)
      ORDER BY created_at DESC,id DESC LIMIT ?
    `).all(...ids, limit, ...ids, limit, limit).map(messageRow);
  }

  claim(self: string, id: string, leaseSeconds = 1800): Claim {
    seconds(leaseSeconds, 'Lease seconds', 3600);
    return this.transaction(() => this.claimMessage(self, id, leaseSeconds));
  }

  private claimMessage(self: string, id: string, leaseSeconds: number): Claim {
    const message = this.rawMessage(id);
    if (!this.sameSession(message.to, self)) throw new Error('Only the recipient can claim a message');
    this.eligible(message);
    if (message.claimId !== null) {
      return { message, claimId: message.claimId, alreadyClaimed: true };
    }
    const claimId = `claim_${randomUUID()}`;
    const now = this.now();
    this.db.prepare('UPDATE messages SET acknowledged_at=?,claim_id=?,claim_expires_at=? WHERE id=?')
      .run(now, claimId, Math.min(now + leaseSeconds * 1000, message.expiresAt), id);
    return { message: this.rawMessage(id), claimId, alreadyClaimed: false };
  }

  reply(self: string, id: string, claimId: string, body: string, idempotencyKey?: string): Message {
    text(body, 'Body', MAX_BODY_BYTES);
    if (idempotencyKey !== undefined) text(idempotencyKey, 'Idempotency key', 256);
    return this.transaction(() => {
      const original = this.rawMessage(id);
      if (!this.sameSession(original.to, self)) throw new Error('Only the recipient can reply');
      if (original.kind !== 'request') throw new Error('Only a request accepts a reply');
      if (!original.claimId || original.claimId !== claimId) throw new Error('A valid claim is required to reply');
      const fingerprint = hash(JSON.stringify([original.from, body, 'reply', id]));
      if (idempotencyKey !== undefined) {
        const previous = this.previousKey(self, idempotencyKey);
        if (previous) {
          if (!this.sameSession(previous.to, original.from) || previous.body !== body || previous.kind !== 'reply'
            || previous.replyTo !== id) throw new Error('Idempotency key was used with different message input');
          return previous;
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
      if (!this.sameSession(message.from, self)) throw new Error('Only the sender can cancel a message');
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
