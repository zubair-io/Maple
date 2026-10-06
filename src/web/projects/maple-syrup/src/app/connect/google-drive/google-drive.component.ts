import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MuiButtonComponent, MuiInputComponent } from '@maple-common';
import { catchError, map, of } from 'rxjs';
import { takeConnectionFragment } from '../connection-fragment';
import { ConnectionService, validatedAuthorizationUrl } from '../connection.service';

@Component({
  selector: 'app-google-drive-connect',
  imports: [AsyncPipe, MuiButtonComponent, MuiInputComponent],
  templateUrl: './google-drive.component.html',
  styleUrl: './google-drive.component.scss',
  host: { class: 'block min-h-screen bg-bg text-text-main overflow-auto' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoogleDriveComponent {
  private readonly fragment = takeConnectionFragment();
  private readonly connection = inject(ConnectionService);
  readonly callback = signal(this.fragment?.callback ?? '');
  readonly vm$ = this.fragment
    ? this.connection.validate(this.fragment.ticket).pipe(
        map((ticket) => {
          const authorizationUrl = validatedAuthorizationUrl(this.fragment!, ticket);
          if (this.fragment?.callback && this.matchesCallback(ticket.returnUrl))
            this.continue(authorizationUrl);
          return { ticket, authorizationUrl, error: '' };
        }),
        catchError(() =>
          of({
            ticket: null,
            authorizationUrl: '',
            error:
              'This connection is invalid or expired. Start Connect Google Drive again from your Maple server.',
          }),
        ),
      )
    : of({ ticket: null, authorizationUrl: '', error: '' });
  matchesCallback(expected: string): boolean {
    try {
      return new URL(this.callback().trim()).href === expected;
    } catch {
      return false;
    }
  }
  continue(url: string): void {
    window.location.assign(url);
  }
}
