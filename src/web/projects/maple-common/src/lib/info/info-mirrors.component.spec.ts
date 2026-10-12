import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';

import { InfoMirrorsComponent } from './info-mirrors.component';
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
    sequence: 1,
    verifiedSequence: 1,
    attempts: 0,
    retryAt: 0,
    lastError: null,
    ...overrides,
  };
}

function render(mirrors: readonly ApiAssetMirrorState[]): HTMLElement {
  const fixture = TestBed.createComponent(InfoMirrorsComponent);
  fixture.componentRef.setInput('mirrors', mirrors);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('InfoMirrorsComponent', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [InfoMirrorsComponent] });
  });

  it('renders nothing when the asset has no mirrors', () => {
    expect(render([]).querySelector('.mirror-row')).toBeNull();
  });

  it('lists each destination with its state and path', () => {
    const el = render([
      mirror({ destinationId: 'a', destinationName: 'Drive' }),
      mirror({ destinationId: 'b', destinationName: 'NAS', status: 'pending' }),
    ]);
    const rows = Array.from(el.querySelectorAll('.mirror-row'));
    const texts = rows.map((row) =>
      Array.from(row.querySelectorAll('mui-text, mui-status-text')).map((node) =>
        node.textContent?.trim(),
      ),
    );
    expect(texts).toEqual([
      ['Drive', 'Synced', '2026/photo.jpg'],
      ['NAS', 'Pending', '2026/photo.jpg'],
    ]);
  });

  it('shows paused and the failure together, with the error message beneath', () => {
    const el = render([
      mirror({
        status: 'error',
        enabled: false,
        lastError: 'Google backup object is unavailable.',
      }),
    ]);
    const statuses = Array.from(el.querySelectorAll('mui-status-text')).map((node) =>
      node.textContent?.trim(),
    );
    expect(statuses).toEqual(['Paused', 'Sync failed']);
    expect(el.querySelector('.mirror-error')?.textContent?.trim()).toBe(
      'Google backup object is unavailable.',
    );
  });
});
