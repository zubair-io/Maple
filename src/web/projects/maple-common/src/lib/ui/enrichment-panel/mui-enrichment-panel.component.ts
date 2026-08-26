// MuiEnrichmentPanel — Maple UI Organisms (unified-component-catalog.md
// §4.3). AI-derived fields with live status, built from Description Field,
// Faces Row, Place Row, Transcript Block, Vision Row, Badge. No top-level
// loading/empty state of its own — each field molecule already degrades to
// its own placeholder/empty appearance given empty inputs (e.g. an empty
// description falls back to Description Field's own placeholder text), so
// this panel just wires status through to a small badge next to the
// description.
//
// Maple UI migration (#3030, MW3) extension: the real Info panel's
// Self-Hosted enrichment orchestrator (`InfoEnrichmentComponent`) polls
// THREE stages (geocode/describe/face), each carrying a richer 6-state
// status than the original `descriptionStatus` (idle/generating/done/error)
// covered — plus a per-stage error message, a post-requeue "stale" hint,
// and (for place/face) a manual re-run action. `descriptionStageStatus` /
// `placeStatus` / `faceStatus` (all `MuiEnrichmentStageStatus | null`) carry
// that richer state without changing `descriptionStatus`'s existing simple
// contract — a caller that only has the 4-state signal keeps using it, one
// that has the full per-stage lifecycle (this app) uses the *StageStatus
// inputs instead. Only one of the two renders per section: `*StageStatus`
// wins over `descriptionStatus` when both are given.

import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MuiBadgeComponent, type MuiBadgeVariant } from '../badge/mui-badge.component';
import { MuiButtonComponent } from '../button/mui-button.component';
import type { MuiChip } from '../chip-row/mui-chip-row.component';
import { MuiDescriptionFieldComponent } from '../description-field/mui-description-field.component';
import { MuiFacesRowComponent } from '../faces-row/mui-faces-row.component';
import { MuiPlaceRowComponent } from '../place-row/mui-place-row.component';
import { MuiTextComponent } from '../text/mui-text.component';
import { MuiTranscriptBlockComponent } from '../transcript-block/mui-transcript-block.component';
import type { MuiTranscriptEntry } from '../transcript-block/mui-transcript-block.component';
import { MuiVisionRowComponent } from '../vision-row/mui-vision-row.component';

export type MuiEnrichmentDescriptionStatus = 'idle' | 'generating' | 'done' | 'error';

const STATUS_LABEL: Record<Exclude<MuiEnrichmentDescriptionStatus, 'idle'>, string> = {
  generating: 'Generating…',
  done: 'Done',
  error: 'Error',
};

/** Richer per-stage status a worker-backed enrichment pipeline carries:
 * a running job, a stage paused by an operator, a stage that skipped this
 * asset (no GPS, no thumbnail, …), or a hard failure — states a simple
 * idle/generating/done/error signal can't distinguish. `label` is empty for
 * `complete` (no badge needed); `tooltip` surfaces e.g. the raw skip reason
 * or error text. */
export interface MuiEnrichmentStageStatus {
  readonly kind: 'failed' | 'skipped' | 'paused' | 'running' | 'pending' | 'complete';
  readonly label: string;
  readonly tooltip?: string;
}

/** Empty-label statuses render no badge — the shared default so every
 * section can pass a non-null status into {@link toBadgeVm} unconditionally. */
const NO_STAGE_BADGE: MuiEnrichmentStageStatus = { kind: 'complete', label: '' };

/** Resolved shape of a stage's badge — a template `@if`/`@else if` pair
 * (`kind === 'paused'` vs not) reads only `kind`/`label`/`variant`/
 * `tooltip`, all already resolved here, so `<template>` itself carries
 * none of this decision's branching, `?? null` fallbacks, or
 * `status.kind === 'failed' ? … : …` ternary (see {@link toBadgeVm}). The
 * three stages share this ONE shape and the ONE `<ng-template>` that reads
 * it (`stageBadge` in the .html) — called three times via
 * `ngTemplateOutlet`, so the branching it contains is written, and counted,
 * exactly once regardless of how many stages render it. */
