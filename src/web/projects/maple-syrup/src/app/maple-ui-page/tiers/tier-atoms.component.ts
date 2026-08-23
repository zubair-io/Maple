import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  MuiActionButtonComponent,
  MuiAvatarComponent,
  MuiBadgeComponent,
  MuiButtonComponent,
  MuiCanvasSurfaceComponent,
  MuiCheckboxComponent,
  MuiDividerComponent,
  MuiIconComponent,
  MuiImageComponent,
  MuiInputComponent,
  MuiLinkComponent,
  MuiListComponent,
  MuiProgressComponent,
  MuiQrCodeComponent,
  MuiRemoteImageComponent,
  MuiSegmentedToggleComponent,
  MuiSpinnerComponent,
  MuiStatComponent,
  MuiStatusTextComponent,
  MuiTextComponent,
  MuiTimestampComponent,
  MuiToastComponent,
} from '@maple-common';
import type { MuiListItem, MuiSegmentedToggleOption } from '@maple-common';

// Atom-tier specimens ported verbatim from the Unified Component Catalog
// canvas (Canvas.dc.html, claude.ai/design project 288a7180) — except every
// atom now renders the real `mui-*` component instead of static mockup
// markup, so this page can never drift from the shipped implementation.
// Wave 1 covered Actions + Content (Button, Action Button, Icon, Link, Text,
// Timestamp, Badge, Stat, Divider, List); wave 2 (#3000) covers Form/Media/
// Feedback (Input, Checkbox, Segmented Toggle, Image, Remote Image, Avatar,
// QR Code, Canvas Surface, Progress, Spinner, Status Text, Toast).
@Component({
  selector: 'app-tier-atoms',
  imports: [
    MuiButtonComponent,
    MuiActionButtonComponent,
    MuiIconComponent,
    MuiLinkComponent,
    MuiTextComponent,
    MuiTimestampComponent,
    MuiBadgeComponent,
    MuiStatComponent,
    MuiDividerComponent,
    MuiListComponent,
    MuiInputComponent,
    MuiCheckboxComponent,
    MuiSegmentedToggleComponent,
    MuiImageComponent,
    MuiRemoteImageComponent,
    MuiAvatarComponent,
    MuiQrCodeComponent,
    MuiCanvasSurfaceComponent,
    MuiProgressComponent,
    MuiSpinnerComponent,
    MuiStatusTextComponent,
    MuiToastComponent,
  ],
  templateUrl: './tier-atoms.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TierAtomsComponent {
  // Fixed reference instant for the Timestamp specimen — a live `Date.now()`
  // would make the "2m ago" card silently drift as the page stays open.
  readonly timestampNow = new Date();
  readonly timestampRecent = new Date(this.timestampNow.getTime() - 2 * 60_000);
  readonly timestampOlder = new Date(this.timestampNow.getTime() - 3 * 24 * 60 * 60_000);

  readonly listItems: readonly MuiListItem[] = [{ text: 'First item' }, { text: 'Second item' }];

  // --- Wave 2 specimen fixtures ---

  readonly viewModeOptions: readonly MuiSegmentedToggleOption[] = [
    { value: 'grid', label: 'Grid' },
    { value: 'list', label: 'List' },
  ];
  viewMode = 'grid';

  // Small inline SVG data URIs — no network dependency, so the showcase
  // renders identically offline and in CI. Each tier gets a visibly
  // different fill so the Remote Image blur-up transition is legible even
  // as a static specimen.
  readonly specimenPhoto =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'>" +
    "<rect width='80' height='80' fill='%23c4493a'/>" +
    "<circle cx='40' cy='32' r='14' fill='%23422016'/>" +
    "<rect x='16' y='52' width='48' height='20' rx='8' fill='%23422016'/></svg>";
  readonly specimenPhotoBroken = 'data:image/does-not-exist';
  readonly remoteImageTiers = {
    thumb:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'>" +
      "<rect width='16' height='16' fill='%23c4493a'/></svg>",
    preview:
      "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'>" +
      "<rect width='48' height='48' fill='%23c4493a'/><circle cx='24' cy='24' r='10' fill='%23e7e5e4'/></svg>",
    full: this.specimenPhoto,
  };

  onCanvasSurfaceReady(canvas: HTMLCanvasElement): void {
    // Proves the surface is a live, drawable canvas — paints a simple
    // gradient rather than shipping a static screenshot.
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = 160;
    canvas.height = 90;
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, '#c4493a');
    gradient.addColorStop(1, '#422016');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}
