/** Browser-safe ID syntax contract shared by web and API. Hashing stays in adapters. */
export type IdKind = 'primary' | 'fallback';
export interface MapleId {
  readonly bytes: Uint8Array;
  readonly hex: string;
  readonly kind: IdKind;
}

/** Unknown tag bytes remain accepted, matching Rust MapleId::from_hex. */
export function isMapleId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 32 && /^[0-9a-fA-F]{32}$/.test(value);
}

/** Parse a 32-char hex id back into bytes. */
export function fromHex(hex: string): MapleId {
  if (hex.length !== 32) {
    throw new Error(`maple:id: expected 32 hex chars, got ${hex.length}`);
  }
  if (!isMapleId(hex)) {
    throw new Error('maple:id: invalid hex digit');
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return {
    bytes: out,
    hex: hex.toLowerCase(),
    kind: out[0] === 0x01 ? 'primary' : 'fallback',
  };
}
