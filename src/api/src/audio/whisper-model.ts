import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { child as childLogger } from '../log.ts';

const log = childLogger('whisper-model');
const MODEL_DOWNLOAD_TIMEOUT_MS = 60 * 60_000;
export const WHISPER_TIERS = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3'] as const;
export type WhisperTier = (typeof WHISPER_TIERS)[number];
export const DEFAULT_WHISPER_TIER: WhisperTier = 'medium.en';

export function parseWhisperTier(raw: string | null | undefined): WhisperTier {
  return WHISPER_TIERS.includes(raw as WhisperTier) ? (raw as WhisperTier) : DEFAULT_WHISPER_TIER;
}

export function whisperModelDir(): string {
  return join(process.env.MAPLE_MODEL_DIR ?? join(homedir(), '.maple', 'models'), 'whisper');
}

export function whisperModelPath(tier: WhisperTier, dir = whisperModelDir()): string {
  return join(dir, `ggml-${tier}.bin`);
}

export async function ensureWhisperModel(
  tier: WhisperTier,
  deps: {
    dir?: string;
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  const dir = deps.dir ?? whisperModelDir();
  const destination = whisperModelPath(tier, dir);
  const existing = await fs.stat(destination).catch(() => null);
  if (existing && existing.size > 0) return destination;
  await fs.mkdir(dir, { recursive: true });
  const temporary = `${destination}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  const controller = new AbortController();
  const abort = (): void => controller.abort(deps.signal?.reason);
  deps.signal?.addEventListener('abort', abort, { once: true });
  // If the signal aborted while we awaited the stat/mkdir above,
  // `addEventListener` won't fire on the already-aborted signal — propagate it
  // to the fetch controller now so the download never starts.
  if (deps.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error('model download timed out')),
    deps.timeoutMs ?? MODEL_DOWNLOAD_TIMEOUT_MS,
  );
  try {
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${tier}.bin`;
    const response = await (deps.fetchImpl ?? fetch)(url, { signal: controller.signal });
    if (!response.ok || !response.body) return null;
    const expectedBytes = Number(response.headers.get('content-length'));
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary));
    const downloadedBytes = (await fs.stat(temporary)).size;
    if (
      downloadedBytes === 0 ||
      (Number.isFinite(expectedBytes) && expectedBytes > 0 && downloadedBytes !== expectedBytes)
    ) {
      log.warn({ tier, expectedBytes, downloadedBytes }, 'whisper model download was truncated');
      return null;
    }
    await fs.rename(temporary, destination);
    return destination;
  } catch (error) {
    log.warn({ tier, error }, 'whisper model download failed');
    return null;
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', abort);
    await fs.unlink(temporary).catch(() => {});
  }
}
