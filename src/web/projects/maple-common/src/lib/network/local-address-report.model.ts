// Wire shape returned by the PUBLIC `GET /api/network/local-address`
// endpoint. Deliberately minimal (no provenance, no override plumbing) —
// this is what clients poll on load to decide whether to prefer the
// server's LAN address over the public URL. See `network-config.model.ts`
// for the authenticated settings CRUD shape.

export interface LocalAddressReport {
  available: boolean;
  ip?: string;
  port?: number;
  scheme?: 'http' | 'https';
}
