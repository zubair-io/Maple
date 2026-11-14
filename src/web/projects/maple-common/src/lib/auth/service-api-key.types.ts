/** The service API scopes an owner can grant an integration key. */
export type ServiceApiScope = 'assets:search' | 'assets:read' | 'people:read';

/** Metadata for a least-privilege integration key. The plaintext secret is never listed. */
export interface ServiceApiKey {
  keyId: string;
  prefix: string;
  name: string;
  scopes: ServiceApiScope[];
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** A newly minted integration key. `key` is returned by Maple exactly once. */
export interface CreatedServiceApiKey {
  key: string;
  keyId: string;
  prefix: string;
  name: string;
  scopes: ServiceApiScope[];
  createdAt: string;
  expiresAt: string | null;
}
