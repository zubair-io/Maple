// RestorablePeopleComponent — unit tests for the /settings/people/hidden
// and /settings/people/excluded recovery list views.

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { signal } from '@angular/core';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  API_BASE_URL,
  AuthService,
  type AuthUser,
  BunApiBackendService,
  type ApiPerson,
  FilesystemBrowseService,
  PeopleStore,
} from '@maple-common';
import { RestorablePeopleComponent } from './restorable-people.component';

function person(id: string, name: string, faceCount = 2): ApiPerson {
  return {
    id,
    name,
    faceCount,
    coverAssetId: null,
    coverAbsPath: null,
    coverBbox: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    hasMergeSuggestion: false,
  };
}

class ApiStub {
  hiddenResult: ApiPerson[] = [];
  excludedResult: ApiPerson[] = [];
  listPeople = vi.fn(() => of([]));
  listHiddenPeople = vi.fn(() => of(this.hiddenResult));
  listExcludedPeople = vi.fn(() => of(this.excludedResult));
  unhidePerson = vi.fn((_id: string) => of({ ok: true as const }));
  unexcludePerson = vi.fn((_id: string) => of({ ok: true as const }));
  getPerson = vi.fn((_id: string) => of({} as any));
}

describe('RestorablePeopleComponent', () => {
  let fixture: ComponentFixture<RestorablePeopleComponent>;
  let component: RestorablePeopleComponent;
  let api: ApiStub;
  let routeData$: BehaviorSubject<{ kind?: 'hidden' | 'excluded' }>;

  const owner: AuthUser = { id: 'u1', email: 'owner@maple.local', role: 'owner' };

  async function setup(kind: 'hidden' | 'excluded' = 'hidden'): Promise<void> {
    TestBed.resetTestingModule();
    api = new ApiStub();
    routeData$ = new BehaviorSubject<{ kind?: 'hidden' | 'excluded' }>({ kind });

    await TestBed.configureTestingModule({
      imports: [RestorablePeopleComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_BASE_URL, useValue: '/api' },
        {
          provide: AuthService,
          useValue: {
            user: signal<AuthUser | null>(owner),
          },
        },
        { provide: BunApiBackendService, useValue: api },
        {
          provide: FilesystemBrowseService,
          useValue: {
            getThumbBlobUrl: vi.fn().mockResolvedValue('blob:test'),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {
            data: routeData$.asObservable(),
            snapshot: { data: { kind } },
          },
        },
        PeopleStore,
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RestorablePeopleComponent);
    component = fixture.componentInstance;
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  describe('when kind is hidden', () => {
    it('renders the Hidden people heading and description', async () => {
      await setup('hidden');
      fixture.detectChanges();

      const heading = el().querySelector('h1');
      expect(heading?.textContent?.trim()).toBe('Hidden people');
      expect(api.listHiddenPeople).toHaveBeenCalled();
      expect(api.listExcludedPeople).not.toHaveBeenCalled();
    });

    it('shows empty card when no hidden people exist', async () => {
      await setup('hidden');
      fixture.detectChanges();

      const emptyCard = el().querySelector('.empty-card');
      expect(emptyCard).not.toBeNull();
      expect(emptyCard?.querySelector('h3')?.textContent?.trim()).toBe('No hidden people.');
      expect(emptyCard?.textContent).toContain('When you hide someone');
    });

    it('renders people cards when hidden people exist', async () => {
      await setup('hidden');
      api.hiddenResult = [person('h1', 'Hugo Strange', 5), person('h2', 'Harley', 1)];
      // Re-trigger fetch with data
      TestBed.inject(PeopleStore).invalidateHidden();
      fixture.detectChanges();

      expect(component.hasPeople()).toBe(true);
      const viewport = el().querySelector('cdk-virtual-scroll-viewport');
      expect(viewport).not.toBeNull();
      expect(viewport?.classList.contains('people-viewport')).toBe(true);
      expect(viewport?.classList.contains('flex-1')).toBe(true);
    });

    it('calls store.unhidePerson when clicking Restore', async () => {
      await setup('hidden');
      const testPerson = person('h1', 'Hugo Strange', 3);
      api.hiddenResult = [testPerson];
      TestBed.inject(PeopleStore).invalidateHidden();
      fixture.detectChanges();

      await component.restore(testPerson);
      expect(api.unhidePerson).toHaveBeenCalledWith('h1');
      fixture.detectChanges();

      const toast = el().querySelector('.toast');
      expect(toast?.textContent?.trim()).toBe('Restored Hugo Strange');
    });
  });

  describe('when kind is excluded', () => {
    it('renders the Excluded people heading and description', async () => {
      await setup('excluded');
      fixture.detectChanges();

      const heading = el().querySelector('h1');
      expect(heading?.textContent?.trim()).toBe('Excluded people');
      expect(api.listExcludedPeople).toHaveBeenCalled();
      expect(api.listHiddenPeople).not.toHaveBeenCalled();
    });

    it('shows empty card when no excluded people exist', async () => {
      await setup('excluded');
      fixture.detectChanges();

      const emptyCard = el().querySelector('.empty-card');
      expect(emptyCard).not.toBeNull();
      expect(emptyCard?.querySelector('h3')?.textContent?.trim()).toBe('No excluded people.');
      expect(emptyCard?.textContent).toContain('When you exclude someone');
    });

    it('renders people cards when excluded people exist', async () => {
      await setup('excluded');
      api.excludedResult = [person('e1', 'Excluded Ed', 4)];
      TestBed.inject(PeopleStore).invalidateExcluded();
      fixture.detectChanges();

      expect(component.hasPeople()).toBe(true);
      const viewport = el().querySelector('cdk-virtual-scroll-viewport');
      expect(viewport).not.toBeNull();
    });

    it('calls store.unexcludePerson when clicking Restore', async () => {
      await setup('excluded');
      const testPerson = person('e1', 'Excluded Ed', 4);
      api.excludedResult = [testPerson];
      TestBed.inject(PeopleStore).invalidateExcluded();
      fixture.detectChanges();

      await component.restore(testPerson);
      expect(api.unexcludePerson).toHaveBeenCalledWith('e1');
      fixture.detectChanges();

      const toast = el().querySelector('.toast');
      expect(toast?.textContent?.trim()).toBe('Restored Excluded Ed');
    });
  });

  describe('route data switching', () => {
    it('updates kind and copy reactively when route data changes', async () => {
      await setup('hidden');
      fixture.detectChanges();

      expect(component.kind()).toBe('hidden');
      expect(el().querySelector('h1')?.textContent?.trim()).toBe('Hidden people');

      routeData$.next({ kind: 'excluded' });
      fixture.detectChanges();

      expect(component.kind()).toBe('excluded');
      expect(el().querySelector('h1')?.textContent?.trim()).toBe('Excluded people');
      expect(api.listExcludedPeople).toHaveBeenCalled();
    });
  });

  describe('host bindings', () => {
    it('has set-vars and set-page-host on host element', async () => {
      await setup('hidden');
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      expect(host.classList.contains('set-vars')).toBe(true);
      expect(host.classList.contains('set-page-host')).toBe(true);
      expect(host.classList.contains('w-full')).toBe(true);
    });
  });
});
