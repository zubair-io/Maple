import { getDb } from '../db/client.ts';

const COLL = 'app_settings';
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
    const db = await getDb();
    const doc = await db.collection<DisplayConfigDoc>(COLL).findOne({ _id: DOC_ID });
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
    .collection<DisplayConfigDoc>(COLL)
    .updateOne(
      { _id: DOC_ID },
      { $set: { show_hidden_images: config.show_hidden_images } },
      { upsert: true },
    );
}
