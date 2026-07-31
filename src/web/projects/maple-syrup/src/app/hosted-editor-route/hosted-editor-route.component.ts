import { ChangeDetectionStrategy, Component } from '@angular/core';
import { EditorShellComponent, SingleFileSaveNoticeComponent } from '@maple-common';

@Component({
  selector: 'maple-syrup-editor-route',
  standalone: true,
  imports: [EditorShellComponent, SingleFileSaveNoticeComponent],
  templateUrl: './hosted-editor-route.component.html',
  styleUrl: './hosted-editor-route.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HostedEditorRouteComponent {}
