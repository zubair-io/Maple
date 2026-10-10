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
 */
export type SearchChildPhase = 'loading' | 'ready' | 'failed';

export interface SearchChildState {
  phase: SearchChildPhase;
  vectors: number;
  texts: number;
  textReady: boolean;
  error?: string;
}

export interface StateResponse {
  type: 'state';
  state: SearchChildState;
}

export type SearchChildResponse = QueryResponse | StateResponse;
