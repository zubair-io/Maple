import { getDb } from '../db/client.ts';

export interface DisplayConfig {
  show_hidden_images: boolean;
}

export async function loadDisplayConfig(): Promise<DisplayConfig> {
  try {
    const db = await getDb();
    const doc = await db.collection('app_settings').findOne({ _id: 'display' });
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
  const db = await getDb();
  await db
    .collection('app_settings')
    .updateOne(
      { _id: 'display' },
      { $set: { show_hidden_images: config.show_hidden_images } },
      { upsert: true },
    );
}
