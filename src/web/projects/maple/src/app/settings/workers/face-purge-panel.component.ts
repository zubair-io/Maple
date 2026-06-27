// FacePurgePanelComponent — "Sub-threshold face cleanup" subsection of the
// face-detect panel on /settings/workers (#1607).
//
// Audit-first: an Audit button runs the read-only dry-run scan and renders
// the breakdown (total tiny faces; unassigned / assigned-to-a-person / hidden;
// # people affected). An Apply control — enabled only after an audit — removes
// the sub-threshold faces. By default it removes ONLY unassigned faces;
// a checkbox opts in to also removing tiny faces assigned to a person. NOTE: a
// face carries only `person_id` — there is no field distinguishing a label the
// operator set by hand from one auto-grouping assigned, so the opt-in removes
// BOTH. Hidden faces are always preserved server-side. Apply is confirm-gated.
//
// This does NOT re-detect. Removing a sub-threshold face never changes any
// other face's assignment (`person_id` lives on each face object); it filters
// the matched faces out of each asset's faces[] and recomputes face_count only
// for people who lose assigned faces.
//
// Extracted into its own standalone component (rather than growing
// workers.component) to stay under the file-size budget.

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  BunApiBackendService,
  errorMessage,
  type SubthresholdFaceAuditResponse,
  type SubthresholdFacePurgeResponse,
} from '@maple-common';

type PanelState = 'idle' | 'auditing' | 'applying';

@Component({
  selector: 'maple-face-purge-panel',
  standalone: true,
  templateUrl: './face-purge-panel.component.html',
  styleUrl: './face-purge-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FacePurgePanelComponent {
  private readonly backend = inject(BunApiBackendService);

  protected readonly state = signal<PanelState>('idle');
  protected readonly audit = signal<SubthresholdFaceAuditResponse | null>(null);
  protected readonly lastApplied = signal<SubthresholdFacePurgeResponse['applied'] | null>(null);
  protected readonly error = signal<string | null>(null);

  /** Opt-in to also removing tiny faces assigned to a person (hand-labeled or
   * auto-grouping — indistinguishable). Default OFF. */
  protected readonly includeAssigned = signal(false);

  protected readonly busy = computed(() => this.state() !== 'idle');

  /** Apply is only meaningful once an audit has run and found something to
   * remove given the current opt-in state. */
  protected readonly removableCount = computed(() => {
    const a = this.audit();
    if (!a) return 0;
    const base = a.subThresholdFaces.unassigned;
    return this.includeAssigned() ? base + a.subThresholdFaces.assigned : base;
  });

  protected readonly canApply = computed(() => !this.busy() && this.removableCount() > 0);

  /** Run the read-only audit. `preserveApplied` keeps the prior apply's
   * success summary on screen — used when re-auditing right after an apply
   * so the operator still sees what was removed. The Audit button clears it. */
  async runAudit(preserveApplied = false): Promise<void> {
    if (this.busy()) return;
    this.state.set('auditing');
    this.error.set(null);
    if (!preserveApplied) this.lastApplied.set(null);
    try {
      const res = await firstValueFrom(this.backend.auditSubthresholdFaces());
      this.audit.set(res);
    } catch (err) {
      this.error.set(errorMessage(err));
      this.audit.set(null);
    } finally {
      this.state.set('idle');
    }
  }

  async apply(): Promise<void> {
    if (!this.canApply()) return;
    const include = this.includeAssigned();
    const count = this.removableCount();
    const ok = include
      ? confirm(
          `Remove ${count} tiny faces assigned to people? This includes faces you may have ` +
            `labeled by hand and can't be undone without a full re-detect. Hidden faces are kept.`,
        )
      : confirm(
          `Remove ${count} unassigned tiny faces? This cannot be undone without a full ` +
            `re-detect. Assigned and hidden faces are kept.`,
        );
    if (!ok) return;

    this.state.set('applying');
    this.error.set(null);
    try {
      const res = await firstValueFrom(this.backend.purgeSubthresholdFaces(include));
      this.lastApplied.set(res.applied);
      // Re-run the audit so the breakdown reflects the post-purge state,
      // keeping the success summary visible.
      this.state.set('idle');
      await this.runAudit(true);
    } catch (err) {
      this.error.set(errorMessage(err));
      this.state.set('idle');
    }
  }
}
