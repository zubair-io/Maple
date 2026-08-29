// MuiAddServerModal — Maple UI Organisms (Wave W6 Lane B). Sign-in/
// registration for a remote Maple Self Hosted server, built from Overlay
// Shell, Form Field, Button, Banner.
//
// The password field rides on Form Field's plain-text control — mui-input
// has no masked/password variant today (only default/search/numeric), so
// this is an unmasked text entry until that variant exists upstream.

import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { MuiBannerComponent } from '../banner/mui-banner.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';
import { MuiOverlayShellComponent } from '../overlay-shell/mui-overlay-shell.component';

export interface MuiAddServerRequest {
  readonly host: string;
  readonly username: string;
  readonly password: string;
}

@Component({
  selector: 'mui-add-server-modal',
  standalone: true,
  imports: [
    MuiBannerComponent,
    MuiButtonComponent,
    MuiFormFieldComponent,
    MuiOverlayShellComponent,
  ],
  templateUrl: './mui-add-server-modal.component.html',
  host: { class: 'contents' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiAddServerModalComponent {
  readonly open = input<boolean>(false);
  readonly host = model<string>('');
  readonly username = model<string>('');
  readonly password = model<string>('');
  readonly connecting = input<boolean>(false);
  readonly error = input<string | null>(null);

  readonly connectRequested = output<MuiAddServerRequest>();
  readonly dismissed = output<void>();

  readonly canConnect = computed(
    () => this.host().trim().length > 0 && this.username().trim().length > 0 && !this.connecting(),
  );

  onConnect(): void {
    if (!this.canConnect()) return;
    this.connectRequested.emit({
      host: this.host(),
      username: this.username(),
      password: this.password(),
    });
  }

  onDismiss(): void {
    this.dismissed.emit();
  }
}
