import type { ByteSource } from './byte-source.ts';

const XMP_SIGNATURE = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const MAX_SEGMENTS = 256;
const APP1 = 0xe1;
const START_OF_SCAN = 0xda;
const END_OF_IMAGE = 0xd9;

function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

async function xmpPayload(
  source: ByteSource,
  payloadStart: number,
  payloadLength: number,
): Promise<string | null> {
  if (payloadLength <= XMP_SIGNATURE.length) return null;
  const signature = await source.read(payloadStart, XMP_SIGNATURE.length);
  if (!signature?.equals(XMP_SIGNATURE)) return null;
  const packet = await source.read(
    payloadStart + XMP_SIGNATURE.length,
    payloadLength - XMP_SIGNATURE.length,
  );
  return packet ? packet.toString('utf8') : null;
}

/**
 * The standard XMP packet of a JPEG: the first APP1 segment carrying the
 * Adobe XMP signature, found by walking segment headers up to the start of
 * scan. Only headers and that one segment are read — never the entropy-coded
 * image data — and an APP1 payload is at most 64 KB by construction.
 */
export async function readJpegXmp(source: ByteSource): Promise<string | null> {
  const visit = async (offset: number, index: number): Promise<string | null> => {
    if (index >= MAX_SEGMENTS) return null;
    const head = await source.read(offset, 2);
    if (!head || head[0] !== 0xff) return null;
    const marker = head[1]!;
    if (marker === 0xff) return visit(offset + 1, index + 1);
    if (marker === START_OF_SCAN || marker === END_OF_IMAGE) return null;
    if (isStandalone(marker)) return visit(offset + 2, index + 1);
    const lengthBytes = await source.read(offset + 2, 2);
    if (!lengthBytes) return null;
    const segmentLength = lengthBytes.readUInt16BE(0);
    if (segmentLength < 2) return null;
    const found = marker === APP1 ? await xmpPayload(source, offset + 4, segmentLength - 2) : null;
    return found ?? visit(offset + 2 + segmentLength, index + 1);
  };
  return visit(2, 0);
}
