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
 * selection — or hydrate/deep-link it when not yet in memory. Dispatches to
 * the M2 `:slug` resolver or the legacy `:id` resolver; each owns its own
 * branching so neither this dispatcher nor either helper carries the whole
 * decision tree.
 */
export function applyRouteAddress(
  route: ActivatedRoute,
  state: LibraryStateService,
  router: Router,
): void {
  const slug = route.snapshot.paramMap.get('slug');
  if (slug) {
    resolveSlugRoute(slug, route, state, router);
    return;
  }
  const id = route.snapshot.paramMap.get('id');
  if (id) resolveLegacyIdRoute(id, state, router);
}

/**
 * Resolve an M2 `/edit/:slug/**` route (the current addressing scheme).
 * Each `try…`/`hydrate…` step returns whether it handled the route, so this
 * reads as a short chain of guarded early-returns rather than one deep block.
 */
function resolveSlugRoute(
  slug: string,
  route: ActivatedRoute,
  state: LibraryStateService,
  router: Router,
): void {
  if (tryOpenFsSchemeAsset(slug, state)) return;
  const addr = routeSegmentsToAddress(
    slug,
    route.snapshot.url.map((s) => s.path),
  );
  const addrStr = formatAddress(addr);
  const target = findRouteTarget(slug, addr, addrStr, state);
  if (target) {
    state.selectAsset(target.id);
    return;
  }
  if (hydrateSlugDeepLink(addrStr, state)) return;
  const filename = addr.relPath.split('/').pop() ?? addrStr;
  void hydrateFromCache(state, router, filename);
}

/**
 * Self-Hosted `fs:` `:slug` — hydrate the synth and open its parent. Returns
 * whether it handled the route (Self-Hosted backend, `fs:` slug, and the synth
 * resolved to an absPath); a no-match leaves the route for the address path.
 */
function tryOpenFsSchemeAsset(slug: string, state: LibraryStateService): boolean {
  if (state.backend !== 'self-hosted' || !slug.startsWith('fs:')) return false;
  const synth = state.hydrateSelfHostedFsAsset(slug as AssetId);
  if (!synth?.absPath) return false;
  state.selectAsset(synth.id);
  openHydratedFsParent(state, synth);
  return true;
}

/**
 * The in-memory asset a slug route resolves to. Matches the MapleAddress id —
 * or, when there is no relPath, the BARE slug: a landing-page import navigates
 * to `/edit/<uuid>` where the asset id IS the uuid (no colon), while
 * `formatAddress` yields `<uuid>:` (trailing colon) which can never equal it.
 * Without the bare-slug fallback the primary Hosted "Open a photo" flow
 * resolved no asset, fell through to `hydrateFromCache('')`, and bounced
 * straight back to the landing (#1960 found this while unblocking the bench).
 */
function findRouteTarget(
  slug: string,
  addr: { relPath: string },
  addrStr: string,
  state: LibraryStateService,
): Asset | undefined {
  const assets = state.assets();
  return (
    assets.find((a) => a.id === addrStr) ??
    (addr.relPath === '' ? assets.find((a) => a.id === slug) : undefined)
  );
}

/**
 * Self-Hosted deep-link into a `slug:relPath` not yet in memory: hydrate the
 * asset and open its parent folder so the filmstrip fills. Returns whether it
 * handled the route (Self-Hosted backend and a synth was found).
 */
function hydrateSlugDeepLink(addrStr: string, state: LibraryStateService): boolean {
  if (state.backend !== 'self-hosted') return false;
  const synth = state.hydrateSelfHostedFsAsset(addrStr as AssetId);
  if (!synth) return false;
  state.selectAsset(synth.id);
  // Load the parent folder (siblings → filmstrip) via the parent address.
  // synth.folderId is the parent's `slug:relPath` (post-cutover the synth no
  // longer carries an absPath to derive the dir from).
  const parentRelPath = parseAddress(synth.folderId).relPath;
  state.openSelfHostedSubfolder(parentRelPath, synth.folderId, synth.id);
  return true;
}

/** Resolve a legacy `:id` route (pre-M2 scheme, still hit by deep-links). */
function resolveLegacyIdRoute(id: string, state: LibraryStateService, router: Router): void {
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
