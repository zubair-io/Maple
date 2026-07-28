/**
 * Maple-owned Meilisearch index settings and the narrow comparison used to
 * avoid submitting an unchanged settings task. Meilisearch reindexes existing
 * documents after settings updates, so an unconditional PATCH at startup can
 * put a large semantic backfill behind hours of duplicate embedding work.
 */

import {
  EMBEDDER_DOCUMENT_TEMPLATE,
  EMBEDDER_TEMPLATE_MAX_BYTES,
} from './meilisearch-embedder-template.ts';
import { joinMeilisearchUrl } from './meilisearch-transport.ts';

interface AssetsIndexSettingsConfig {
  semantic: boolean;
  embedderUrl: string;
  embedderModel: string;
}

/**
 * Output dimensionality of the embedding models we ship or expect operators
 * to pick, keyed by Ollama model name without its tag.
 *
 * Declaring `dimensions` lets Meilisearch skip its own dimension probe — an
 * extra round-trip to the embedding server, made while applying settings,
 * that can fail on its own and takes the entire embedder registration down
 * with it when it does.
 *
 * A WRONG value is far worse than no value: Meilisearch would reject or
 * truncate every vector. `meilisearch_embedder_model` is operator-settable,
 * so anything not listed here deliberately falls back to the probe rather
 * than guessing. Add an entry only when the model's size is known for
 * certain.
 */
const EMBEDDER_DIMENSIONS: Readonly<Record<string, number>> = {
  'bge-m3': 1024,
  'bge-large': 1024,
  'mxbai-embed-large': 1024,
  'nomic-embed-text': 768,
  'all-minilm': 384,
};

/** Known output size for an Ollama model id, ignoring any `:tag` suffix.
 * `undefined` means "we don't know — let Meilisearch probe". */
function embedderDimensions(model: string): number | undefined {
  return EMBEDDER_DIMENSIONS[model.split(':')[0]!.trim().toLowerCase()];
}

export function assetsIndexSettings(
  config: AssetsIndexSettingsConfig,
  embedderName: string,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    // Order is ranking-significant: Meilisearch's `attribute` rule favours
    // matches in earlier attributes. filename first keeps exact-identifier
    // queries top-1; people second because a name query wants photos OF that
    // person, not a transcript that mentions them; then real evidence
    // (transcript, OCR) above guessed captions. searchBlob stays last — it is
    // the only home for the structured vision tokens, so it must remain
    // searchable, but at the lowest weight (#2384).
    searchableAttributes: [
      'filename',
      'people',
      'transcript',
      'ocrText',
      'description',
      'placeText',
      'searchBlob',
    ],
    filterableAttributes: [
      'folderId',
      'deletedAt',
      'visionSceneType',
      'visionActivity',
      'visionSubjects',
      'isScreenshot',
      'people',
      'mediaType',
      'hidden',
    ],
    sortableAttributes: ['capturedAt'],
  };
  if (config.semantic) {
    const dimensions = embedderDimensions(config.embedderModel);
    settings.embedders = {
      [embedderName]: {
        source: 'ollama',
        url: joinMeilisearchUrl(config.embedderUrl, '/api/embed'),
        model: config.embedderModel,
        documentTemplate: EMBEDDER_DOCUMENT_TEMPLATE,
        // Meilisearch defaults this to 400 bytes and silently truncates the
        // rendered template to it. Always send it explicitly — see the note
        // on EMBEDDER_TEMPLATE_MAX_BYTES.
        documentTemplateMaxBytes: EMBEDDER_TEMPLATE_MAX_BYTES,
        // Omitted entirely for unknown models — see EMBEDDER_DIMENSIONS.
        ...(dimensions === undefined ? {} : { dimensions }),
      },
    };
  } else {
    // An all-settings PATCH is partial: omitting embedders preserves an
    // existing configuration. Null resets it when semantic search is disabled.
    settings.embedders = null;
  }
  return settings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameStringArray(actual: unknown, expected: unknown): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index] && typeof value === 'string')
  );
}

// Meilisearch stores filterableAttributes and sortableAttributes as a
// BTreeSet and returns them alphabetically sorted from GET /settings,
// regardless of submission order — unlike searchableAttributes, whose order
// is ranking-significant and which Meilisearch echoes back in submission
// order. Compare these two fields as sets, not sequences.
function sameStringSet(actual: unknown, expected: unknown): boolean {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  if (actual.length !== expected.length) return false;
  const allStrings =
    actual.every((value) => typeof value === 'string') &&
    expected.every((value) => typeof value === 'string');
  if (!allStrings) return false;
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((value, index) => value === sortedExpected[index]);
}

function managedEmbedderConfigMatches(actual: unknown, expected: unknown): boolean {
  if (!isRecord(actual) || !isRecord(expected)) return false;
  // `documentTemplateMaxBytes` is compared unconditionally: we always send
  // it, so an index still carrying Meilisearch's 400-byte default must be
  // re-PATCHed or the new template is truncated to near-nothing.
  const baseMatches = [
    'source',
    'url',
    'model',
    'documentTemplate',
    'documentTemplateMaxBytes',
  ].every((field) => actual[field] === expected[field]);
  // `dimensions` is compared ONLY when we send one. For an unknown model we
  // omit it and Meilisearch probes a value it then echoes back from
  // GET /settings; comparing that unconditionally would mismatch on every
  // boot, and each resulting PATCH re-embeds the whole index.
  const dimensionsMatch =
    expected.dimensions === undefined || actual.dimensions === expected.dimensions;
  return baseMatches && dimensionsMatch;
}

function embedderMatches(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual == null || (isRecord(actual) && !Object.keys(actual).length);
  if (!isRecord(actual) || !isRecord(expected)) return false;
  return Object.entries(expected).every(([name, config]) =>
    managedEmbedderConfigMatches(actual[name], config),
  );
}

export function assetsIndexSettingsMatch(
  actual: unknown,
  expected: Record<string, unknown>,
): boolean {
  if (!isRecord(actual)) return false;
  const searchableMatches = sameStringArray(
    actual.searchableAttributes,
    expected.searchableAttributes,
  );
  const orderInsensitiveMatches = ['filterableAttributes', 'sortableAttributes'].every((field) =>
    sameStringSet(actual[field], expected[field]),
  );
  return (
    searchableMatches &&
    orderInsensitiveMatches &&
    embedderMatches(actual.embedders, expected.embedders)
  );
}
