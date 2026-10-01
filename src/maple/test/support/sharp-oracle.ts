import { createRequire } from 'node:module';

const oracleRequire = createRequire(import.meta.url);

/** Test-only libvips oracle; CI must never accept missing cross-decoder coverage. */
export function loadSharpOracle() {
  const resolved = (() => {
    try {
      return oracleRequire.resolve('sharp');
    } catch (cause) {
      const message = 'Sharp oracle unavailable. Run bun install in src/maple.';
      if (process.env.MAPLE_ORACLE_REQUIRED === '1') {
        throw new Error(message, { cause });
      }
      console.warn(`${message} Cross-decoder tests will skip.`);
      return null;
    }
  })();
  // Loading is outside the optional-resolution catch: a broken installed oracle
  // (including a missing libvips binary) is always a failure, even locally.
  return resolved === null ? null : oracleRequire(resolved);
}

export interface SharpCompositeImage {
  composite(layers: Record<string, unknown>[]): SharpCompositeImage;
  raw(): SharpCompositeImage;
  toBuffer(): Promise<Buffer>;
}

export type SharpCompositeFactory = (
  input: Buffer,
  options: { raw: { width: number; height: number; channels: 3 | 4 } },
) => SharpCompositeImage;
