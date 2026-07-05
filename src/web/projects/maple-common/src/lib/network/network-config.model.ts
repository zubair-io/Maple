// LAN-address settings config — wire shape returned by
// `GET /api/network/config`. Mirrors the snake_case the Bun API ships.
//
// Lets an operator override the auto-detected local network address (or
// port) self-hosted clients prefer over the public URL when they're on the
// same network as the server. See `local-address-report.model.ts` for the
// smaller public-endpoint shape clients actually poll on load.

export interface NetworkConfigSource {
  local_ip: 'db_override' | 'auto_detected' | 'unavailable';
  local_port: 'db_override' | 'default';
}

export interface NetworkConfigResponse {
  /** Master switch. When false, no LAN address is advertised at all. */
  enabled: boolean;
  /** The resolved LAN IP/hostname clients would be told about, or `null`
   * when disabled or auto-detection found nothing. */
  local_ip: string | null;
  /** The resolved port clients would be told about. */
  local_port: number;
  source: NetworkConfigSource;
}

/** Editable subset sent to `PUT /api/network/config`. Patch semantics: every
 * field is optional; only the ones provided are changed. `null` clears an
 * override back to auto-detection/the server's listen port. */
export interface NetworkConfigPatch {
  enabled?: boolean | null;
  local_ip_override?: string | null;
  local_port_override?: number | null;
}
