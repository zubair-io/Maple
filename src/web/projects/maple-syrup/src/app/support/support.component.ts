import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LEGAL_PAGE_HOST_CLASS } from '../legal/legal-page.styles';

@Component({
  selector: 'app-support',
  imports: [RouterLink],
  templateUrl: './support.component.html',
  styleUrl: './support.component.scss',
  host: { class: LEGAL_PAGE_HOST_CLASS },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupportComponent {}
