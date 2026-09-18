import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LEGAL_PAGE_HOST_CLASS } from '../legal-page.styles';

// Public Privacy Policy page for Maple Hosted (maple-editor.com/privacy).
// Linked from the App Store Connect App Privacy section and from the Terms
// page's footer.
@Component({
  selector: 'app-privacy',
  imports: [RouterLink],
  templateUrl: './privacy.component.html',
  host: { class: LEGAL_PAGE_HOST_CLASS },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyComponent {
  readonly effectiveDate = 'September 18, 2026';
}
