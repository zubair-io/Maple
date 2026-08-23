// MuiEndpointForm — Maple UI Molecules-L2 (unified-component-catalog.md
// §3). Interactive request builder, built from Form Field, Button, Badge.

import { ChangeDetectionStrategy, Component, input, model, output } from '@angular/core';
import { MuiBadgeComponent } from '../badge/mui-badge.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import { MuiFormFieldComponent } from '../form-field/mui-form-field.component';

export interface MuiEndpointRequest {
  readonly method: string;
  readonly url: string;
}

@Component({
  selector: 'mui-endpoint-form',
  standalone: true,
  imports: [MuiBadgeComponent, MuiButtonComponent, MuiFormFieldComponent],
  templateUrl: './mui-endpoint-form.component.html',
  styleUrl: './mui-endpoint-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiEndpointFormComponent {
  readonly methods = input<readonly string[]>(['GET', 'POST', 'PUT', 'DELETE']);
  readonly method = model<string>('GET');
  readonly url = model<string>('');
  readonly sending = input<boolean>(false);

  readonly send = output<MuiEndpointRequest>();

  selectMethod(method: string): void {
    this.method.set(method);
  }

  onSend(): void {
    this.send.emit({ method: this.method(), url: this.url() });
  }
}
