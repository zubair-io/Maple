// Self Hosted's server half of subject masks (#3300 slice 3), reached only
// through a dynamic import so Hosted's bundle never pulls the authenticated
// HttpClient service in (`check:hosted-capabilities`). Callers hold an
// `Injector` because the detection service that needs it is itself provided
// in root and must not statically depend on the server API.

import type { Injector } from '@angular/core';
import type { SubjectMaskDetection } from './subject-mask-server.service';

/** Who is in the frame, per the server's segmentation stage. */
export async function detectServerSubjectMasks(
  injector: Injector,
  assetKey: string,
): Promise<SubjectMaskDetection> {
  const { SubjectMaskServer } = await import('./subject-mask-server.service');
  return new Promise((resolve, reject) =>
    injector.get(SubjectMaskServer).detectPersons(assetKey).subscribe({
      next: resolve,
      error: reject,
    }),
  );
}

/** The digest's PNG bytes verbatim — the caller decodes and caches them. */
export async function fetchServerSubjectMaskRasterBytes(
  injector: Injector,
  digest: string,
): Promise<ArrayBuffer> {
  const { SubjectMaskServer } = await import('./subject-mask-server.service');
  return new Promise((resolve, reject) =>
    injector.get(SubjectMaskServer).fetchRasterBytes(digest).subscribe({
      next: resolve,
      error: reject,
    }),
  );
}
