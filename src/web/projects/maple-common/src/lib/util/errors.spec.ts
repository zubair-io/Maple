import { describe, it, expect } from 'vitest';

import { errorMessage } from './errors';

describe('errorMessage', () => {
  it('reads the inner Bun-shaped `{ error: { error: "…" } }` payload', () => {
    expect(errorMessage({ error: { error: 'boom' } })).toBe('boom');
  });

  it('reads a string `.error` field', () => {
    expect(errorMessage({ error: 'plain' })).toBe('plain');
  });

  it('reads Error.message', () => {
    expect(errorMessage(new Error('nope'))).toBe('nope');
  });

  it('falls back to String(err) for unknown shapes', () => {
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage('raw string')).toBe('raw string');
  });
});
