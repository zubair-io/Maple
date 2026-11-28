import { BackupRepository, type BackupDestination } from '../repository.ts';
import { GoogleDriveProvider } from './provider.ts';
import { forgetGoogleAccessToken, googleAccessToken } from './oauth.ts';
import { loadConnection } from './repo.ts';

const shared = new Map<string, { key: string; provider: GoogleDriveProvider }>();

/** Concurrent transfers to one destination share a provider, and with it the
 * provider's short-lived root and folder validations, until the destination's
 * generation or root changes. */
export function sharedProviderForDestination(destination: BackupDestination): GoogleDriveProvider {
  const key = `${destination.generation}:${destination.rootId}:${destination.accountId}`;
  const current = shared.get(destination.id);
  if (current?.key === key) return current.provider;
  const provider = providerForDestination(destination);
  shared.set(destination.id, { key, provider });
  return provider;
}

/** Every authenticated request checks the captured destination generation;
 * pause/disconnect/reconfiguration cannot revive an already fenced transfer. */
export function providerForDestination(destination: BackupDestination): GoogleDriveProvider {
  if (destination.kind !== 'google-drive' || !destination.rootId)
    throw new Error('Connect Google Drive and select its Maple backup folder.');
  return new GoogleDriveProvider(
    destination.rootId,
    async (signal?: AbortSignal) => {
      const current = await new BackupRepository().destination(destination.id);
      if (
        !current ||
        current.generation !== destination.generation ||
        current.rootId !== destination.rootId
      ) {
        throw new Error('Google backup destination changed; retry with current settings.');
      }
      const token = await googleAccessToken(destination.id, fetch, signal);
      const connection = await loadConnection(destination.id);
      if (destination.accountId && connection.config.accountId !== destination.accountId)
        throw new Error('Reconnect the original Google account for this destination.');
      const after = await new BackupRepository().destination(destination.id);
      if (
        !after ||
        after.generation !== destination.generation ||
        after.rootId !== destination.rootId
      )
        throw new Error('Google backup destination changed during token renewal.');
      return token;
    },
    fetch,
    (rejected) => forgetGoogleAccessToken(destination.id, rejected),
  );
}
