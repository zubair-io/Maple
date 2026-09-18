import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LEGAL_PAGE_HOST_CLASS } from '../legal-page.styles';

// Public Terms of Service page for Maple Hosted (maple-editor.com/terms).
// Linked from the App Store Connect submission (Agreements, Tax, and
// Banking / App Information) and from the Privacy page's footer.
@Component({
  selector: 'app-terms',
  imports: [RouterLink],
  templateUrl: './terms.component.html',
  host: { class: LEGAL_PAGE_HOST_CLASS },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TermsComponent {
  readonly effectiveDate = 'September 18, 2026';
}
