/** How a document vector is stored (`asset_vectors.vector`) and carried over IPC. */

/** Little-endian f32 bytes, independent of the host's byte order. */
export function encodeVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Float32Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
    view.getFloat32(index * 4, true),
  );
}

/** The stored bytes as base64: exact, and a third of the size of a JSON number array. */
export function vectorToBase64(vector: Float32Array): string {
  return Buffer.from(encodeVector(vector)).toString('base64');
}

export function vectorFromBase64(encoded: string): Float32Array {
  return decodeVector(Buffer.from(encoded, 'base64'));
}
