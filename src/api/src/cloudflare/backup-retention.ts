import { backupTimestamp } from './backup-key.ts';
import type { DbBackupPolicy } from './backup-retain-config.ts';

function bucketStart(time: number, tier: 'daily' | 'weekly' | 'monthly' | 'yearly'): number {
  const date = new Date(time);
  date.setUTCHours(0, 0, 0, 0);
  if (tier === 'weekly') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (tier === 'monthly' || tier === 'yearly') date.setUTCDate(1);
  if (tier === 'yearly') date.setUTCMonth(0);
  return date.getTime();
}

export function expiredBackups(keys: string[], policy: DbBackupPolicy, now = Date.now()): string[] {
  const backups = keys
    .flatMap((key) => {
      const time = backupTimestamp(key);
      return time !== null && time <= now ? [{ key, time }] : [];
    })
    .sort((a, b) => b.time - a.time);
  const keep = new Set(backups.slice(0, 1).map((item) => item.key));
  for (const tier of ['daily', 'weekly', 'monthly', 'yearly'] as const) {
    const boundary = new Date(bucketStart(now, tier));
    if (tier === 'daily') boundary.setUTCDate(boundary.getUTCDate() - policy[tier] + 1);
    if (tier === 'weekly') boundary.setUTCDate(boundary.getUTCDate() - 7 * (policy[tier] - 1));
    if (tier === 'monthly') boundary.setUTCMonth(boundary.getUTCMonth() - policy[tier] + 1);
    if (tier === 'yearly') boundary.setUTCFullYear(boundary.getUTCFullYear() - policy[tier] + 1);
    const buckets = new Set<number>();
    for (const backup of backups) {
      const bucket = bucketStart(backup.time, tier);
      if (policy[tier] > 0 && bucket >= boundary.getTime() && !buckets.has(bucket)) {
        keep.add(backup.key);
        buckets.add(bucket);
      }
    }
  }
  return backups.filter((item) => !keep.has(item.key)).map((item) => item.key);
}
