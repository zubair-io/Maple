import { DefaultLogger, Runtime } from '@temporalio/worker';
import { child as childLogger } from '../log.ts';

const log = childLogger('temporal-sdk');

/**
 * Process-wide SDK setup, once, before the first connection. Signal handling is
 * switched off because the worker tier already owns SIGTERM and drains
 * everything in its own order.
 */
export function installTemporalRuntime(): void {
  Runtime.install({
    logger: new DefaultLogger('WARN', ({ level, message, meta }) => {
      if (level === 'ERROR') log.error(meta ?? {}, message);
      else log.warn(meta ?? {}, message);
    }),
    shutdownSignals: [],
  });
}
