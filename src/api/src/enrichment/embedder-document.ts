import { EMBEDDER_TEMPLATE_MAX_BYTES } from './meilisearch-embedder-template.ts';

export interface EmbedderDocument {
  filename: string | null;
  mediaType: string | null;
  people: readonly string[] | null;
  placeText: string | null;
  description: string | null;
  transcript: string | null;
  ocrText: string | null;
}

const CONTINUATION_BYTE_MASK = 0xc0;
const CONTINUATION_BYTE = 0x80;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Liquid treats only nil and false as falsy, so an empty string still emits its label line.
function labelLine(label: string, value: string | null): string {
  return value === null ? '' : `${label}: ${value}`;
}

function characterBoundaryAtOrBefore(bytes: Uint8Array, limit: number): number {
  const isContinuation = (index: number) =>
    ((bytes[index] ?? 0) & CONTINUATION_BYTE_MASK) === CONTINUATION_BYTE;
  return Array.from({ length: limit + 1 }, (_, offset) => limit - offset).find(
    (index) => !isContinuation(index),
  )!;
}

function truncateToByteLimit(text: string, maxBytes: number): string {
  const bytes = textEncoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  return textDecoder.decode(bytes.subarray(0, characterBoundaryAtOrBefore(bytes, maxBytes)));
}

/** The text Meilisearch's Liquid template produces for a document, capped at the embedder byte limit. */
export function renderEmbedderDocument(doc: EmbedderDocument): string {
  const rendered = [
    labelLine('Filename', doc.filename),
    labelLine('Media type', doc.mediaType),
    labelLine('People', doc.people === null ? null : doc.people.join('')),
    labelLine('Place', doc.placeText),
    labelLine('Visual description', doc.description),
    labelLine('Video transcript', doc.transcript),
    labelLine('OCR', doc.ocrText),
  ].join('\n');
  return truncateToByteLimit(rendered, EMBEDDER_TEMPLATE_MAX_BYTES);
}
