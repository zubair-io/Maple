// APNs push-to-signal settings config — wire shape for
// `GET/PUT /api/apns/config` (#1025). Surfaced on Settings → Network
// alongside the LAN-address override: the operator-facing on/off switch
// for replacing the File Provider extension's held SSE connection with a
// coalesced APNs wake push. SSE stays the fallback whenever this is off,
// or on but the server has no MAPLE_APNS_* credentials configured.

export interface ApnsConfigResponse {
  /** Operator opt-in. Default false — most self-hosted operators have no
   * Apple Developer Program membership, so shipping this defaulted-on
   * would silently do nothing until credentials appear. */
  enabled: boolean;
  /** Whether the server process has MAPLE_APNS_KEY_ID / MAPLE_APNS_TEAM_ID
   * / MAPLE_APNS_PRIVATE_KEY all set. `enabled: true` with this `false`
   * means the toggle is on but push is silently a no-op. */
  credentials_configured: boolean;
}

/** Editable subset sent to `PUT /api/apns/config`. */
export interface ApnsConfigPatch {
  enabled?: boolean | null;
}
