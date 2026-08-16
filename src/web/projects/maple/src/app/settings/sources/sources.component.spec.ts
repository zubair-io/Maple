// SourcesComponent (#2892) — list rendering with connection status, the
// pre-upgrade-server fallback (missing `connected` = connected), the
// fresh re-check, and the empty state.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  API_BASE_URL,
  BunApiBackendService,
  LIBRARY_BACKEND,
  provideSelfHostedWorkspace,
  type ApiFolder,
} from '@maple-common';
import { SourcesComponent } from './sources.component';

const FOLDERS: ApiFolder[] = [
  {
    id: 'f1',
    slug: 'photos',
    path: '/mnt/photos',
    label: 'Photos',
    last_scan: '2026-08-01T10:00:00Z',
    file_count: 1200,
    created_at: '2026-01-01T00:00:00Z',
    connected: true,
  },
  {
    id: 'f2',
    slug: 'nas',
    path: '/mnt/nas-archive',
    label: 'NAS archive',
    last_scan: null,
    file_count: 9000,
    created_at: '2026-02-01T00:00:00Z',
    connected: false,
  },
];

describe('SourcesComponent', () => {
  let fixture: ComponentFixture<SourcesComponent>;
  let listFolders: ReturnType<typeof vi.fn>;

  async function setup(folders: ApiFolder[]): Promise<void> {
    listFolders = vi.fn((_opts?: { fresh?: boolean }) => of(folders));
    await TestBed.configureTestingModule({
      imports: [SourcesComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideSelfHostedWorkspace(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: LIBRARY_BACKEND, useValue: 'self-hosted' },
        { provide: BunApiBackendService, useValue: { listFolders } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SourcesComponent);
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  it('renders one row per source with its connection status', async () => {
    await setup(FOLDERS);

    const rows = el().querySelectorAll('.source-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Photos');
    expect(rows[0].textContent).toContain('Connected');
    expect(rows[1].textContent).toContain('NAS archive');
    expect(rows[1].textContent).toContain('Not connected');
    expect(rows[1].classList.contains('offline')).toBe(true);

    // Disconnected sources get the explanatory hint.
    expect(el().querySelector('[data-testid="disconnected-hint"]')?.textContent).toContain(
      'hidden from the sidebar',
    );
  });

  it('treats a missing `connected` field (pre-upgrade server) as connected', async () => {
    const legacy = FOLDERS.map(({ connected: _connected, ...rest }) => rest as ApiFolder);
    await setup(legacy);

    expect(el().querySelectorAll('.source-row.offline')).toHaveLength(0);
    expect(el().querySelector('[data-testid="disconnected-hint"]')).toBeNull();
  });

  it('re-checks with fresh=true when "Check again" is clicked', async () => {
    await setup(FOLDERS);
    expect(listFolders).toHaveBeenCalledWith({ fresh: false });

    el().querySelector<HTMLButtonElement>('.btn-ghost')!.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(listFolders).toHaveBeenCalledWith({ fresh: true });
  });

  it('shows the empty state when no sources are registered', async () => {
    await setup([]);

    expect(el().querySelector('.source-row')).toBeNull();
    expect(el().textContent).toContain('No sources yet.');
  });
});
