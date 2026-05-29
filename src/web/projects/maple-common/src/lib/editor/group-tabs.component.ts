// group-tabs.component.ts — responsive-program S5a (#625).
//
// 4-tab segmented row (Light · Color · Effects · Detail). Selected tab
// gets a `primary` 600-weight label + 1.5pt accent underline. Tap routes
// through `EditorStateService.armGroup`.

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { EditorStateService } from './editor-state.service';
import { TOOL_GROUP_DISPLAY, type ToolGroup } from './tool-model';

@Component({
  selector: 'app-group-tabs',
  standalone: true,
  templateUrl: './group-tabs.component.html',
  styleUrl: './group-tabs.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupTabsComponent {
  protected readonly state = inject(EditorStateService);
  protected readonly groups: readonly ToolGroup[] = ['light', 'color', 'effects', 'detail'];
  protected readonly displayName = TOOL_GROUP_DISPLAY;

  protected select(g: ToolGroup): void {
    this.state.armGroup(g);
    this.state.haptic('switch');
  }
}
