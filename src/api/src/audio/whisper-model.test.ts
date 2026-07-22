import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_WHISPER_TIER,
  WHISPER_TIERS,
  ensureWhisperModel,
  parseWhisperTier,
  whisperModelDir,
  whisperModelPath,
} from './whisper-model.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))));

describe('whisper models', () => {
  it('validates tiers', () => {
    expect(WHISPER_TIERS).toContain('medium.en');
    expect(parseWhisperTier('small.en')).toBe('small.en');
    expect(parseWhisperTier('invalid')).toBe(DEFAULT_WHISPER_TIER);
    expect(whisperModelPath('medium.en')).toBe(join(whisperModelDir(), 'ggml-medium.en.bin'));
  });

  it('downloads atomically and reuses the cached model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maple-whisper-'));
    dirs.push(dir);
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls++;
      return new Response(new Uint8Array([1, 2, 3]));
    };
    const first = await ensureWhisperModel('base.en', { dir, fetchImpl });
    const second = await ensureWhisperModel('base.en', { dir, fetchImpl });
    expect(first).toBe(second);
    expect((await stat(first!)).size).toBe(3);
    expect(calls).toBe(1);
  });

  it('rejects truncated downloads and cleans the temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maple-whisper-'));
    dirs.push(dir);
    const fetchImpl = async (): Promise<Response> =>
      new Response(new Uint8Array([1, 2]), { headers: { 'content-length': '3' } });
    expect(await ensureWhisperModel('tiny.en', { dir, fetchImpl })).toBeNull();
    await expect(stat(join(dir, 'ggml-tiny.en.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts a stalled download at the configured timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maple-whisper-'));
    dirs.push(dir);
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    expect(await ensureWhisperModel('small.en', { dir, fetchImpl, timeoutMs: 5 })).toBeNull();
  });
});
