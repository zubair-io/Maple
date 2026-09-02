// xmp-look-profile.ts — `papp:Look` / `papp:Profile` parsing, split out of
// `XmpParserService.parseAdjustmentModel` (#1840, complexity hotspot).
//
// Auto Profile (#536): the new `papp:Profile` wins over the legacy
// `papp:Look` migration when both appear on the same element, regardless of
// document order. Mirrors raw-core's `profile_seen` flag pattern in
// `xmp/mod.rs` — Profile always overwrites when seen; the flag blocks a
// later Look from clobbering an earlier Profile.

import type { AdjustmentModel } from '../models/adjustment-model';
import type { Look, Profile } from '../generated/adjustment-model.generated';

/** Mutable across both attributes on one `rdf:Description` — must be shared
 * between `applyLookAttribute` and `applyProfileAttribute` for a single
 * `parseAdjustmentModel` call, since which one "wins" depends on whether
 * Profile has already been seen, not on attribute order. */
export interface LookProfileState {
  profileSeen: boolean;
}

export function newLookProfileState(): LookProfileState {
  return { profileSeen: false };
}

/**
 * DisplayLookCurve (#371; retired in #443). Case-insensitive parse matches
 * the Apple + Rust parsers. Unknown variants are silently dropped so older
 * sidecars never block sidecar load — the field then takes its default
 * ('Default'). The field is a no-op at the pipeline level post-#443; parsed
 * purely for sidecar back-compat.
 *
 * Auto Profile (#536): when `papp:Profile` has not yet been seen on this
 * element, `papp:Look` also migrates into the new `profile` field —
 * Default/Auto → 'Auto', Neutral → 'Neutral'. The migration reads the raw
 * value (not the parsed `Look`) because `Look="Auto"` is a valid legacy
 * value with no TS `Look` variant; it still migrates. Mirrors raw-core's
 * `xmp/mod.rs` Look→Profile arm.
 */
export function applyLookAttribute(
  model: Partial<AdjustmentModel>,
  rawValue: string,
  state: LookProfileState,
): void {
  const v = rawValue.toLowerCase();
  const parsedLook: Look | undefined =
    v === 'neutral' ? 'Neutral' : v === 'default' ? 'Default' : undefined;
  if (parsedLook !== undefined) {
    model.look = parsedLook;
  }
  if (!state.profileSeen) {
    if (v === 'default' || v === 'auto') {
      model.profile = 'Auto';
    } else if (v === 'neutral') {
      model.profile = 'Neutral';
    }
  }
}

/**
 * Auto Profile (Phase 1, #536). Canonical render-shaping profile.
 * Case-insensitive parse matches raw-core. Unknown values fall back to
 * 'Auto' so a forward-compat sidecar from a newer build doesn't block
 * sidecar load. Setting `profileSeen` blocks the legacy `papp:Look`
 * migration from clobbering this value if Look appears later in the same
 * attribute set.
 */
export function applyProfileAttribute(
  model: Partial<AdjustmentModel>,
  rawValue: string,
  state: LookProfileState,
): void {
  state.profileSeen = true;
  const v = rawValue.toLowerCase();
  const parsed: Profile = v === 'neutral' ? 'Neutral' : 'Auto';
  model.profile = parsed;
}
