import { describe, it, expect } from 'vitest';
import { mirrorRows } from './info-mirrors.vm';
import type { ApiAssetMirrorState } from '../api/bun-api-backend.service';

function mirror(overrides: Partial<ApiAssetMirrorState>): ApiAssetMirrorState {
  return {
    destinationId: 'dest-1',
    destinationName: 'Drive',
    provider: 'google-drive',
    enabled: true,
    path: '2026/photo.jpg',
    state: 'active',
    status: 'synced',
    sequence: 3,
    verifiedSequence: 3,
    attempts: 0,
    retryAt: 0,
    lastError: null,
    ...overrides,
  };
}

describe('mirrorRows', () => {
  it('maps each lifecycle status to one status text', () => {
    const texts = (['synced', 'pending', 'paused', 'error', 'trash', 'purged'] as const).map(
      (status) =>
        mirrorRows([mirror({ status, enabled: status !== 'paused' })])[0]!.statuses.map(
          (s) => `${s.state}:${s.text}`,
        ),
    );
    expect(texts).toEqual([
      ['saved:Synced'],
      ['saving:Pending'],
      ['offline:Paused'],
      ['error:Sync failed'],
      ['idle:In Trash'],
      ['idle:Purged'],
    ]);
  });

  it('shows both paused and the failure when a disabled destination carries an error', () => {
    const [row] = mirrorRows([
      mirror({
        status: 'error',
        enabled: false,
        lastError: 'Google backup object is unavailable.',
      }),
    ]);
    expect(row!.statuses.map((s) => s.text)).toEqual(['Paused', 'Sync failed']);
    expect(row!.lastError).toBe('Google backup object is unavailable.');
  });

  it('keeps a recorded failure visible when a trashed entry outranks it', () => {
    const [row] = mirrorRows([
      mirror({ status: 'trash', state: 'trash', lastError: 'Retry required' }),
    ]);
    expect(row!.statuses.map((s) => s.text)).toEqual(['In Trash', 'Sync failed']);
  });

  it('carries the destination name and mirror path', () => {
    const [row] = mirrorRows([mirror({ destinationName: 'Archive', path: 'a/b.dng' })]);
    expect(row).toMatchObject({ destinationId: 'dest-1', name: 'Archive', path: 'a/b.dng' });
  });
});
