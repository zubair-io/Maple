import { patchAppSettings, readAppSettings } from '../db/repos/app-settings.repo.ts';

const DOC_ID = 'display';

export interface DisplayConfig {
  show_hidden_images: boolean;
  /** One image for a RAW+JPEG pair with the same stem in the Library grid (#5050). */
  stack_raw_jpeg: boolean;
}

interface DisplayConfigDoc {
  _id: string;
  show_hidden_images?: boolean;
  stack_raw_jpeg?: boolean;
}

export async function loadDisplayConfig(): Promise<DisplayConfig> {
  const doc = await readAppSettings<DisplayConfigDoc>(DOC_ID).catch(() => null);
  return {
    show_hidden_images: !!doc?.show_hidden_images,
    stack_raw_jpeg: doc?.stack_raw_jpeg !== false,
  };
}

export async function saveDisplayConfig(config: Partial<DisplayConfig>): Promise<void> {
  await patchAppSettings(DOC_ID, config);
}
