// One owned transfer buffer for verified immutable companions (#3955).
// Rust validates the complete manifest and every digest before installing it.
export interface RemovalCompanionBundle {
  manifest: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export function bundleRemovalCompanions(
  companions: ReadonlyMap<string, Uint8Array>,
): RemovalCompanionBundle {
  const entries = [...companions].map(([name, bytes]) => ({ name, length: bytes.byteLength }));
  const length = entries.reduce((total, entry) => total + entry.length, 0);
  if (!Number.isSafeInteger(length) || length > 0xffffffff) {
    throw new Error('Removal companions exceed the browser transfer budget.');
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const companion of companions.values()) {
    bytes.set(companion, offset);
    offset += companion.byteLength;
  }
  return { manifest: JSON.stringify(entries), bytes };
}
