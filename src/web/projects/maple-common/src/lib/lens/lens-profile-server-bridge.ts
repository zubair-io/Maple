import type { Injector } from '@angular/core';

/** Keep authenticated server dependencies behind the Self Hosted boundary. */
export async function uploadServerLensProfile(injector: Injector, file: File): Promise<string> {
  const { LensProfileServer } = await import('./lens-profile-server.service');
  return new Promise((resolve, reject) =>
    injector
      .get(LensProfileServer)
      .upload(file)
      .subscribe({
        next: (result) => resolve(result.reference),
        error: reject,
      }),
  );
}

export async function restoreServerLensProfile(
  injector: Injector,
  reference: string,
): Promise<void> {
  const { LensProfileServer } = await import('./lens-profile-server.service');
  return new Promise((resolve, reject) =>
    injector
      .get(LensProfileServer)
      .restore(reference)
      .subscribe({
        next: () => resolve(),
        error: reject,
      }),
  );
}
