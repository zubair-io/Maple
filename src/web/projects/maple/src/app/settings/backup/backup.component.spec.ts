import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import {
  AuthService,
  BunApiBackendService,
  CloudBackupService,
  type ApiFolder,
  type BackupDestination,
} from '@maple-common';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupComponent } from './backup.component';

const library: ApiFolder = {
  id: 'library',
  path: '/Photos',
  label: 'Photos',
  last_scan: null,
  file_count: 5,
  created_at: '2026-10-04',
};
const destination: BackupDestination = {
  id: 'destination',
  libraryId: 'library',
  kind: 'folder',
  name: 'Archive',
  enabled: true,
  generation: 1,
  path: '/Archive/Photos',
  rootId: null,
  accountId: null,
  status: {
    pending: 0,
    verified: 5,
    trash: 1,
    purgePending: 0,
    blocked: 0,
    bytes: 500,
    lastError: null,
  },
};
describe('BackupComponent', () => {
  let fixture: ComponentFixture<BackupComponent>;
  const user = signal({ role: 'owner' });
  const listFolders = vi.fn(() => of([library]));
  const api = {
    destinations: vi.fn(),
    createDestination: vi.fn(),
    updateDestination: vi.fn(),
    retryDestination: vi.fn(),
    removeDestination: vi.fn(),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    user.set({ role: 'owner' });
    api.destinations.mockReturnValue(of([destination]));
    api.createDestination.mockReturnValue(of(destination));
    api.updateDestination.mockReturnValue(of(destination));
    await TestBed.configureTestingModule({
      imports: [BackupComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { queryParamMap: convertToParamMap({}) } },
        },
        { provide: AuthService, useValue: { user } },
        { provide: BunApiBackendService, useValue: { listFolders } },
        { provide: CloudBackupService, useValue: api },
      ],
    }).compileComponents();
    fixture = null!;
  });
  async function settle(): Promise<void> {
    if (!fixture) fixture = TestBed.createComponent(BackupComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }
  const el = (): HTMLElement => fixture.nativeElement;
  function button(label: string): HTMLButtonElement {
    const result = Array.from(el().querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === label,
    );
    if (!result) throw new Error(`missing button ${label}`);
    return result;
  }
  it('loads destinations immediately when owner authentication arrives', async () => {
    user.set({ role: 'pending' });
    await settle();
    expect(api.destinations).not.toHaveBeenCalled();
    user.set({ role: 'owner' });
    await settle();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(api.destinations).toHaveBeenCalledTimes(1);
    expect(el().textContent).toContain('Archive');
  });
  it('refreshes destination status without loading the library list again', async () => {
    await settle();
    const component = fixture.componentInstance as unknown as { refresh(): void };
    component.refresh();
    await settle();
    expect(api.destinations).toHaveBeenCalledTimes(2);
    expect(listFolders).toHaveBeenCalledTimes(1);
  });
  it('preserves folder mirror capabilities and real destination status', async () => {
    await settle();
    expect(el().textContent).toContain('Verified: 5');
    expect(el().textContent).toContain('physical Trash and read failover');
    expect(el().textContent).toContain('/Archive/Photos');
  });
  it('creates a selected folder destination with the existing registered library', async () => {
    await settle();
    const component = fixture.componentInstance as unknown as {
      library: { set(v: string): void };
      path: { set(v: string): void };
    };
    component.library.set('library');
    component.path.set(' /Archive/Photos ');
    fixture.detectChanges();
    button('Add destination').click();
    await settle();
    expect(api.createDestination).toHaveBeenCalledWith({
      libraryId: 'library',
      kind: 'folder',
      name: 'Folder mirror',
      path: '/Archive/Photos',
    });
  });
  it('keeps removal unavailable while a permanent purge obligation is pending', async () => {
    api.destinations.mockReturnValue(
      of([{ ...destination, status: { ...destination.status, purgePending: 1 } }]),
    );
    await settle();
    expect(button('Remove destination').disabled).toBe(true);
    expect(api.removeDestination).not.toHaveBeenCalled();
  });
  it('shows indexed gaps and interrupted moves and explains untracked erasure on removal', async () => {
    api.destinations.mockReturnValue(
      of([{ ...destination, status: { ...destination.status, missing: 7, prepared: 2 } }]),
    );
    await settle();
    expect(el().textContent).toContain('Missing indexed locations: 7');
    expect(el().textContent).toContain('Interrupted local moves: 2');
    button('Remove destination').click();
    fixture.detectChanges();
    expect(el().textContent).toContain('no longer track future permanent deletion');
    expect(api.removeDestination).not.toHaveBeenCalled();
  });
  it('displays OAuth callback errors as text and removes the query value from browser history', async () => {
    const route = TestBed.inject(ActivatedRoute) as unknown as {
      snapshot: { queryParamMap: ReturnType<typeof convertToParamMap> };
    };
    route.snapshot.queryParamMap = convertToParamMap({ googleError: 'Reconnect Google.' });
    const priorUrl = window.location.href;
    window.history.replaceState(window.history.state, '', '?googleError=Reconnect%20Google.');
    try {
      await settle();
      expect(el().textContent).toContain('Reconnect Google.');
      expect(new URL(window.location.href).searchParams.has('googleError')).toBe(false);
    } finally {
      window.history.replaceState(window.history.state, '', priorUrl);
    }
  });
  it('does not query or show owner backup controls to a non-owner', async () => {
    user.set({ role: 'member' });
    await settle();
    expect(el().textContent).toContain('Only the server owner');
    expect(api.destinations).not.toHaveBeenCalled();
    expect(el().querySelector('#backup-folder')).toBeNull();
  });
});
