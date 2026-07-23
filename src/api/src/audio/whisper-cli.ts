import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { child as childLogger } from '../log.ts';
import { probeCommand } from '../process/probe-command.ts';
import { parseWhisperJson, type TranscriptResult } from './whisper-parse.ts';

const log = childLogger('whisper-cli');
const CANDIDATES = ['/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cli'] as const;
let resolved: string | null = null;
let inflight: Promise<string | null> | null = null;

async function detect(): Promise<string | null> {
  const onPath = Bun.which('whisper-cli');
  for (const candidate of onPath ? [onPath, ...CANDIDATES] : CANDIDATES) {
    if (await probeCommand(candidate, ['--help'])) return candidate;
  }
  return null;
}

export function whisperBinary(): Promise<string | null> {
  if (resolved) return Promise.resolve(resolved);
  inflight ??= detect().then((found) => {
    resolved = found;
    inflight = null;
    return found;
  });
  return inflight;
}

export async function transcribeWav(
  wavPath: string,
  modelPath: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TranscriptResult | null> {
  if (options.signal?.aborted) return null;
  const binary = await whisperBinary();
  if (!binary) return null;
  if (
    !(await fs.stat(wavPath).catch(() => null)) ||
    !(await fs.stat(modelPath).catch(() => null))
  ) {
    return null;
  }
  const outBase = `${wavPath}.${process.pid}.${randomBytes(6).toString('hex')}`;
  const jsonPath = `${outBase}.json`;
  try {
    const proc = Bun.spawn(
      [binary, '-m', modelPath, '-f', wavPath, '-l', 'en', '-oj', '-of', outBase, '-np'],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        proc.kill();
      },
      options.timeoutMs ?? 30 * 60_000,
    );
    const abort = (): void => proc.kill();
    options.signal?.addEventListener('abort', abort, { once: true });
    // The signal may have aborted while we awaited `whisperBinary()`/`fs.stat`
    // above; `addEventListener` on an already-aborted signal never fires, so
    // kill now rather than leave whisper running until its natural exit.
    if (options.signal?.aborted) abort();
    try {
      const stderr = await new Response(proc.stderr).text();
      const code = await proc.exited;
      if (timedOut || options.signal?.aborted || code !== 0) {
        log.warn({ wavPath, code, stderr: stderr.trim().slice(0, 300) }, 'whisper failed');
        return null;
      }
      return parseWhisperJson(await fs.readFile(jsonPath, 'utf8'));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  } catch (error) {
    log.warn({ wavPath, error }, 'whisper transcription threw');
    return null;
  } finally {
    await fs.unlink(jsonPath).catch(() => {});
  }
}
