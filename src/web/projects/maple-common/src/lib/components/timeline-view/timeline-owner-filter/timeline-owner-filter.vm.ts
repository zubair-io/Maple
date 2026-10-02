import { Observable, catchError, map, of, startWith, switchMap } from 'rxjs';
import type { SearchFacets, SearchParams, SearchService } from '../../../api/search.service';
import type { MuiSelectOption } from '../../../ui/select/mui-select.component';

type FacetParams = Omit<SearchParams, 'page' | 'limit' | 'sort'>;
type OwnerFacet = NonNullable<SearchFacets['owners']>[number];

export interface TimelineOwnerVm {
  readonly owners: readonly OwnerFacet[];
  readonly loading: boolean;
  readonly error: string | null;
}

export const EMPTY_OWNER_VM: TimelineOwnerVm = { owners: [], loading: false, error: null };

/** Owner choices reflect the other filters, so choosing one never hides the others. */
export function ownerFacetParams(params: FacetParams | null): FacetParams | null {
  if (params === null) return null;
  const { ownerId, ...scope } = params;
  void ownerId;
  return scope;
}

export function timelineOwnerVm(
  params: Observable<FacetParams | null>,
  search: Pick<SearchService, 'facets'>,
): Observable<TimelineOwnerVm> {
  return params.pipe(
    switchMap((scope) =>
      scope === null
        ? of(EMPTY_OWNER_VM)
        : search.facets(scope).pipe(
            map(
              (facets): TimelineOwnerVm => ({
                owners: facets.owners ?? [],
                loading: false,
                error: null,
              }),
            ),
            catchError(() =>
              of<TimelineOwnerVm>({
                owners: [],
                loading: false,
                error: 'Could not load owners.',
              }),
            ),
            startWith<TimelineOwnerVm>({ owners: [], loading: true, error: null }),
          ),
    ),
  );
}

export function timelineOwnerOptions(
  owners: readonly OwnerFacet[],
  userId: string | null,
  selectedId: string,
  selected: MuiSelectOption | null,
): readonly MuiSelectOption[] {
  const choices = [
    { value: '', label: 'All owners' },
    ...(userId ? [{ value: userId, label: 'Only my uploads' }] : []),
    ...owners
      .filter((owner) => owner.id !== userId)
      .map((owner) => ({ value: owner.id, label: owner.email })),
  ];
  // A zero-result filter or old server must not silently clear the selected owner.
  return selectedId && !choices.some((choice) => choice.value === selectedId)
    ? [
        ...choices,
        { value: selectedId, label: selected?.value === selectedId ? selected.label : selectedId },
      ]
    : choices;
}
