import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { API_BASE_URL } from '@maple-common';
import { DbBackupComponent } from './db-backup.component';

const settings = {
  policy: {
    enabled: false,
    bucket: 'private-backups',
    hour: 3,
    daily: 7,
    weekly: 4,
    monthly: 12,
    yearly: 5,
  },
  status: null,
  last_success_at: null,
  running: false,
};

describe('Database backup settings', () => {
  let fixture: ComponentFixture<DbBackupComponent>;
  let http: HttpTestingController;
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DbBackupComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: API_BASE_URL, useValue: '/api' },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DbBackupComponent);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    http.expectOne('/api/admin/backup/db').flush(settings);
    fixture.detectChanges();
  });
  afterEach(() => {
    fixture.destroy();
    http.verify();
  });
  function click(label: string) {
    const buttons = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    buttons.find((button) => button.textContent?.trim() === label)!.click();
    fixture.detectChanges();
  }
  it('saves edited retention through the owner API', () => {
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '#db-backup-daily',
    )!;
    input.value = '14';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    click('Save backup settings');
    const request = http.expectOne('/api/admin/backup/db/config');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body.daily).toBe(14);
    request.flush({ ...settings, policy: { ...settings.policy, daily: 14 } });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Backup settings saved');
  });
  it('starts a backup and disables another start until status refreshes', () => {
    click('Back up now');
    const request = http.expectOne('/api/admin/backup/db');
    expect(request.request.method).toBe('POST');
    request.flush({ accepted: true });
    fixture.detectChanges();
    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((button) => button.textContent?.trim() === 'Back up now')!;
    expect(button.disabled).toBe(true);
  });
  it('shows server failures', () => {
    click('Back up now');
    http
      .expectOne('/api/admin/backup/db')
      .flush({ error: 'Missing R2 credentials' }, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Missing R2 credentials');
  });
});
