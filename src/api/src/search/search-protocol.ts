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

/** Document texts for the `embed` stage, embedded with the query model. */
export interface EmbedRequest {
  type: 'embed';
  id: number;
  texts: string[];
}

export type SearchChildRequest = StartRequest | QueryRequest | EmbedRequest;

export interface QueryResponse {
  type: 'query';
  id: number;
  ok: boolean;
  hits?: FusedSearchHit[];
  error?: string;
}

/**
 * `vectors` holds one base64 string of 1024 little-endian f32 per text. `loading` is set when the
 * engine is not open yet, so the stage waits instead of spending a retry.
 */
export interface EmbedResponse {
  type: 'embed';
  id: number;
  ok: boolean;
  vectors?: string[];
  loading?: boolean;
  error?: string;
}

/**
 * `loading` until every vector is in memory; `ready` from then on, with `textReady` false while
 * the keyword index is still being rebuilt; `failed` when the engine could not open. `empty`
 * while no bge-m3 vector exists yet: the child answers no query, and searches take the
 * database's full-text path, but it does embed documents.
 */
export type SearchChildPhase = 'loading' | 'ready' | 'empty' | 'failed';

export interface SearchChildState {
  phase: SearchChildPhase;
  vectors: number;
  texts: number;
  textReady: boolean;
  /** The embedding model whose vectors were loaded: always the bundled bge-m3. */
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

export type SearchChildResponse = QueryResponse | EmbedResponse | StateResponse;

/**
 * A batch of document vectors, or why there are none. `waiting` means the engine cannot embed
 * yet (not running, still loading the model, busy, restarting), so the caller should try later
 * without counting it as a failure.
 */
export type EmbedOutcome =
  | { ok: true; vectors: Float32Array[] }
  | { ok: false; waiting: boolean; error: string };
