export type Host = 'codex' | 'claude';
export type MessageKind = 'request' | 'reply' | 'notice';
export type DeliveryState = 'stored' | 'dispatching' | 'submitted' | 'unknown';

export interface Peer {
  id: string;
  host: Host;
  label: string;
  nativeSessionId: string | null;
  endpoint: string | null;
  createdAt: number;
  closedAt: number | null;
  attachedAt: number | null;
  statusText: string | null;
  statusUpdatedAt: number | null;
}

export interface Pairing {
  id: string;
  a: string;
  b: string;
  createdAt: number;
  closedAt: number | null;
}

export interface ConnectedPeer {
  peer: Peer;
  pairing: Pairing;
}

export interface ReceiverStatus {
  state: 'available' | 'unavailable' | 'unknown';
  checkedAt: number | null;
  expiresAt: number | null;
}

export interface Message {
  id: string;
  pairingId: string;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  replyTo: string | null;
  createdAt: number;
  expiresAt: number;
  delivery: DeliveryState;
  deliveryDetail: string | null;
  acknowledgedAt: number | null;
  claimId: string | null;
  claimExpiresAt: number | null;
  answeredBy: string | null;
  cancelledAt: number | null;
  notifiedAt?: number | null;
}

export interface SendInput {
  to: string;
  body: string;
  kind?: 'request' | 'notice';
  ttlSeconds?: number;
  idempotencyKey: string;
}

export interface Claim {
  message: Message;
  claimId: string;
  alreadyClaimed: boolean;
}

export interface DeliveryResult {
  state: 'submitted' | 'unknown' | 'stored';
  detail: string;
  nativeQueueId?: string | null;
}

export interface InboxNotification {
  id: string;
  to: string;
  state: 'pending' | 'submitting' | 'submitted' | 'unknown';
  createdAt: number;
  consumedAt: number | null;
  deliveryDetail: string | null;
  nativeQueueId?: string | null;
}

export interface NotificationRead {
  claims: Claim[];
  consumed: boolean;
  notification: InboxNotification | null;
  remaining: boolean;
}

export interface StoreContract {
  readonly home: string;
  createPeer(input: {host: Host; label: string; nativeSessionId?: string; endpoint?: string}): {peer: Peer; ticket: string};
  ensureCodexPeer(input: {nativeSessionId: string; label?: string; attach?: boolean}): Peer;
  findNativePeer(nativeSessionId: string, host?: Host): Peer | null;
  sameSession(a: string, b: string): boolean;
  acquireReceiver(input: {nativeSessionId?: string; label: string}): {peer: Peer; ownerToken: string; ticket?: string};
  renewReceiver(peerId: string, ownerToken: string): boolean;
  releaseReceiver(peerId: string, ownerToken: string): void;
  receiverStatus(peerId: string): ReceiverStatus;
  pendingNotifications(peerId: string, ownerToken: string, limit?: number): Message[];
  markNotified(peerId: string, ownerToken: string, messageId: string): boolean;
  reserveNotification(to: string): InboxNotification | null;
  beginNotificationDelivery(id: string, ownerToken?: string): boolean;
  finishNotificationDelivery(id: string, result: DeliveryResult, ownerToken?: string): void;
  consumeNotification(self: string, id: string, limit?: number): NotificationRead;
  notificationStatus(self: string): {unreadCount: number; pendingRequestCount: number; notification: InboxNotification | null};
  attach(ticket: string): Peer;
  peer(id: string): Peer;
  peers(): Peer[];
  connectedPeers(self: string): ConnectedPeer[];
  updateStatus(self: string, status: string): Peer;
  setEndpoint(id: string, endpoint: string | null): void;
  closePeer(id: string): void;
  pair(self: string, other: string): Pairing;
  pairings(self: string): Pairing[];
  disconnect(self: string, pairingId: string): void;
  send(self: string, input: SendInput): Message;
  message(self: string, id: string): Message;
  inbox(self: string): Message[];
  incoming(self: string, input?: {limit?: number; after?: {createdAt: number; id: string}; unreadOnly?: boolean}): Message[];
  history(self: string, limit?: number): Message[];
  claim(self: string, id: string, leaseSeconds?: number): Claim;
  reply(self: string, id: string, claimId: string, body: string, idempotencyKey?: string): Message;
  cancel(self: string, id: string): Message;
  beginDelivery(id: string): boolean;
  finishDelivery(id: string, result: DeliveryResult): void;
  close(): void;
}
