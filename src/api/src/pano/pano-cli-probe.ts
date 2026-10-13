/**
 * Which optional `maple-cli pano stitch` flags the configured binary accepts,
 * read from its `--help`. Cached per path + mtime, so rebuilding the binary in
 * place is picked up on the next request without a restart. A binary without a
 * flag degrades the feature it backs (no strategy picker, no preview, ML-only
 * matching) instead of failing a job.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import { child as childLogger } from '../log.ts';

const log = childLogger('pano:cli-probe');

export interface PanoCliCapabilities {
  /** `--strategy` (#1226). */
  strategy: boolean;
  /** `--features-engine` (#4523). A binary without it is ML-only. */
  featuresEngine: boolean;
  /** `--preview-out` / `--alignment-in` / `--alignment-out` (#4578). */
  preview: boolean;
}

const NO_CAPABILITIES: PanoCliCapabilities = {
  strategy: false,
  featuresEngine: false,
  preview: false,
};

let cached: { key: string; capabilities: PanoCliCapabilities } | null = null;

export function invalidatePanoCliProbe(): void {
  cached = null;
}

async function cacheKey(cliPath: string): Promise<string> {
  const mtime = await stat(cliPath)
    .then((s) => s.mtimeMs)
    .catch(() => -1);
  return `${cliPath}\0${mtime}`;
}

// clap prints help to stdout or stderr depending on version, so both are read;
// matching the exact flag token avoids a hit on prose that merely says "strategy".
async function readHelp(cliPath: string): Promise<string> {
  const proc = Bun.spawn([cliPath, 'pano', 'stitch', '--help'], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return `${out}\n${err}`;
}

export async function probePanoCli(cliPath: string): Promise<PanoCliCapabilities> {
  if (cliPath.startsWith('-') || !path.isAbsolute(cliPath)) {
    log.warn({ cliPath }, 'pano: refusing to probe non-absolute or hyphen-prefixed cliPath');
    return NO_CAPABILITIES;
  }
  const key = await cacheKey(cliPath);
  if (cached?.key === key) return cached.capabilities;
  const capabilities = await readHelp(cliPath)
    .then((help) => ({
      strategy: help.includes('--strategy'),
      featuresEngine: help.includes('--features-engine'),
      preview: help.includes('--preview-out') && help.includes('--alignment-in'),
    }))
    .catch(() => NO_CAPABILITIES);
  cached = { key, capabilities };
  return capabilities;
}
