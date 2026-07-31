import { InjectionToken } from '@angular/core';

/** Self Hosted credentials needed only for tokenized `<video>` URLs. */
export interface PreviewVideoAccess {
  readonly apiBase: string;
  bearer(): string | null;
}

export const PREVIEW_VIDEO_ACCESS = new InjectionToken<PreviewVideoAccess | null>(
  'PREVIEW_VIDEO_ACCESS',
  { providedIn: 'root', factory: () => null },
);
