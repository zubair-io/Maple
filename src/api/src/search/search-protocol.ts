/**
 * Wire protocol between the search child (`search.child.ts`) and its manager (`search-pool.ts`).
 * Its own module so both sides import one set of shapes and the child never imports the manager.
 */

import type { FusedSearchHit, SearchEngineConfig } from './search-engine-ffi.ts';

export interface SearchChildConfig {
  engine: SearchEngineConfig;
  /** Where the child keeps the text index version and its catch-up watermark. */
  stateFile: string;
  dbPath: string;
}

export interface StartRequest {
  type: 'start';
  config: SearchChildConfig;
}

export interface QueryRequest {
  type: 'query';
  id: number;
  query: string;
  k: number;
}

export type SearchChildRequest = StartRequest | QueryRequest;

export interface QueryResponse {
  type: 'query';
  id: number;
  ok: boolean;
  hits?: FusedSearchHit[];
  error?: string;
}

/**
 * `loading` until every vector is in memory; `ready` from then on, with `textReady` false while
 * the keyword index is still being rebuilt; `failed` when the engine could not open.
 * `incompatible-embedder` when the configured embedding model is not the one the child embeds
 * queries with, and `empty` while no vector of that model exists yet: in both the child answers
 * nothing, and searches take the Meilisearch path.
 */
export type SearchChildPhase = 'loading' | 'ready' | 'empty' | 'incompatible-embedder' | 'failed';

export interface SearchChildState {
  phase: SearchChildPhase;
  vectors: number;
  texts: number;
  textReady: boolean;
  /** The embedding model whose vectors were loaded — the `embed` stage's, from Settings → AI. */
  model?: string;
  /** The `asset_vectors.model` values that count as that model (`bge-m3`, `bge-m3:latest`). */
  matchedModels?: string[];
  /** Rows of `asset_vectors` left out because another model (or dimension) wrote them. */
  skippedVectors?: number;
  error?: string;
}

export interface StateResponse {
  type: 'state';
  state: SearchChildState;
}

export type SearchChildResponse = QueryResponse | StateResponse;
