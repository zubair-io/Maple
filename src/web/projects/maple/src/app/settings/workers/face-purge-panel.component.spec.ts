import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { API_BASE_URL, type SubthresholdFaceAuditResponse } from '@maple-common';
import { FacePurgePanelComponent } from './face-purge-panel.component';

const AUDIT_URL = '/api/admin/faces/purge-subthreshold';

const auditBody: SubthresholdFaceAuditResponse = {
  threshold: 0.06,
  mode: 'dry-run',
  assetsScanned: 12,
  assetsAffected: 4,
  subThresholdFaces: { unassigned: 5, assigned: 2, hidden: 1, total: 8 },
  policy: { removesUnassigned: false, removesAssigned: false, preservesHidden: true },
  affectedPeople: [{ personId: 'a1', subThresholdFaces: 2 }],
};

describe('FacePurgePanelComponent', () => {
  let fixture: ComponentFixture<FacePurgePanelComponent>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FacePurgePanelComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(FacePurgePanelComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const click = (testid: string): void =>
    el().querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();

  async function audit(): Promise<void> {
    click('face-purge-audit');
    const req = http.expectOne(AUDIT_URL);
    expect(req.request.method).toBe('POST');
    req.flush(auditBody);
    await tick();
    fixture.detectChanges();
  }

  it('renders the breakdown counts after an audit', async () => {
    await audit();
    const report = el().querySelector('[data-testid="face-purge-report"]');
    expect(report).not.toBeNull();
    expect(el().querySelector('[data-testid="face-purge-total"]')?.textContent).toContain('8');
    expect(el().querySelector('[data-testid="face-purge-unassigned"]')?.textContent).toContain('5');
    expect(el().querySelector('[data-testid="face-purge-assigned"]')?.textContent).toContain('2');
    expect(el().querySelector('[data-testid="face-purge-hidden"]')?.textContent).toContain('1');
    expect(el().querySelector('[data-testid="face-purge-people"]')?.textContent).toContain('1');
  });

  it('Apply is disabled before an audit and enabled once removable faces exist', async () => {
    // No audit yet → no apply button rendered at all.
    expect(el().querySelector('[data-testid="face-purge-apply"]')).toBeNull();
    await audit();
    const apply = el().querySelector<HTMLButtonElement>('[data-testid="face-purge-apply"]');
    expect(apply).not.toBeNull();
    expect(apply!.disabled).toBe(false);
  });

  it('apply (default) sends includeAssigned=false and posts apply=true', async () => {
    await audit();
    // Auto-confirm the dialog.
    const orig = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      click('face-purge-apply');
      const req = http.expectOne(`${AUDIT_URL}?apply=true`);
      expect(req.request.method).toBe('POST');
      req.flush({
        ...auditBody,
        mode: 'apply:unassigned-only',
        applied: {
          facesRemoved: 5,
          assetsUpdated: 4,
          personCountsRecomputed: 0,
          personRecomputes: [],
        },
      });
      await tick();
      // The success path re-runs the audit.
      http.expectOne(AUDIT_URL).flush(auditBody);
      await tick();
      fixture.detectChanges();
      expect(el().querySelector('[data-testid="face-purge-success"]')?.textContent).toContain('5');
    } finally {
      globalThis.confirm = orig;
    }
  });

  it('checking "also remove assigned" sends includeAssigned=true', async () => {
    await audit();
    const checkbox = el().querySelector<HTMLInputElement>(
      '[data-testid="face-purge-include-assigned"]',
    )!;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const orig = globalThis.confirm;
    globalThis.confirm = () => true;
    try {
      click('face-purge-apply');
      const req = http.expectOne(`${AUDIT_URL}?apply=true&includeAssigned=true`);
      expect(req.request.method).toBe('POST');
      req.flush({
        ...auditBody,
        mode: 'apply:all',
        applied: {
          facesRemoved: 7,
          assetsUpdated: 4,
          personCountsRecomputed: 1,
          personRecomputes: [{ personId: 'a1', newCount: 0 }],
        },
      });
      await tick();
      http.expectOne(AUDIT_URL).flush(auditBody);
      await tick();
      fixture.detectChanges();
    } finally {
      globalThis.confirm = orig;
    }
  });

  it('cancelling the confirm dialog sends no apply request', async () => {
    await audit();
    const orig = globalThis.confirm;
    globalThis.confirm = () => false;
    try {
      click('face-purge-apply');
      // No HTTP request should be issued — http.verify() in afterEach asserts none outstanding.
      http.expectNone(`${AUDIT_URL}?apply=true`);
    } finally {
      globalThis.confirm = orig;
    }
  });

  it('surfaces a server error (e.g. 400 threshold-off)', async () => {
    click('face-purge-audit');
    http
      .expectOne(AUDIT_URL)
      .flush({ error: 'face_min_detection_size is 0' }, { status: 400, statusText: 'Bad Request' });
    await tick();
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="face-purge-error"]')).not.toBeNull();
  });
});
