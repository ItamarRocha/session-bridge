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
}

export interface Pairing {
  id: string;
  a: string;
  b: string;
  createdAt: number;
  closedAt: number | null;
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
}

export interface StoreContract {
  readonly home: string;
  createPeer(input: {host: Host; label: string; nativeSessionId?: string; endpoint?: string}): {peer: Peer; ticket: string};
  attach(ticket: string): Peer;
  peer(id: string): Peer;
  peers(): Peer[];
  setEndpoint(id: string, endpoint: string | null): void;
  closePeer(id: string): void;
  pair(self: string, other: string): Pairing;
  pairings(self: string): Pairing[];
  disconnect(self: string, pairingId: string): void;
  send(self: string, input: SendInput): Message;
  message(self: string, id: string): Message;
  inbox(self: string): Message[];
  history(self: string, limit?: number): Message[];
  claim(self: string, id: string, leaseSeconds?: number): Claim;
  reply(self: string, id: string, claimId: string, body: string): Message;
  cancel(self: string, id: string): Message;
  beginDelivery(id: string): boolean;
  finishDelivery(id: string, result: DeliveryResult): void;
  close(): void;
}
