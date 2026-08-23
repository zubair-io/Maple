import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiBannerComponent,
  MuiChipRowComponent,
  MuiColorWheelComponent,
  MuiDragBarComponent,
  MuiEmptyStateComponent,
  MuiFormFieldComponent,
  MuiFrameTimeHudComponent,
  MuiInlineRenameFieldComponent,
  MuiListRowComponent,
  MuiLivingSliderComponent,
  MuiPad2dComponent,
  MuiRatingFlagsComponent,
  MuiSearchBarComponent,
  MuiSliderComponent,
  MuiTabsComponent,
  MuiToastContainerComponent,
  MuiTreeRowComponent,
  MuiValueChipComponent,
  MuiValueHudComponent,
} from '@maple-common';
import type {
  MuiChip,
  MuiColorWheelValue,
  MuiPad2dValue,
  MuiTab,
  MuiToastEntry,
} from '@maple-common';

// Molecules L1 (form, selection, feedback) specimens — Wave 3 Lane A
// (#3000). Every card renders the real `mui-*` molecule, composed from the
// wave 1/2 atoms, instead of the static Canvas.dc.html mockup markup this
// tier shipped with — so this page can never drift from the shipped
// implementation. Specimens are backed by local component state so drags,
// clicks, and keyboard operation are all real, not decorative.
@Component({
  selector: 'app-tier-molecules1-form',
  imports: [
    MuiBannerComponent,
    MuiChipRowComponent,
    MuiColorWheelComponent,
    MuiDragBarComponent,
    MuiEmptyStateComponent,
    MuiFormFieldComponent,
    MuiFrameTimeHudComponent,
    MuiInlineRenameFieldComponent,
    MuiListRowComponent,
    MuiLivingSliderComponent,
    MuiPad2dComponent,
    MuiRatingFlagsComponent,
    MuiSearchBarComponent,
    MuiSliderComponent,
    MuiTabsComponent,
    MuiToastContainerComponent,
    MuiTreeRowComponent,
    MuiValueChipComponent,
    MuiValueHudComponent,
  ],
  templateUrl: './tier-molecules1-form.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierMolecules1FormComponent {
  // --- 2.1 Form & entry ---
  filenameValue = 'test_0003.NEF';
  filenameError: string | null = null;
  renameValue = 'test_0003';
  searchValue = '';
  sliderValue = 0.3;
  warmthValue = 0.6;
  readonly warmthGradient = 'linear-gradient(90deg, #3b82f6, #f5f2eb, #f59e0b)';
  straightenValue = 8;
  colorWheelValue: MuiColorWheelValue = { hue: 205, saturation: 45 };
  padValue: MuiPad2dValue = { x: 0.35, y: -0.2 };

  // --- 2.2 Selection ---
  readonly filterChips: readonly MuiChip[] = [
    { id: 'all', label: 'All' },
    { id: 'photos', label: 'Photos' },
    { id: 'videos', label: 'Videos' },
  ];
  filterSelected: string | null = 'all';
  readonly toolTabs: readonly MuiTab[] = [
    { id: 'light', label: 'Light' },
    { id: 'color', label: 'Color' },
    { id: 'detail', label: 'Detail' },
  ];
  activeTab = 'light';
  notebooksExpanded = true;
  ratingValue = 3;
  ratingFlag: 'none' | 'pick' | 'reject' = 'reject';
  // Fixed reference instant — a live `Date.now()` in the template would make
  // this specimen silently drift as the page stays open (same rationale as
  // TierAtomsComponent's timestamp fixtures).
  readonly meetingNotesTimestamp = Date.now() - 2 * 60_000;

  // --- 2.3 Feedback & messaging ---
  readonly toastEntries: readonly MuiToastEntry[] = [
    { id: 'saved', variant: 'success', message: 'Saved', autoDismissMs: null },
    { id: 'syncing', variant: 'info', message: 'Syncing…', autoDismissMs: null },
  ];
}
