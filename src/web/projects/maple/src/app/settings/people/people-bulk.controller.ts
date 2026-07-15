// PeopleBulkController — plain-TS controller for the list-view bulk
// people selection, merge, and hide operations on the `/settings/people` page.
//
// Extracted from `PeopleComponent` to satisfy the 600-LOC file budget.
// Mirrors the `ThumbBlobCache` pattern: a plain class with deps threaded
// through the constructor, instantiated once per component instance.
// Signals and computeds work outside an injection context; only `effect()`
// needs one (not used here).

import { computed, signal, type Signal } from '@angular/core';
import { Router } from '@angular/router';
import { type ApiPerson, type ApiPersonDetail, PeopleStore } from '@maple-common';
import {
  errorMessage,
  hidePeopleConfirm,
  mergePeopleConfirm,
  mergeTargets,
  toggleKey,
  type Tone,
} from './people.vm';

export interface PeopleBulkDeps {
  store: PeopleStore;
  router: Router;
  people: Signal<ApiPerson[]>;
  namedPeople: Signal<ApiPerson[]>;
  selected: Signal<ApiPersonDetail | null>;
  toast: (text: string, tone: Tone) => void;
}

export class PeopleBulkController {
  /** When true, list cards toggle selection instead of navigating. */
  readonly selectMode = signal<boolean>(false);

  /** Selected person ids for the bulk toolbar. */
  readonly selectedPeople = signal<ReadonlySet<string>>(new Set());

  /** In-flight count for a bulk people op — disables the toolbar while > 0. */
  readonly peopleBulkBusy = signal<number>(0);

  /** Whether the detail header is showing the merge-target `<select>`. */
  readonly mergePickerOpen = signal<boolean>(false);

  /** Named-people merge targets for the list toolbar, excluding the current
   * selection (you can't merge people into one of themselves). */
  readonly mergeTargetsList = computed(() =>
    mergeTargets(this.deps.namedPeople(), this.selectedPeople()),
  );

  /** Named-people targets for the detail merge, excluding the open person. */
  readonly detailMergeTargets = computed(() => {
    const detail = this.deps.selected();
    const exclude = new Set<string>(detail ? [detail.id] : []);
    return mergeTargets(this.deps.namedPeople(), exclude);
  });

  constructor(private readonly deps: PeopleBulkDeps) {}

  enterSelectMode(): void {
    this.selectMode.set(true);
  }

  exitSelectMode(): void {
    this.selectMode.set(false);
    this.selectedPeople.set(new Set());
  }

  isPersonSelected(id: string): boolean {
    return this.selectedPeople().has(id);
  }

  togglePersonSelection(id: string): void {
    this.selectedPeople.set(toggleKey(this.selectedPeople(), id));
  }

  private clearPeopleSelection(): void {
    this.selectedPeople.set(new Set());
  }

  /** Shared merge flow for the list toolbar AND the detail button. Confirms,
   * calls the store, toasts the result, then runs `after` (list: clear +
   * stay in select mode; detail: navigate to the target). */
  private async performMerge(
    targetId: string,
    sourceIds: string[],
    after: () => void,
  ): Promise<void> {
    if (!targetId || sourceIds.length === 0) return;
    const targetName = this.deps.people().find((p) => p.id === targetId)?.name ?? 'person';
    if (!confirm(mergePeopleConfirm(sourceIds.length, targetName))) return;
    this.peopleBulkBusy.update((n) => n + 1);
    try {
      const result = await this.deps.store.mergePeople(targetId, sourceIds);
      this.deps.toast(`Merged ${result.mergedCount} into ${result.name}`, 'success');
      after();
    } catch (err) {
      this.deps.toast(errorMessage(err), 'error');
    } finally {
      this.peopleBulkBusy.update((n) => Math.max(0, n - 1));
    }
  }

  mergeSelectedInto(targetId: string): void {
    void this.performMerge(targetId, [...this.selectedPeople()], () => this.clearPeopleSelection());
  }

  async hideSelectedPeople(): Promise<void> {
    const ids = [...this.selectedPeople()];
    if (ids.length === 0) return;
    if (!confirm(hidePeopleConfirm(ids.length))) return;
    this.peopleBulkBusy.update((n) => n + 1);
    try {
      const { ok, failed } = await this.deps.store.hidePeople(ids);
      if (ok > 0) this.deps.toast(`Hid ${ok} ${ok === 1 ? 'person' : 'people'}`, 'success');
      if (failed > 0) this.deps.toast(`${failed} failed to hide`, 'error');
      this.clearPeopleSelection();
    } catch (err) {
      this.deps.toast(errorMessage(err), 'error');
    } finally {
      this.peopleBulkBusy.update((n) => Math.max(0, n - 1));
    }
  }

  openMergePicker(): void {
    this.mergePickerOpen.set(true);
  }

  cancelMergePicker(): void {
    this.mergePickerOpen.set(false);
  }

  /** Merge the open person INTO the picked target, then navigate to the
   * target's detail page (it now shows the combined faces). */
  mergeDetailInto(targetId: string): void {
    const detail = this.deps.selected();
    if (!detail || !targetId) return;
    // Close the picker only on confirmed success (inside `after`), so a
    // cancelled confirm leaves it open to retry. The <select> value is reset
    // by its (change) handler so a cancel shows the placeholder, not a stale pick.
    void this.performMerge(targetId, [detail.id], () => {
      this.mergePickerOpen.set(false);
      void this.deps.router.navigate(['/settings/people', targetId]);
    });
  }

  /** Merge the currently-open person's suggested duplicate INTO this page —
   * the OPPOSITE direction from `mergeDetailInto`: here the page you're on
   * always survives (keeps its id/name/cover), the suggested other person
   * is always the one folded in. Fixed rule, not a "prefer the named one"
   * heuristic — see the merge-suggestions design doc. */
  mergeSuggestionInto(): void {
    const detail = this.deps.selected();
    const suggestion = detail?.suggestedMerge;
    if (!detail || !suggestion) return;
    void this.performMerge(detail.id, [suggestion.personId], () => {});
  }

  /** "Not the same person" — permanently dismisses the suggestion so it
   * doesn't resurface on the next clustering run. */
  async dismissSuggestion(): Promise<void> {
    const detail = this.deps.selected();
    const suggestion = detail?.suggestedMerge;
    if (!detail || !suggestion) return;
    try {
      await this.deps.store.dismissMergeSuggestion(detail.id, suggestion.personId);
    } catch (err) {
      this.deps.toast(errorMessage(err), 'error');
    }
  }
}
