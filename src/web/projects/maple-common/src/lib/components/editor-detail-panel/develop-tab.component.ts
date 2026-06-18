// Develop tab — scopes pinned at top, then all 5 slider sections.

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ScopesContainerComponent } from '../scopes/scopes-container.component';
import { DevelopToolbarComponent } from '../develop/develop-toolbar.component';
import { ProfileSectionComponent } from '../develop/profile-section.component';
import { ToneSectionComponent } from '../develop/tone-section.component';
import { WhiteBalanceSectionComponent } from '../develop/white-balance-section.component';
import { PresenceSectionComponent } from '../develop/presence-section.component';
import { SharpeningSectionComponent } from '../develop/sharpening-section.component';
import { CaptureSharpeningSectionComponent } from '../develop/capture-sharpening-section.component';
import { NoiseSectionComponent } from '../develop/noise-section.component';

@Component({
  selector: 'editor-develop-tab',
  standalone: true,
  imports: [
    DevelopToolbarComponent,
    ScopesContainerComponent,
    ProfileSectionComponent,
    ToneSectionComponent,
    WhiteBalanceSectionComponent,
    PresenceSectionComponent,
    SharpeningSectionComponent,
    CaptureSharpeningSectionComponent,
    NoiseSectionComponent,
  ],
  styleUrl: './develop-tab.component.scss',
  templateUrl: './develop-tab.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DevelopTabComponent {}
