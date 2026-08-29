// InfoVisionComponent — Self-Hosted enrichment "Vision" section.
//
// Read-only structured visual classification emitted by the describe
// stage (screenshot/people-count badges, subjects,
// scene/setting/activity/shot-type chips, mood/framing/time/lighting/
// weather secondary row, notable objects, search keywords, colors, OCR
// text). Prompt v5's screenshot short-circuit nulls
// scene_type/shot_type/framing/time_of_day/lighting/weather on
// screenshots, so every one of those chips is gated on a populated
// value in the template. `tags`, `people_count`, and `framing` are all
// absent on rows the prompt-v7 re-describe hasn't reached yet, so the
// template guards each one rather than assuming the current shape. No edit / requeue UI: the describe-stage
// requeue already lives on the Description section directly above.
//
// Maple UI migration (#3030, MW3): each flat group of chips (subjects;
// scene/setting/activity/shot-type; mood/framing/time/lighting/weather;
// notable objects; keywords; colors) now renders through `<mui-vision-row>`
// — kept as an app-level composition rather than a fork of
// `MuiEnrichmentPanelComponent`'s single `visionLabels` row, because this
// asset schema has SIX independent, separately-labelled groups where the
// design-system molecule's contract is deliberately one flat row (see that
// component's header comment). The screenshot / people-count badges use
// `mui-badge`; group labels and the provenance footer use `mui-text`. The
// OCR text block stays a raw `<pre>` — no mui atom fits a preformatted text
// passthrough any better than the element itself.

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MuiCollapsibleComponent } from '../ui/collapsible/mui-collapsible.component';
import { MuiBadgeComponent } from '../ui/badge/mui-badge.component';
import { MuiTextComponent } from '../ui/text/mui-text.component';
import { MuiVisionRowComponent } from '../ui/vision-row/mui-vision-row.component';
import type { MuiChip } from '../ui/chip-row/mui-chip-row.component';
import type { ApiAssetDetail } from '../api/bun-api-backend.service';

/** `id` doubles as `label` — every value here is a short classification
 * term with no separate identifier of its own, same as the retired
 * `KeywordChipsRowComponent`/`taggedFaces` pattern elsewhere in this
 * migration. */
function toChips(values: readonly (string | null | undefined)[]): MuiChip[] {
  return values.filter((v): v is string => !!v).map((v) => ({ id: v, label: v }));
}

/** One flat group of vision chips — a labelled section (Subjects, Notable
 * objects, Keywords, Colors) or an unlabelled row (scene/setting/activity/
 * shot-type; mood/framing/time/lighting/weather), same as the six `@if`
 * blocks the retired hand-rolled markup rendered. Grouping them into one
 * array + a single `@for` (rather than six near-identical `@if` blocks)
 * keeps the template's branching low — each group already carries its own
 * "hide when empty" rule via {@link nonEmptyGroups}. */
interface VisionChipGroup {
  readonly label: string | null;
  readonly chips: readonly MuiChip[];
}

function nonEmptyGroups(groups: readonly VisionChipGroup[]): VisionChipGroup[] {
  return groups.filter((g) => g.chips.length > 0);
}

@Component({
  selector: 'app-info-vision',
  standalone: true,
  imports: [MuiCollapsibleComponent, MuiBadgeComponent, MuiTextComponent, MuiVisionRowComponent],
  templateUrl: './info-vision.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block',
    'data-testid': 'info-vision',
  },
})
export class InfoVisionComponent {
  readonly detail = input.required<ApiAssetDetail>();

  protected readonly isScreenshot = computed(() => this.detail().vision?.is_screenshot ?? false);

  /** Pluralized "N person"/"N people" label, or `null` when absent/zero —
   * `people_count` is absent on rows captioned before prompt v7, and absent
   * is not the same as zero, so this returns `null` for both (the template
   * just gates on truthiness either way). */
  protected readonly peopleCountLabel = computed<string | null>(() => {
    const n = this.detail().vision?.people_count;
    if (!n) return null;
    return `${n} ${n === 1 ? 'person' : 'people'}`;
  });

  /** `ocr_text` present and non-empty — the describe stage writes `''`
   * (not `null`) when the model saw no text, so this must check length,
   * not just presence. */
  protected readonly showOcrText = computed(() => {
    const text = this.detail().ocr_text;
    return !!text && text.length > 0;
  });

  protected readonly ocrText = computed(() => this.detail().ocr_text ?? '');

  protected readonly chipGroups = computed<VisionChipGroup[]>(() => {
    const v = this.detail().vision;
    if (!v) return [];
    // scene_type / shot_type / framing / time_of_day / lighting / weather
    // are null on screenshots (v5 short-circuit) — toChips() drops them.
    // `framing ?? composition` renders the retired v6 field for rows the
    // v7 re-describe hasn't reached yet; the two are never both populated.
    const weather =
      v.weather && v.weather !== 'indoor' && v.weather !== 'unknown' ? v.weather : null;
    return nonEmptyGroups([
      { label: 'Subjects', chips: toChips(v.subjects) },
      { label: null, chips: toChips([v.scene_type, v.setting, v.activity, v.shot_type]) },
      {
        label: null,
        chips: toChips([v.mood, v.framing ?? v.composition, v.time_of_day, v.lighting, weather]),
      },
      { label: 'Notable objects', chips: toChips(v.notable_objects) },
      // Search keywords (prompt v7) — `tags` is absent on pre-v7 rows.
      { label: 'Keywords', chips: toChips(v.tags ?? []) },
      { label: 'Colors', chips: toChips(v.colors) },
    ]);
  });
}
