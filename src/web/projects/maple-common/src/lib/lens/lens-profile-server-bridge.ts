// Self Hosted's server half of imported lens profiles (#3479), reached only
// through a dynamic import so Hosted's bundle never pulls the authenticated
// HttpClient service in (`check:hosted-capabilities`). Callers hold an
// `Injector` because the render pipeline service that needs the restore is
// itself provided in root and must not statically depend on the server API.

import type { Injector } from '@angular/core';

/** Upload the exact file; resolves with the server's content reference. */
export async function uploadServerLensProfile(injector: Injector, file: File): Promise<string> {
  const { LensProfileServer } = await import('./lens-profile-server.service');
  return new Promise((resolve, reject) =>
    injector
      .get(LensProfileServer)
      .upload(file)
      .subscribe({ next: (result) => resolve(result.reference), error: reject }),
  );
}

/** Copy the server's bytes for `reference` into the browser cache. */
export async function restoreServerLensProfile(
  injector: Injector,
  reference: string,
): Promise<void> {
  const { LensProfileServer } = await import('./lens-profile-server.service');
  return new Promise((resolve, reject) =>
    injector
      .get(LensProfileServer)
      .restore(reference)
      .subscribe({ next: () => resolve(), error: reject }),
  );
}
