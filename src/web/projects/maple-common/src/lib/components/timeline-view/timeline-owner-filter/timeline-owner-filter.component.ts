import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { distinctUntilChanged, map } from 'rxjs';
import { SearchService } from '../../../api/search.service';
import { AuthService } from '../../../auth/auth.service';
import { TimelineStateService } from '../../../state/timeline-state.service';
import { MuiSelectComponent, MuiSelectOption } from '../../../ui/select/mui-select.component';
import {
  EMPTY_OWNER_VM,
  ownerFacetParams,
  timelineOwnerOptions,
  timelineOwnerVm,
} from './timeline-owner-filter.vm';

@Component({
  selector: 'app-timeline-owner-filter',
  standalone: true,
  imports: [MuiSelectComponent],
  templateUrl: './timeline-owner-filter.component.html',
  styleUrl: './timeline-owner-filter.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimelineOwnerFilterComponent {
  readonly state = inject(TimelineStateService);
  private readonly auth = inject(AuthService);
  private readonly search = inject(SearchService);
  private readonly revision = signal(0);
  private readonly selected = signal<MuiSelectOption | null>(null);
  private readonly request = computed(() => ({
    params: ownerFacetParams(this.state.params()),
    revision: this.revision(),
  }));
  readonly vm = toSignal(
    timelineOwnerVm(
      toObservable(this.request).pipe(
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        map((request) => request.params),
      ),
      this.search,
    ),
    { initialValue: EMPTY_OWNER_VM },
  );
  readonly options = computed(() =>
    timelineOwnerOptions(
      this.vm().owners,
      this.auth.user()?.id ?? null,
      this.state.ownerId(),
      this.selected(),
    ),
  );

  selectOwner(id: string): void {
    this.selected.set(this.options().find((option) => option.value === id) ?? null);
    this.state.setOwnerId(id);
  }

  retry(): void {
    this.revision.update((value) => value + 1);
  }
}
