// AdjustmentGroupMerge.swift — group-scoped AdjustmentModel merge (#944).
//
// Copy/paste/sync move whole GROUPS of fields from a source model onto a
// target model — unlike `PresetAdjustments.merged`, which merges a sparse
// "only the fields that were non-default at capture time" map. Pasting the
// Tone group must set the target's `exposure` even when the source's
// exposure sits at the schema default (0), so this is a full model→model
// field copy, driven by `AdjustmentGroup.fieldNames` (raw-core canonical,
// generated) and reusing `AdjustmentModel.FieldName.numericKeyPath` (the
// existing preset-bridge keypath table) for the scalar fields — one
// field↔property mapping in the app, not two.

import Foundation

public enum AdjustmentGroupMerge {
    /// Returns `target` with every field named by `groups` overwritten from
    /// `source`. Field names the Swift model doesn't carry (`wb_method`,
    /// `tone_curve_mode`, the `tone_curve_luma/red/green/blue` point-curve
    /// fields, `temperature_seen`, `tint_seen`) are silently skipped — the
    /// same passthrough rule `PresetAdjustments` uses for schema fields a
    /// newer client version might add. Does not mutate either argument.
    public static func merged(
        _ target: AdjustmentModel,
        applying source: AdjustmentModel,
        groups: Set<AdjustmentGroup>
    ) -> AdjustmentModel {
        var merged = target
        for group in groups {
            for name in group.fieldNames {
                apply(name, from: source, into: &merged)
            }
        }
        return merged
    }

    private static func apply(
        _ name: String,
        from source: AdjustmentModel,
        into merged: inout AdjustmentModel
    ) {
        if let field = AdjustmentModel.FieldName(rawValue: name) {
            applyFieldName(field, from: source, into: &merged)
            return
        }
        // The two group fields Swift carries under a name that isn't a
        // canonical `FieldName` — `crop` has no scalar range/keypath (it's
        // a struct, not a slider), and the WB scale version isn't a develop
        // slider either.
        switch name {
        case "crop":
            merged.crop = source.crop
        case "wb_scale_version":
            merged.wbScaleVersion = source.wbScaleVersion
        default:
            break // e.g. temperature_seen / tint_seen — no Swift property.
        }
    }

    private static func applyFieldName(
        _ field: AdjustmentModel.FieldName,
        from source: AdjustmentModel,
        into merged: inout AdjustmentModel
    ) {
        if let keyPath = field.numericKeyPath {
            merged[keyPath: keyPath] = source[keyPath: keyPath]
            return
        }
        // Enum-valued fields the Swift model DOES carry — mirrors the
        // switch in `PresetAdjustments.merged`, minus the "only known
        // variant" guard (both sides are already-valid `AdjustmentModel`
        // values, not untrusted wire strings).
        switch field {
        case .highlightRecovery:
            merged.highlightRecovery = source.highlightRecovery
        case .autoExposure:
            merged.autoExposure = source.autoExposure
        case .look:
            merged.look = source.look
        case .profile:
            merged.profile = source.profile
        case .hotPixelSuppression:
            merged.hotPixelSuppression = source.hotPixelSuppression
        case .blackWhite:
            // #276. In the Color group, so a paste of Color from a
            // monochrome source must convert the target too — without this
            // case the mode falls through to `default` and the eight
            // gray-mixer weights land on an image still rendering in colour.
            merged.blackWhite = source.blackWhite
        case .lensProfileEnable:
            // #376, same failure mode as `.blackWhite` above. In the Detail
            // group alongside the three `lensCorrection*` scales, which DO
            // have numeric key paths — so without this case a Detail paste
            // lands three live strengths and leaves the master switch that
            // gates them behind on the target.
            merged.lensProfileEnable = source.lensProfileEnable
        default:
            break // wb_method, tone_curve_mode, capture_sharpening_radius — no Swift property.
        }
    }
}
