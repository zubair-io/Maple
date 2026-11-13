import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { API_BASE_URL, AuthService, type TemporalSettings } from '@maple-common';
import { TemporalSettingsComponent } from './temporal-settings.component';
import { REPORT_POLL_MS, STEADY_POLL_MS } from './temporal-settings.vm';

const URL = '/api/workers/temporal';

const connected: TemporalSettings = {
  address: '127.0.0.1:7233',
  namespace: 'default',
  connection: { state: 'connected', error: null, checkedAt: 1_780_000_000_000 },
};

const unreachable: TemporalSettings = {
  ...connected,
  connection: {
    state: 'unreachable',
    error: 'connect ECONNREFUSED 127.0.0.1:7233',
    checkedAt: 1_780_000_000_000,
  },
};

const pending = (address: string, namespace: string): TemporalSettings => ({
  address,
  namespace,
  connection: { state: 'unknown', error: null, checkedAt: null },
});

describe('TemporalSettingsComponent', () => {
  let fixture: ComponentFixture<TemporalSettingsComponent>;
  let http: HttpTestingController;
  const user = signal<{ role: 'owner' | 'member' } | null>({ role: 'owner' });

  beforeEach(async () => {
    vi.useFakeTimers();
    user.set({ role: 'owner' });
    await TestBed.configureTestingModule({
      imports: [TemporalSettingsComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
        { provide: AuthService, useValue: { user } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(TemporalSettingsComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    http.verify();
    vi.useRealTimers();
  });

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (testId: string): string =>
    el().querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '';
  const field = (testId: string): HTMLInputElement =>
    el().querySelector(`[data-testid="${testId}"] input`) as HTMLInputElement;
  const saveButton = (): HTMLButtonElement | null =>
    el().querySelector('[data-testid="temporal-save"] button');

  const answerRead = (payload: TemporalSettings): void => {
    http.expectOne({ method: 'GET', url: URL }).flush(payload);
    fixture.detectChanges();
  };

  const expandRow = (latest: TemporalSettings): void => {
    (el().querySelector('.header') as HTMLElement).click();
    fixture.detectChanges();
    answerRead(latest);
  };

  const type = (testId: string, value: string): void => {
    const input = field(testId);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  const pressSave = (): void => {
    saveButton()?.click();
    fixture.detectChanges();
  };

  const wait = (ms: number): void => {
    vi.advanceTimersByTime(ms);
    fixture.detectChanges();
  };

  it('shows the connection state and target while collapsed, and the fields on expand', () => {
    answerRead(connected);

    expect(text('temporal-status')).toBe('Connected');
    expect(text('temporal-summary')).toBe('127.0.0.1:7233 · default');
    expect(el().querySelector('.content-wrapper')?.className).not.toContain('open');

    expandRow(connected);
    expect(el().querySelector('.content-wrapper')?.className).toContain('open');
    expect(field('temporal-address').value).toBe('127.0.0.1:7233');
    expect(field('temporal-namespace').value).toBe('default');
    expect(text('temporal-connection')).toContain('Connected');
  });

  it('opening the row re-reads the state straight away', () => {
    answerRead(unreachable);
    expect(text('temporal-status')).toBe('Unreachable');

    expandRow(connected);
    expect(text('temporal-status')).toBe('Connected');
  });

  it('shows why the server is unreachable', () => {
    answerRead(unreachable);

    expect(text('temporal-status')).toBe('Unreachable');
    expect(text('temporal-summary')).toBe('connect ECONNREFUSED 127.0.0.1:7233');

    expandRow(unreachable);
    expect(text('temporal-connection-detail')).toBe('connect ECONNREFUSED 127.0.0.1:7233');
  });

  it('a connected card notices the server going down, and coming back, without being touched', () => {
    answerRead(connected);
    expect(text('temporal-status')).toBe('Connected');

    wait(STEADY_POLL_MS - 1);
    http.expectNone(URL);
    wait(1);
    answerRead(unreachable);
    expect(text('temporal-status')).toBe('Unreachable');

    wait(STEADY_POLL_MS);
    answerRead(connected);
    expect(text('temporal-status')).toBe('Connected');
  });

  it('a re-read that fails keeps the last state on screen and tries again', () => {
    answerRead(connected);

    wait(STEADY_POLL_MS);
    http
      .expectOne({ method: 'GET', url: URL })
      .flush(null, { status: 502, statusText: 'Bad Gateway' });
    fixture.detectChanges();
    expect(text('temporal-status')).toBe('Connected');
    expect(el().querySelector('[data-testid="temporal-error"]')).toBeNull();

    wait(STEADY_POLL_MS);
    answerRead(unreachable);
    expect(text('temporal-status')).toBe('Unreachable');
  });

  it('saves the trimmed fields, re-reads quickly until the worker reports, then keeps watching', () => {
    answerRead(connected);
    expandRow(connected);

    type('temporal-address', '  temporal:7233 ');
    type('temporal-namespace', 'maple');
    pressSave();

    const put = http.expectOne({ method: 'PUT', url: URL });
    expect(put.request.body).toEqual({ address: 'temporal:7233', namespace: 'maple' });
    put.flush(pending('temporal:7233', 'maple'));
    fixture.detectChanges();

    expect(text('temporal-status')).toBe('Connecting');
    expect(el().textContent).toContain('Saved.');
    http.expectNone(URL);

    wait(REPORT_POLL_MS);
    answerRead(pending('temporal:7233', 'maple'));
    expect(text('temporal-status')).toBe('Connecting');

    wait(REPORT_POLL_MS);
    answerRead({ ...connected, address: 'temporal:7233', namespace: 'maple' });
    expect(text('temporal-status')).toBe('Connected');
    expect(text('temporal-summary')).toBe('temporal:7233 · maple');

    wait(REPORT_POLL_MS);
    http.expectNone(URL);
    wait(STEADY_POLL_MS - REPORT_POLL_MS);
    answerRead({ ...unreachable, address: 'temporal:7233', namespace: 'maple' });
    expect(text('temporal-status')).toBe('Unreachable');
  });

  it('text typed while a save is in flight survives the save', () => {
    answerRead(connected);
    expandRow(connected);

    type('temporal-address', 'temporal:7233');
    pressSave();
    const put = http.expectOne({ method: 'PUT', url: URL });

    type('temporal-address', 'temporal:7234');
    put.flush({ ...connected, address: 'temporal:7233' });
    fixture.detectChanges();

    expect(put.request.body).toEqual({ address: 'temporal:7233', namespace: 'default' });
    expect(field('temporal-address').value).toBe('temporal:7234');
    expect(text('temporal-summary')).toBe('temporal:7233 · default');
    expect(el().textContent).not.toContain('Saved.');

    type('temporal-address', 'temporal:7233');
    expect(el().textContent).toContain('Saved.');
  });

  it('a poll that is still in flight when a save starts cannot overwrite the saved state', () => {
    answerRead(pending('127.0.0.1:7233', 'default'));
    expandRow(pending('127.0.0.1:7233', 'default'));

    wait(REPORT_POLL_MS);
    const stalePoll = http.expectOne({ method: 'GET', url: URL });

    type('temporal-address', 'temporal:7233');
    pressSave();
    expect(stalePoll.cancelled).toBe(true);

    http.expectOne({ method: 'PUT', url: URL }).flush({ ...connected, address: 'temporal:7233' });
    fixture.detectChanges();
    expect(text('temporal-status')).toBe('Connected');
    expect(text('temporal-summary')).toBe('temporal:7233 · default');
  });

  it('polling does not overwrite an edit in progress', () => {
    answerRead(connected);
    expandRow(connected);

    type('temporal-address', 'temporal:72');
    wait(STEADY_POLL_MS);
    answerRead({ ...unreachable, address: 'elsewhere:7233' });

    expect(text('temporal-status')).toBe('Unreachable');
    expect(field('temporal-address').value).toBe('temporal:72');
  });

  it('a rejected save shows the server message, keeps what was typed, and keeps watching', () => {
    answerRead(connected);
    expandRow(connected);

    type('temporal-address', 'not an address');
    pressSave();
    http
      .expectOne({ method: 'PUT', url: URL })
      .flush({ error: 'address must be host:port' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();

    expect(text('temporal-error')).toBe('address must be host:port');
    expect(field('temporal-address').value).toBe('not an address');
    expect(text('temporal-status')).toBe('Connected');
    expect(el().textContent).not.toContain('Saved.');
    expect(saveButton()?.disabled).toBe(false);

    wait(STEADY_POLL_MS);
    answerRead(unreachable);
    expect(text('temporal-status')).toBe('Unreachable');
    expect(text('temporal-error')).toBe('address must be host:port');
  });

  it('cannot save with a blank address or namespace', () => {
    answerRead(connected);
    expandRow(connected);

    type('temporal-namespace', '   ');
    expect(saveButton()?.disabled).toBe(true);

    pressSave();
    http.expectNone({ method: 'PUT', url: URL });
  });

  it('a member sees the settings read-only with no Save, and still gets the live state', () => {
    user.set({ role: 'member' });
    answerRead(connected);
    expandRow(connected);

    expect(field('temporal-address').value).toBe('127.0.0.1:7233');
    expect(field('temporal-address').readOnly).toBe(true);
    expect(field('temporal-namespace').readOnly).toBe(true);
    expect(saveButton()).toBeNull();
    expect(text('temporal-owner-only')).toContain('Only the server owner');

    wait(STEADY_POLL_MS);
    answerRead(unreachable);
    expect(text('temporal-status')).toBe('Unreachable');
  });

  it('an owner gets editable fields and Save', () => {
    answerRead(connected);
    expandRow(connected);

    expect(field('temporal-address').readOnly).toBe(false);
    expect(saveButton()).not.toBeNull();
    expect(el().querySelector('[data-testid="temporal-owner-only"]')).toBeNull();
  });

  it('shows the server refusal if the role check fails anyway', () => {
    answerRead(connected);
    expandRow(connected);

    type('temporal-address', 'temporal:7233');
    pressSave();
    http
      .expectOne({ method: 'PUT', url: URL })
      .flush({ error: 'owner role required' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();

    expect(text('temporal-error')).toBe('owner role required');
    expect(text('temporal-summary')).toBe('127.0.0.1:7233 · default');
  });

  it('reports a failed first read instead of an empty form', () => {
    http
      .expectOne({ method: 'GET', url: URL })
      .flush({ error: 'forbidden' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();

    expect(text('temporal-status')).toBe('Not loaded');
    expect(text('temporal-error')).toBe('forbidden');
    expect(el().querySelector('[data-testid="temporal-address"]')).toBeNull();
  });

  it('stops re-reading when the card is destroyed', () => {
    answerRead(connected);
    fixture.destroy();

    vi.advanceTimersByTime(STEADY_POLL_MS * 5);
    http.expectNone(URL);
  });
});
