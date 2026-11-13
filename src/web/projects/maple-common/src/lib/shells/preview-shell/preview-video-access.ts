import { InjectionToken } from '@angular/core';

/** Self Hosted credentials needed only for tokenized `<video>` URLs. */
export interface PreviewVideoAccess {
  readonly apiBase: string;
  bearer(): string | null;
}

/** Tokenized `<video>` URL for a library-addressed route, or undefined without credentials. */
export function mediaRouteUrl(
  access: PreviewVideoAccess | null,
  route: 'video' | 'motion',
  apiPath: string,
): string | undefined {
  const token = access?.bearer();
  return access && token
    ? `${access.apiBase}/${route}/${apiPath}?${new URLSearchParams({ token })}`
    : undefined;
}

export const PREVIEW_VIDEO_ACCESS = new InjectionToken<PreviewVideoAccess | null>(
  'PREVIEW_VIDEO_ACCESS',
  { providedIn: 'root', factory: () => null },
);