type StageBadgeVm =
  | { readonly kind: 'none' }
  | { readonly kind: 'paused'; readonly label: string }
  | {
      readonly kind: 'badge';
      readonly label: string;
      readonly variant: MuiBadgeVariant;
      readonly tooltip: string | null;
    };

/** Same "one shared shape, one shared template" reasoning as
 * {@link StageBadgeVm}, for the error/stale line under each stage's badge. */
interface StageFeedbackVm {
  /** Error text, or `null` when there's nothing to show. */
  readonly error: string | null;
  /** Only consulted when `error` is `null`. */
  readonly stale: boolean;
}

@Component({
  selector: 'mui-enrichment-panel',
  standalone: true,
  imports: [
    MuiBadgeComponent,
    MuiButtonComponent,
    MuiDescriptionFieldComponent,
    MuiFacesRowComponent,
    MuiPlaceRowComponent,
    MuiTextComponent,
    MuiTranscriptBlockComponent,
    MuiVisionRowComponent,
    NgTemplateOutlet,
    RouterLink,
  ],
  templateUrl: './mui-enrichment-panel.component.html',
  styleUrl: './mui-enrichment-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MuiEnrichmentPanelComponent {
  readonly description = model<string>('');
  readonly descriptionStatus = input<MuiEnrichmentDescriptionStatus>('idle');
  /** Full per-stage status for the describe stage — takes precedence over
   * `descriptionStatus` when given. `null` (default) defers to the simple
   * 4-state signal. */
  readonly descriptionStageStatus = input<MuiEnrichmentStageStatus | null>(null);
  readonly descriptionError = input<string | null>(null);
  readonly descriptionStale = input<boolean>(false);

  readonly people = input.required<readonly MuiChip[]>();
  readonly peopleRedetecting = input<boolean>(false);
  /** Total detected-face count, tagged + untagged. `null` (default) falls
   * back to Faces Row's own "N people" label derived from `people().length`
   * (tagged only). Set when the caller also tracks untagged faces. */
  readonly facesTotalCount = input<number | null>(null);
  readonly facesUntaggedCount = input<number>(0);
  readonly faceStatus = input<MuiEnrichmentStageStatus | null>(null);
  readonly faceError = input<string | null>(null);
  readonly faceStale = input<boolean>(false);

  readonly place = model<string>('');
  readonly placeOverridden = input<boolean>(false);
  readonly placeStatus = input<MuiEnrichmentStageStatus | null>(null);
  readonly placeError = input<string | null>(null);
  readonly placeStale = input<boolean>(false);
  /** Hides the whole place section — the real app hides it once the
   * geocode worker ran and found nothing for this asset (see
   * `showPlaceSection()` in `enrichment.vm.ts`). */
  readonly showPlace = input<boolean>(true);

  readonly transcriptBase = input<Date | number | null>(null);
  readonly transcriptEntries = input<readonly MuiTranscriptEntry[]>([]);
  readonly visionLabels = input.required<readonly MuiChip[]>();
  /** Hides the built-in vision chip row — set `false` when the caller
   * renders its own richer, sectioned vision display instead (structured
   * classification data doesn't fit this row's flat single-list shape). */
  readonly showVision = input<boolean>(true);

  /** Deep link for a "paused" stage badge — the workers admin page.
   * Required, with no built-in default: the real route
   * (`/settings/workers`) is a Self-Hosted-only capability, and a literal
   * default baked into this shared mui-ui component would leak into the
   * Hosted bundle the moment any Hosted surface (including this design
   * system's own showcase) renders `<mui-enrichment-panel>` — the Hosted/
   * Self-Hosted capability boundary (`check-hosted-capability-boundary.mjs`)
   * gates on exactly that string appearing in a Hosted chunk. Callers pass
   * their own href — Self Hosted's `InfoEnrichmentComponent` passes
   * `WORKERS_SETTINGS_URL` from `enrichment.vm.ts`; the showcase passes a
   * placeholder. */
  readonly workersSettingsHref = input.required<string>();

  readonly selectedPersonId = model<string | null>(null);

  readonly descriptionRegenerate = output<void>();
  readonly descriptionCommitted = output<string>();
  readonly peopleRedetect = output<void>();
  /** Click on the trailing "+N unnamed" pill — the caller decides what
   * that means (e.g. navigate to the people settings page). */
  readonly facesUntaggedClicked = output<void>();
  readonly placeCommitted = output<string>();
  readonly placeCleared = output<void>();
  readonly placeRequeue = output<void>();

  readonly descriptionStatusLabel = computed(() => {
    const status = this.descriptionStatus();
    return status === 'idle' ? '' : STATUS_LABEL[status];
  });

  /** `descriptionStageStatus()` when the caller has it, else the simple
   * 4-state `descriptionStatus` re-expressed in the richer shape — folds
   * the "which status source wins" branch into a computed instead of an
   * `@if`/`@else if` pair in the template. `kind` here is only ever read
   * for the paused-link check and the badge-variant choice, so any
   * non-`'paused'`/`'failed'` value is a safe stand-in for "not part of the
   * richer per-stage protocol". */
  private readonly effectiveDescriptionStatus = computed<MuiEnrichmentStageStatus>(() => {
    const stage = this.descriptionStageStatus();
    if (stage) return stage;
    const label = this.descriptionStatusLabel();
    if (!label) return NO_STAGE_BADGE;
    return { kind: this.descriptionStatus() === 'error' ? 'failed' : 'running', label };
  });

  /** `MuiEnrichmentStageStatus` → the shared `stageBadge` `<ng-template>`'s
   * {@link StageBadgeVm} — every field the template reads (label, badge
   * variant, tooltip-or-null) is resolved here, so `<template>` itself
   * carries none of this decision's branching or `?? null` fallbacks. */
  private toBadgeVm(status: MuiEnrichmentStageStatus): StageBadgeVm {
    if (!status.label) return { kind: 'none' };
    if (status.kind === 'paused') return { kind: 'paused', label: status.label };
    return {
      kind: 'badge',
      label: status.label,
      variant: status.kind === 'failed' ? 'signal' : 'count',
      tooltip: status.tooltip ?? null,
    };
  }

  /** Description stage's badge/feedback — the molecule stays inline in the
   * template (each stage's molecule is a distinct component, not a
   * data-driven choice), but everything the SHARED `stageBadge`/
   * `stageFeedback` `<ng-template>`s need is resolved here. */
  protected readonly descriptionBadge = computed(() =>
    this.toBadgeVm(this.effectiveDescriptionStatus()),
  );
  protected readonly descriptionFeedback = computed<StageFeedbackVm>(() => ({
    error: this.descriptionError(),
    stale: this.descriptionStale(),
  }));

  protected readonly facesBadge = computed(() =>
    this.toBadgeVm(this.faceStatus() ?? NO_STAGE_BADGE),
  );
  protected readonly facesFeedback = computed<StageFeedbackVm>(() => ({
    error: this.faceError(),
    stale: this.faceStale(),
  }));

  protected readonly placeBadge = computed(() =>
    this.toBadgeVm(this.placeStatus() ?? NO_STAGE_BADGE),
  );
  protected readonly placeFeedback = computed<StageFeedbackVm>(() => ({
    error: this.placeError(),
    stale: this.placeStale(),
  }));

  /** `transcriptBase()` gated on `transcriptEntries()` being non-empty, in
   * one computed rather than the template's `@if (a && b; as x)` — same
   * "keep template complexity down" reasoning as `stageRows`. */
  protected readonly visibleTranscriptBase = computed<Date | number | null>(() =>
    this.transcriptEntries().length > 0 ? this.transcriptBase() : null,
  );
}
