/**
 * Maple-owned Meilisearch index settings and the narrow comparison used to
 * avoid submitting an unchanged settings task. Meilisearch reindexes existing
 * documents after settings updates, so an unconditional PATCH at startup can
 * put a large semantic backfill behind hours of duplicate embedding work.
 */

import { EMBEDDER_DOCUMENT_TEMPLATE } from './meilisearch-embedder-template.ts';
import { joinMeilisearchUrl } from './meilisearch-transport.ts';

interface AssetsIndexSettingsConfig {
  semantic: boolean;
  embedderUrl: string;
  embedderModel: string;
}

export function assetsIndexSettings(
  config: AssetsIndexSettingsConfig,
  embedderName: string,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {
    searchableAttributes: ['filename', 'searchBlob', 'description', 'people', 'ocrText'],
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
    settings.embedders = {
      [embedderName]: {
        source: 'ollama',
        url: joinMeilisearchUrl(config.embedderUrl, '/api/embed'),
        model: config.embedderModel,
        documentTemplate: EMBEDDER_DOCUMENT_TEMPLATE,
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
  return ['source', 'url', 'model', 'documentTemplate'].every(
    (field) => actual[field] === expected[field],
  );
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
