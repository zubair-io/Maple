import { BackupRepository, type BackupDestination } from '../repository.ts';
import { GoogleDriveProvider } from './provider.ts';
import { googleAccessToken } from './oauth.ts';
import { loadConnection } from './repo.ts';

/** Every authenticated request checks the captured destination generation;
 * pause/disconnect/reconfiguration cannot revive an already fenced transfer. */
export function providerForDestination(destination: BackupDestination): GoogleDriveProvider {
  if (destination.kind !== 'google-drive' || !destination.rootId)
    throw new Error('Connect Google Drive and select its Maple backup folder.');
  return new GoogleDriveProvider(destination.rootId, async () => {
    const current = await new BackupRepository().destination(destination.id);
    if (
      !current ||
      current.generation !== destination.generation ||
      current.rootId !== destination.rootId
    ) {
      throw new Error('Google backup destination changed; retry with current settings.');
    }
    const token = await googleAccessToken(destination.id);
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
  });
}
