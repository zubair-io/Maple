// editor-shell-route.ts — route address resolution for EditorShellComponent.
//
// Extracted verbatim from the component (same precedent as
// editor-shell-chrome.ts / editor-shell-scrub.ts / editor-shell-keyboard.ts —
// keeps the component under the per-file LOC budget); only `this.` receiver
// access became explicit parameters. The component's `applyRouteAddress()`
// delegates here from its constructor route.url subscription and ngOnInit.
//
// Covered by editor-shell.component.spec.ts ("EditorShellComponent.applyRouteAddress"),
// which drives these paths through the component delegate.

import type { ActivatedRoute, Router } from '@angular/router';
import type { LibraryStateService } from '../../state/library-state.service';
import type { Asset, AssetId } from '../../models/asset';
import { getPersistedFile } from '../../folder-access/file-cache';
import { formatAddress, parseAddress } from '../../addressing/maple-address';
import { routeSegmentsToAddress } from '../../addressing/route-address';

/**
 * Resolve the current `/edit/:slug/**` (or legacy `:id`) route to an asset
 * selection — or hydrate/deep-link it when not yet in memory.
 */
export function applyRouteAddress(
  route: ActivatedRoute,
  state: LibraryStateService,
  router: Router,
): void {
  const slug = route.snapshot.paramMap.get('slug');
  if (slug) {
    if (state.backend === 'self-hosted' && slug.startsWith('fs:')) {
      const synth = state.hydrateSelfHostedFsAsset(slug as AssetId);
      if (synth?.absPath) {
        state.selectAsset(synth.id);
        openHydratedFsParent(state, synth);
        return;
      }
    }
    const segments = route.snapshot.url.map((s) => s.path);
    const addr = routeSegmentsToAddress(slug, segments);
    const addrStr = formatAddress(addr);
    const assets = state.assets();
    // Match the MapleAddress id — or, when there is no relPath, the BARE
    // slug: a landing-page import navigates to `/edit/<uuid>` where the
    // asset id IS the uuid (no colon), while `formatAddress` yields
    // `<uuid>:` (trailing colon) which can never equal it. Without the
    // bare-slug fallback the primary Hosted "Open a photo" flow resolved no
    // asset, fell through to `hydrateFromCache('')`, and bounced straight
    // back to the landing (#1960 found this while unblocking the bench).
    const target =
      assets.find((a) => a.id === addrStr) ??
      (addr.relPath === '' ? assets.find((a) => a.id === slug) : undefined);
    if (target) {
      state.selectAsset(target.id);
      return;
    }
    if (state.backend === 'self-hosted') {
      const synth = state.hydrateSelfHostedFsAsset(addrStr as AssetId);
      if (synth) {
        state.selectAsset(synth.id);
        // Load the parent folder (siblings → filmstrip) via the parent
        // address. synth.folderId is the parent's `slug:relPath` (post-cutover
        // the synth no longer carries an absPath to derive the dir from).
        const parentRelPath = parseAddress(synth.folderId).relPath;
        state.openSelfHostedSubfolder(parentRelPath, synth.folderId, synth.id);
        return;
      }
    }
    const filename = addr.relPath.split('/').pop() ?? addrStr;
    void hydrateFromCache(state, router, filename);
    return;
  }

  const id = route.snapshot.paramMap.get('id');
  if (!id) return;

  const assets = state.assets();
  const target =
    id === 'first' ? state.assetsInSelectedFolder()[0] : assets.find((a) => a.id === id);

  if (target) {
    state.selectAsset(target.id);
    return;
  }

  // Note: the legacy `fs:<absPath>` scheme is retired (post-M2 cutover).
  // Deep-links that used it fall through to the file-cache path below,
  // which redirects to Browse if the file is not in the session cache.

  if (assets.length > 0) {
    state.selectAsset(assets[0].id);
    return;
  }

  void hydrateFromCache(state, router, id);
}

function openHydratedFsParent(state: LibraryStateService, synth: Asset): void {
  if (synth.id.startsWith('fs:') || !synth.absPath) return;
  const lastSlash = synth.absPath.lastIndexOf('/');
  if (lastSlash < 0) return;
  const parentDir = lastSlash === 0 ? '/' : synth.absPath.slice(0, lastSlash);
  state.openSelfHostedSubfolder(parentDir, synth.folderId, synth.id);
}

async function hydrateFromCache(
  state: LibraryStateService,
  router: Router,
  id: string,
): Promise<void> {
  if (id === 'first') return;
  try {
    const record = await getPersistedFile(id);
    if (!record) {
      void router.navigate(['/']);
      return;
    }
    const bytes = new Uint8Array(await record.file.arrayBuffer());
    state.addImportedAsset(bytes, record.filename, id);
    state.selectedSourceId.set('f-imported');
    state.selectAsset(id);
  } catch (err) {
    console.error('EditorShell: hydrateFromCache failed', err);
    void router.navigate(['/']);
  }
}
