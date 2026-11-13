// FolderOccupancyService — every name in one library folder (#5050).
//
// Keep Both for a RAW+JPEG pair has to choose one stem that is free for the
// RAW, the JPEG and their sidecar before either file is moved; the server
// suffixes one file at a time. The unfolded listing (no `stack=1`) names every
// image, plain file, sidecar and sub-folder, so the free stem is chosen from
// it. Each file is then sent with `collision: 'skip'`, so a name taken in the
// meantime comes back as a collision rather than an overwrite.

import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { API_BASE_URL } from '../api/api-base-url.token';
import { parseAddress, toApiPath } from '../addressing/maple-address';

interface NamedEntry {
  readonly name: string;
}

interface UnfoldedListingWire {
  readonly folders?: readonly NamedEntry[];
  readonly images?: readonly NamedEntry[];
  readonly files?: readonly NamedEntry[];
  readonly sidecars?: readonly NamedEntry[];
}

@Injectable({ providedIn: 'root' })
export class FolderOccupancyService {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** Lower-cased names in the folder at `folderAddress` (`slug:relPath`). */
  occupiedNames(folderAddress: string): Observable<ReadonlySet<string>> {
    return this.http
      .get<UnfoldedListingWire>(`${this.base}/folder/${toApiPath(parseAddress(folderAddress))}`)
      .pipe(
        map(
          (listing) =>
            new Set(
              [listing.folders, listing.images, listing.files, listing.sidecars].flatMap(
                (entries) => (entries ?? []).map((entry) => entry.name.toLowerCase()),
              ),
            ),
        ),
      );
  }
}
