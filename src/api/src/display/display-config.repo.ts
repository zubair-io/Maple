import { patchAppSettings, readAppSettings } from '../db/repos/app-settings.repo.ts';

const DOC_ID = 'display';

export interface DisplayConfig {
  show_hidden_images: boolean;
}

interface DisplayConfigDoc {
  _id: string;
  show_hidden_images: boolean;
}

export async function loadDisplayConfig(): Promise<DisplayConfig> {
  try {
    const doc = await readAppSettings<DisplayConfigDoc>(DOC_ID);
    if (doc) {
      return {
        show_hidden_images: !!doc.show_hidden_images,
      };
    }
  } catch {
    // Ignore and fallback to default
  }
  return { show_hidden_images: false };
}

export async function saveDisplayConfig(config: DisplayConfig): Promise<void> {
  await patchAppSettings(DOC_ID, { show_hidden_images: config.show_hidden_images });
}
