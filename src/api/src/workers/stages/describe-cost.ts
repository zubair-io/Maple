import {
  BilledOutputError,
  type DescribeResult,
} from '../../enrichment/describe-providers/index.ts';
import type { ImageDoc, StageContext, StageResult } from '../stage-config.ts';

export class DescribeCosts {
  private readonly charges: number[] = [];

  get total(): number {
    return this.charges.reduce((sum, cost) => sum + cost, 0);
  }

  async record(call: Promise<DescribeResult>): Promise<DescribeResult> {
    try {
      const result = await call;
      this.charges.push(result.cost_usd);
      return result;
    } catch (err) {
      if (err instanceof BilledOutputError) this.charges.push(err.cost_usd);
      throw err;
    }
  }
}

export async function withDescribeCosts(
  image: ImageDoc,
  ctx: StageContext,
  handler: (image: ImageDoc, ctx: StageContext, costs: DescribeCosts) => Promise<StageResult>,
): Promise<StageResult> {
  const costs = new DescribeCosts();
  try {
    return await handler(image, ctx, costs);
  } catch (cause) {
    if (costs.total === 0) throw cause;
    const error = new Error(cause instanceof Error ? cause.message : String(cause), { cause });
    error.name = cause instanceof Error ? cause.name : 'Error';
    throw Object.assign(error, {
      cost_usd: costs.total,
      retryable: (cause as { retryable?: unknown } | null)?.retryable !== false,
    });
  }
}
