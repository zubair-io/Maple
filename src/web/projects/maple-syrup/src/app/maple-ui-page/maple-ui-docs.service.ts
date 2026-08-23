import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, forkJoin, map, switchMap } from 'rxjs';

/** One entry in the synced `maple-ui/manifest.json`. */
export interface MapleUiManifestEntry {
  readonly slug: string;
  readonly title: string;
}

/** A contract doc with its raw markdown body. */
export interface MapleUiContract extends MapleUiManifestEntry {
  readonly markdown: string;
}

// Loads the Maple UI component contracts synced into the app's public
// assets by scripts/sync-maple-ui-docs.mjs (#3000). The docs are the same
// files the maple-ui-contracts CI job lints — this service just fetches
// the copies shipped with the build.
@Injectable({ providedIn: 'root' })
export class MapleUiDocsService {
  private readonly http = inject(HttpClient);

  contracts(): Observable<readonly MapleUiContract[]> {
    return this.http
      .get<MapleUiManifestEntry[]>('maple-ui/manifest.json')
      .pipe(
        switchMap((entries) =>
          forkJoin(
            entries.map((entry) =>
              this.http
                .get(`maple-ui/${entry.slug}.md`, { responseType: 'text' })
                .pipe(map((markdown) => ({ ...entry, markdown }))),
            ),
          ),
        ),
      );
  }
}
