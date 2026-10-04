import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ConnectionService } from '../connection.service';
import { captureConnectionFragment } from '../connection-fragment';
import { GoogleDriveReturnComponent } from './google-drive-return.component';

describe('GoogleDriveReturnComponent', () => {
  it('requires a new connection after losing the in-memory callback', async () => {
    captureConnectionFragment(
      { pathname: '/connect/google-drive/return', hash: '', search: '' },
      { replaceState: () => {} },
    );
    const validate = vi.fn(() => of(null));
    await TestBed.configureTestingModule({
      imports: [GoogleDriveReturnComponent],
      providers: [{ provide: ConnectionService, useValue: { validate } }],
    }).compileComponents();
    const fixture = TestBed.createComponent(GoogleDriveReturnComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No connection to return');
    expect(fixture.nativeElement.querySelector('mui-button')).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });
});

it('shows the bound destination and labeled explicit return without exposing a code in markup', async () => {
  captureConnectionFragment(
    {
      pathname: '/connect/google-drive/return',
      hash:
        '#' +
        btoa(JSON.stringify({ ticket: 'signed.ticket', code: 'synthetic-code' })).replace(/=/g, ''),
      search: '',
    },
    { replaceState: () => {} },
  );
  const ticket = { returnUrl: 'https://photos.lan:3443/api/cloud-backup/google/callback' };
  await TestBed.configureTestingModule({
    imports: [GoogleDriveReturnComponent],
    providers: [{ provide: ConnectionService, useValue: { validate: () => of(ticket) } }],
  }).compileComponents();
  const fixture = TestBed.createComponent(GoogleDriveReturnComponent);
  fixture.detectChanges();
  const text = fixture.nativeElement.textContent;
  expect(text).toContain(ticket.returnUrl);
  expect(text).not.toContain('synthetic-code');
  expect(fixture.nativeElement.querySelector('button').textContent).toContain(
    'Return to my Maple server',
  );
  expect(fixture.nativeElement.querySelector('a')).toBeNull();
});
