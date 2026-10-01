import type { Migration } from '../migrate.ts';

export const removeUnusedImageCapabilitiesMigration: Migration = {
  id: '0010-remove-unused-image-capabilities',
  async up(db): Promise<void> {
    await db.exec('DROP TABLE image_access_tokens');
  },
};
