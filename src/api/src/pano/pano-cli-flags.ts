/**
 * Which optional `maple-cli pano stitch` flags the configured binary accepts,
 * read once per path from its `--help`. A binary without a flag degrades the
 * feature it backs (no strategy picker, no preview) instead of failing a job.
 */

import path from 'node:path';
import { child as childLogger } from '../log.ts';

const log = childLogger('pano:cli-flags');

export interface PanoCliFlags {
  /** `--strategy` (#1226). */
  strategy: boolean;
  /** `--preview-out` / `--alignment-in` / `--alignment-out` (#4578). */
  preview: boolean;
}

const NO_FLAGS: PanoCliFlags = { strategy: false, preview: false };

let cached: { cliPath: string; flags: PanoCliFlags } | null = null;

export function invalidatePanoCliFlags(): void {
  cached = null;
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

async function readFlags(cliPath: string): Promise<PanoCliFlags> {
  if (cliPath.startsWith('-') || !path.isAbsolute(cliPath)) {
    log.warn({ cliPath }, 'pano: refusing to probe non-absolute or hyphen-prefixed cliPath');
    return NO_FLAGS;
  }
  return readHelp(cliPath)
    .then((help) => ({
      strategy: help.includes('--strategy'),
      preview: help.includes('--preview-out') && help.includes('--alignment-in'),
    }))
    .catch(() => NO_FLAGS);
}

export async function probePanoCliFlags(cliPath: string): Promise<PanoCliFlags> {
  if (cached?.cliPath === cliPath) return cached.flags;
  const flags = await readFlags(cliPath);
  cached = { cliPath, flags };
  return flags;
}
