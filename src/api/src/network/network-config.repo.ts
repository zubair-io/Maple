/**
 * Persisted local-network-address config. Mirrors the observability-config
 * shape: a single document in `app_settings` keyed by `_id: "network"`.
 *
 * Self-hosted Maple is commonly reachable via a public URL (reverse proxy,
 * dyndns hostname, Cloudflare Tunnel) as well as directly over the LAN when
 * a client happens to be on the same network as the server. This module
 * resolves the LAN address to advertise via `GET /api/network/local-address`
 * (see `../routes/network.ts`) so clients can prefer it over the public URL.
 *
 * The primary supported deployment (`docker compose --profile app up -d`)
 * uses default bridge networking, so `os.networkInterfaces()` run INSIDE the
 * container reports the container's internal bridge IP, not the host's real
 * LAN IP. Auto-detection is therefore only a convenience default — the
 * operator can override it via the web Settings → Network page (or
 * `PUT /api/network/config`).
 */

import { networkInterfaces } from 'node:os';
import { getDb } from '../db/client.ts';
import { SERVER_PORT } from '../runtime/server-port.ts';

const COLL = 'app_settings';
const DOC_ID = 'network';

/** Valid TCP port range. Shared by the resolver (guards against a stale/
 * hand-edited DB row) and the route's write-side validation. */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export interface NetworkConfig {
  /** Operator override for the advertised LAN IP/hostname. `null`/missing →
   * fall back to auto-detection. */
  local_ip_override?: string | null;
  /** Operator override for the advertised port. `null`/missing → `SERVER_PORT`. */
  local_port_override?: number | null;
  /** Master switch. When false, no LAN address is advertised at all.
   * `null`/missing → resolver default true. */
  enabled?: boolean | null;
  updated_at?: number;
}

interface NetworkConfigDoc {
  _id: string;
  config: NetworkConfig;
}

export interface ResolvedNetworkConfig {
  enabled: boolean;
  local_ip: string | null;
  local_port: number;
  source: {
    local_ip: 'db_override' | 'auto_detected' | 'unavailable';
    local_port: 'db_override' | 'default';
  };
}

/** Read the persisted config. Returns `null` when no row exists yet. */
export async function loadNetworkConfig(): Promise<NetworkConfig | null> {
  try {
    const db = await getDb();
    const doc = await db.collection<NetworkConfigDoc>(COLL).findOne({ _id: DOC_ID });
    return doc?.config ?? null;
  } catch {
    return null;
  }
}

/** Upsert. Partial patches are supported: only the fields you supply are
 * touched, the rest of the config doc is preserved. */
export async function saveNetworkConfig(patch: Partial<NetworkConfig>): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    'config.updated_at': Date.now(),
  };
  if (patch.enabled !== undefined) {
    set['config.enabled'] = patch.enabled;
  }
  if (patch.local_ip_override !== undefined) {
    set['config.local_ip_override'] = patch.local_ip_override;
  }
  if (patch.local_port_override !== undefined) {
    set['config.local_port_override'] = patch.local_port_override;
  }
  await db.collection(COLL).updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
}

/** Best-effort validator for an operator-supplied `local_ip_override`. We
 * don't restrict to private IP ranges only — some operators run unusual
 * topologies (e.g. Tailscale) where the "local" address isn't RFC1918 — we
 * just reject strings that can't plausibly be a host (whitespace, empty).
 * Returns the trimmed value, `null` for empty input, or `{ error }`. */
export function validateLocalAddress(raw: string | null): string | null | { error: string } {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/\s/.test(trimmed)) return { error: 'Address must not contain whitespace' };
  return trimmed;
}

/** Interface name prefixes that are virtual/bridge networks rather than a
 * real LAN-facing NIC — best effort only. This heuristic can't see the
 * Docker HOST's real LAN IP from inside a container; that's exactly why the
 * DB override exists. */
const VIRTUAL_IFACE_PREFIX = /^(docker|br-|veth|virbr)/i;

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** Best-effort auto-detect of a LAN-facing IPv4 address: enumerate network
 * interfaces, skip loopback + obviously-virtual interfaces, and prefer
 * RFC1918 private ranges over anything else that slips through. Returns
 * `null` when nothing usable was found. */
export function detectLocalIPv4(): string | null {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    if (VIRTUAL_IFACE_PREFIX.test(name)) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      candidates.push(addr.address);
    }
  }
  candidates.sort((a, b) => Number(PRIVATE_IPV4.test(b)) - Number(PRIVATE_IPV4.test(a)));
  return candidates[0] ?? null;
}

/** Resolve the effective config: DB override wins; otherwise fall back to
 * auto-detection. Pure function (auto-detect aside, which reads live
 * interface state) — no DB access, easy to test. */
export function resolveNetworkConfig(db: NetworkConfig | null): ResolvedNetworkConfig {
  const enabled = typeof db?.enabled === 'boolean' ? db.enabled : true;

  let localIp: string | null = null;
  let localIpSource: ResolvedNetworkConfig['source']['local_ip'] = 'unavailable';
  if (enabled) {
    if (typeof db?.local_ip_override === 'string' && db.local_ip_override.trim().length > 0) {
      localIp = db.local_ip_override.trim();
      localIpSource = 'db_override';
    } else {
      const detected = detectLocalIPv4();
      if (detected) {
        localIp = detected;
        localIpSource = 'auto_detected';
      }
    }
  }

  let localPort = SERVER_PORT;
  let localPortSource: ResolvedNetworkConfig['source']['local_port'] = 'default';
  if (typeof db?.local_port_override === 'number' && isValidPort(db.local_port_override)) {
    localPort = db.local_port_override;
    localPortSource = 'db_override';
  }

  return {
    enabled,
    local_ip: localIp,
    local_port: localPort,
    source: {
      local_ip: localIpSource,
      local_port: localPortSource,
    },
  };
}
