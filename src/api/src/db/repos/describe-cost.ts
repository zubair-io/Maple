import type { SqlStatement } from '../sqlite/protocol.ts';

export function describeFailureCostStatements(
  assetId: string,
  stage: string,
  err: unknown,
): SqlStatement[] {
  const column =
    stage === 'describe'
      ? 'description_meta'
      : stage === 'video-describe'
        ? 'video_description_meta'
        : null;
  const cost = (err as { cost_usd?: unknown } | null)?.cost_usd;
  if (column === null || typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) return [];
  return [
    {
      sql: `INSERT INTO asset_detail (asset_id, ${column})
      SELECT id, json_object('cost_usd', ?) FROM assets WHERE id = ?
      ON CONFLICT (asset_id) DO UPDATE SET ${column} =
        json_set(COALESCE(asset_detail.${column}, '{}'), '$.cost_usd',
          COALESCE(json_extract(asset_detail.${column}, '$.cost_usd'), 0) + ?)`,
      params: [cost, assetId, cost],
    },
  ];
}
