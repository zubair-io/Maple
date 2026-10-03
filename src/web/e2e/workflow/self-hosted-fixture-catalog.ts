import type { ApplicationRef } from '@angular/core';
import type { ApiFolder } from '../../projects/maple-common/src/lib/workspace/server-library-io';
import { LibraryStore } from '../../projects/maple-common/src/lib/state/library-store.service';

/** Seed catalog identities; HTTP reads, writes and editor services remain production code. */
export function seedSelfHostedFixtures(
  app: ApplicationRef,
  sources: readonly { key: string; library: ApiFolder }[],
) {
  const store = app.injector.get(LibraryStore);
  store.registeredFolders.set([sources[0].library]);
  store.assets.set(
    sources.map((source) => ({
      id: `workflow-fixture:${source.key}/photo.dng`,
      filename: 'photo.dng',
      folderId: source.library.id,
      rating: 0,
      flag: 'unflagged' as const,
      colorLabel: null,
      keywords: [],
      thumbnailGradient: '',
      aspectRatio: 1,
    })),
  );
  return store;
}
