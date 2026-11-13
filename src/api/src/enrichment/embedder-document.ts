import {
  placeTextForIndex,
  transcriptForIndex,
  type IndexablePlace,
  type IndexableTranscript,
} from './asset-doc-fields.ts';
import { classifyMediaType } from '../indexer/media-types.ts';

/**
 * Bump ONLY when the rendered document starts or stops reading a field, or a field's meaning
 * changes enough that a stored vector would be actively wrong. Raises the `embed` stage's target
 * version, which re-queues every asset (hours of GPU time), and versions the search child's
 * keyword index.
 */
export const EMBEDDER_TEMPLATE_SHAPE_VERSION = 8;

/**
 * Byte ceiling on the rendered document before it is embedded. 5000 bytes is about 1200 tokens:
 * well inside bge-m3's 8192-token window, enough for the short fields plus a substantial
 * transcript excerpt, small enough that re-embedding a large library stays tractable.
 */
export const EMBEDDER_TEMPLATE_MAX_BYTES = 5000;

/** The asset fields the embedder template reads, as both the stage and the search child hold them. */
export interface EmbeddableAssetFields {
  description?: string | null;
  ocr_text?: string | null;
  transcript?: IndexableTranscript | null;
  place?: IndexablePlace | null;
}

/** The template input for one asset; a null filename (no live location) renders a blank line. */
export function embedderDocumentFor(
  asset: EmbeddableAssetFields,
  filename: string | null,
  people: readonly string[],
): EmbedderDocument {
  return {
    filename,
    mediaType: filename === null ? null : classifyMediaType(filename),
    people: people.length === 0 ? null : people,
    placeText: placeTextForIndex(asset.place),
    description: asset.description ?? null,
    transcript: transcriptForIndex(asset.transcript),
    ocrText: asset.ocr_text ?? null,
  };
}

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

/** The text the embedder reads for a document, capped at the embedder byte limit. */
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
