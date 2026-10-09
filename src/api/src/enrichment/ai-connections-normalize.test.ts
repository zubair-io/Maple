import { describe, expect, it } from 'bun:test';
import {
  embedderSaveOutcome,
  normalizeAssignments,
  normalizeConnections,
  probeApiKey,
  probeFailureStatus,
} from './ai-connections-normalize.ts';

const saved = [
  { id: 'a', name: 'A', provider: 'openai', url: '', concurrency: 1, api_key: 'old-key' },
] as const;

describe('normalizeConnections', () => {
  it('trims fields and keeps the saved key when none is sent', () => {
    const [c] = normalizeConnections(
      [{ id: 'a', name: ' A ', provider: 'openai', url: ' http://x/// ', concurrency: 1 }],
      saved,
    );
    expect(c).toMatchObject({ name: 'A', url: 'http://x', api_key: 'old-key' });
  });

  it('clears or replaces a key that is sent', () => {
    const base = { id: 'a', name: 'A', provider: 'openai', url: '', concurrency: 1 } as const;
    const [cleared, replaced] = normalizeConnections(
      [
        { ...base, api_key: ' ' },
        { ...base, api_key: ' new ' },
      ],
      saved,
    );
    expect(cleared!.api_key).toBeNull();
    expect(replaced!.api_key).toBe('new');
  });
});

describe('normalizeAssignments', () => {
  it('trims models and restricts per-connection models to the selected connections', () => {
    const result = normalizeAssignments({
      w: {
        connection_ids: ['a'],
        model: ' m ',
        connection_models: { a: ' x ', gone: 'y' },
      },
      v: { connection_ids: ['a'], model: 'n' },
    });
    expect(result['w']).toEqual({
      connection_ids: ['a'],
      model: 'm',
      connection_models: { a: 'x' },
    });
    expect(result['v']).toEqual({ connection_ids: ['a'], model: 'n' });
  });
});

describe('embedderSaveOutcome', () => {
  it('saves nothing when omitted, reports a bad URL, and clears blanks', () => {
    expect(embedderSaveOutcome(undefined)).toEqual({});
    expect(embedderSaveOutcome({ url: 'ftp://x', model: null })).toHaveProperty('error');
    expect(embedderSaveOutcome({ url: '', model: ' ' })).toEqual({
      embedder_url: null,
      embedder_model: null,
    });
  });
});

describe('probeApiKey', () => {
  it('uses a sent key, else the saved key of the same connection', () => {
    const base = { id: 'a', provider: 'openai' };
    expect(probeApiKey({ ...base, api_key: 'sent' }, saved)).toBe('sent');
    expect(probeApiKey({ ...base, api_key: null }, saved)).toBeNull();
    expect(probeApiKey(base, saved)).toBe('old-key');
    expect(probeApiKey({ id: 'a', provider: 'gemini' }, saved)).toBeUndefined();
  });
});

describe('probeFailureStatus', () => {
  it('is 200 on success and the reported status, defaulting to 400, on failure', () => {
    expect(probeFailureStatus({ ok: true, status: 204 })).toBe(200);
    expect(probeFailureStatus({ ok: false, status: 502 })).toBe(502);
    expect(probeFailureStatus({ ok: false })).toBe(400);
  });
});
