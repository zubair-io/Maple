/** The worker session a resolve must run on (#4669): the GPU live session by its
 *  open request id, or the retained CPU source by its token. The worker rejects
 *  the request when that session is no longer the one it holds, so a pair can
 *  only ever describe the photo whose bytes the caller named. */
export interface ImportedWbSession {
  kind: 'live' | 'cpu';
  token: number;
}

/** Resolve the named session's name-only imported Auto WB once, after its
 *  As Shot first frame (#4669). Replies with the shared estimator's pair. */
export interface ResolveImportedWbRequest {
  id: number;
  type: 'resolve-imported-wb';
  session: ImportedWbSession;
}

/** The main thread interrupted the estimate (#5923); the session keeps no pair. */
export interface ResolveImportedWbCancelled {
  id: number;
  type: 'resolve-imported-wb-cancelled';
}

export interface ResolveImportedWbSuccess {
  id: number;
  type: 'resolve-imported-wb-success';
  temperature: number;
  tint: number;
}
