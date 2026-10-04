import { AsyncPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MuiButtonComponent } from '@maple-common';
import { catchError, map, of } from 'rxjs';
import { takeConnectionFragment } from '../connection-fragment';
import { callbackDestination, ConnectionService } from '../connection.service';

@Component({
  selector: 'app-google-drive-return',
  imports: [AsyncPipe, MuiButtonComponent],
  templateUrl: './google-drive-return.component.html',
  styleUrl: './google-drive-return.component.scss',
  host: { class: 'block min-h-screen bg-bg text-text-main overflow-auto' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoogleDriveReturnComponent {
  private readonly fragment = takeConnectionFragment();
  private readonly connection = inject(ConnectionService);
  readonly vm$ = this.fragment
    ? this.connection.validate(this.fragment.ticket).pipe(
        map((ticket) => ({
          returnUrl: ticket.returnUrl,
          destination: callbackDestination(this.fragment!, ticket),
          denied: !!this.fragment!.error,
          error: '',
        })),
        catchError(() =>
          of({
            returnUrl: '',
            destination: '',
            denied: false,
            error:
              'This connection is invalid or expired. Start Connect Google Drive again from your Maple server.',
          }),
        ),
      )
    : of({
        returnUrl: '',
        destination: '',
        denied: false,
        error: 'No connection to return. Start Connect Google Drive from your Maple server.',
      });
  returnToMaple(url: string): void {
    window.location.replace(url);
  }
}
