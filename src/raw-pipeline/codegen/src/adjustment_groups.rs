//! Emitters for the copy/paste/sync adjustment-group table (ticket #944).
//!
//! `raw_core::types::AdjustmentGroup` owns the group → field mapping; this
//! module renders it into the Swift and TypeScript generated files so the two
//! front-ends cannot diverge on group identity, labels, or membership.
//!
//! Split out of `main.rs` to keep that file under the 600-LOC hard budget.

use raw_core::types::{AdjustmentGroup, NON_COPYABLE_FIELDS};

use crate::camel_case;

const SWIFT_HEADER: &str = "\
// MARK: - Copy / paste / sync groups (#944, canonical, generated)

/// A user-selectable bundle of `AdjustmentModel` fields for copy / paste /
/// sync (#944). Cases are declared in the order the selective-paste UI
/// presents them; raw values are the canonical storage / wire keys shared
/// with the Web client.
public enum AdjustmentGroup: String, CaseIterable, Sendable, Hashable {
";

const TS_HEADER: &str = "\
/**
 * A user-selectable bundle of `AdjustmentModel` fields for copy / paste /
 * sync (#944). The string values are the canonical storage / wire keys
 * shared with the Apple client.
 */
";

/// Swift: the `AdjustmentGroup` enum, its label, its member field names, and
/// the never-copied field list.
pub fn emit_swift() -> String {
    let mut s = String::from(SWIFT_HEADER);
    for group in AdjustmentGroup::ALL {
        s.push_str(&format!(
            "    case {} = \"{}\"\n",
            camel_case(group.id()),
            group.id()
        ));
    }
    s.push_str("}\n\n");

    s.push_str("extension AdjustmentGroup {\n");
    s.push_str("    /// Human-readable label for the selective-paste UI.\n");
    s.push_str("    public var label: String {\n");
    s.push_str("        switch self {\n");
    for group in AdjustmentGroup::ALL {
        s.push_str(&format!(
            "        case .{}: return \"{}\"\n",
            camel_case(group.id()),
            group.label()
        ));
    }
    s.push_str("        }\n    }\n\n");

    s.push_str(
        "    /// Canonical snake_case `AdjustmentModel` field names this group\n\
         \x20   /// carries. Names the Swift model does not mirror are simply skipped\n\
         \x20   /// by the merge — same passthrough rule the preset bridge uses.\n",
    );
    s.push_str("    public var fieldNames: [String] {\n");
    s.push_str("        switch self {\n");
    for group in AdjustmentGroup::ALL {
        s.push_str(&format!("        case .{}:\n", camel_case(group.id())));
        s.push_str("            return [\n");
        for name in group.fields() {
            s.push_str(&format!("                \"{}\",\n", name));
        }
        s.push_str("            ]\n");
    }
    s.push_str("        }\n    }\n");
    s.push_str("}\n\n");

    s.push_str(
        "/// `AdjustmentModel` fields deliberately never moved by copy / paste /\n\
         /// sync. See `raw_core::types::adjustment::schema::groups` for the\n\
         /// per-field rationale (notably the mask decision).\n",
    );
    s.push_str("public let adjustmentNonCopyableFields: [String] = [\n");
    for name in NON_COPYABLE_FIELDS {
        s.push_str(&format!("    \"{}\",\n", name));
    }
    s.push_str("]\n");
    s
}

/// Prettier's `printWidth` for `src/web` (`src/web/.prettierrc`). The
/// emitted TypeScript must already be Prettier-clean: the CI format gate and
/// the codegen-drift gate both run over the generated file, and a
/// `prettier --write` between them would fail one or the other.
const TS_PRINT_WIDTH: usize = 100;

/// Render a group's `fields:` member the way Prettier would: collapsed onto
/// one line when it fits inside `printWidth`, expanded one-per-line when it
/// does not. Indentation is the two levels inside `ADJUSTMENT_GROUPS`.
fn ts_field_array(names: &[&str]) -> String {
    let quoted: Vec<String> = names.iter().map(|n| format!("'{}'", n)).collect();
    let single = format!("    fields: [{}],\n", quoted.join(", "));
    if single.len() - 1 <= TS_PRINT_WIDTH {
        return single;
    }
    let body: String = quoted
        .iter()
        .map(|q| format!("      {},\n", q))
        .collect::<Vec<_>>()
        .concat();
    format!("    fields: [\n{}    ],\n", body)
}

/// TypeScript: the `AdjustmentGroupId` union, the `ADJUSTMENT_GROUPS` table,
/// and the never-copied field list. Formatted to match Prettier's output at
/// `printWidth: 100` so the codegen-drift and format-check gates agree.
pub fn emit_ts() -> String {
    let mut s = String::from(TS_HEADER);
    s.push_str("export type AdjustmentGroupId =\n");
    for (i, group) in AdjustmentGroup::ALL.iter().enumerate() {
        let terminator = if i + 1 == AdjustmentGroup::ALL.len() {
            ";"
        } else {
            ""
        };
        s.push_str(&format!("  | '{}'{}\n", group.id(), terminator));
    }
    s.push('\n');

    s.push_str("/** One selectable group in the copy / paste / sync UI (#944). */\n");
    s.push_str("export interface AdjustmentGroupSpec {\n");
    s.push_str("  readonly id: AdjustmentGroupId;\n");
    s.push_str("  /** Human-readable label for the selective-paste UI. */\n");
    s.push_str("  readonly label: string;\n");
    s.push_str(
        "  /**\n   * Canonical snake_case `AdjustmentModel` field names this group carries.\n   \
         * Names the TypeScript model does not mirror are skipped by the merge.\n   */\n",
    );
    s.push_str("  readonly fields: readonly string[];\n");
    s.push_str("}\n\n");

    s.push_str(
        "/** Every group, in the order the selective-paste UI presents them. */\n\
         export const ADJUSTMENT_GROUPS: readonly AdjustmentGroupSpec[] = [\n",
    );
    for group in AdjustmentGroup::ALL {
        s.push_str("  {\n");
        s.push_str(&format!("    id: '{}',\n", group.id()));
        s.push_str(&format!("    label: '{}',\n", group.label()));
        s.push_str(&ts_field_array(group.fields()));
        s.push_str("  },\n");
    }
    s.push_str("];\n\n");

    s.push_str(
        "/**\n * `AdjustmentModel` fields deliberately never moved by copy / paste / sync.\n \
         * See `raw_core::types::adjustment::schema::groups` for the per-field\n \
         * rationale (notably the mask decision).\n */\n",
    );
    s.push_str("export const ADJUSTMENT_NON_COPYABLE_FIELDS: readonly string[] = [\n");
    for name in NON_COPYABLE_FIELDS {
        s.push_str(&format!("  '{}',\n", name));
    }
    s.push_str("];\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swift_emits_every_group_case_and_field() {
        let out = emit_swift();
        assert!(out.contains("public enum AdjustmentGroup: String, CaseIterable"));
        assert!(out.contains("case whiteBalance = \"white_balance\""));
        assert!(out.contains("case geometry = \"geometry\""));
        assert!(out.contains("case .whiteBalance: return \"White Balance\""));
        assert!(out.contains("\"wb_scale_version\","));
        assert!(out.contains("public let adjustmentNonCopyableFields"));
        assert!(out.contains("\"local_adjustments\","));
    }

    #[test]
    fn ts_emits_union_table_and_exclusions() {
        let out = emit_ts();
        assert!(out.contains("export type AdjustmentGroupId ="));
        assert!(out.contains("| 'white_balance'"));
        assert!(out.contains("export const ADJUSTMENT_GROUPS: readonly AdjustmentGroupSpec[]"));
        assert!(out.contains("label: 'White Balance',"));
        assert!(out.contains("'tone_curve_luma',"));
        assert!(out.contains("export const ADJUSTMENT_NON_COPYABLE_FIELDS"));
        assert!(out.contains("'inpaint_removals',"));
    }

    /// Prettier collapses an array that fits inside `printWidth` and expands
    /// one that doesn't; the emitter has to make the same call or the
    /// format-check and codegen-drift gates disagree. `geometry` (one field)
    /// is the short case, `white_balance` the long one.
    #[test]
    fn ts_field_arrays_match_prettier_wrapping() {
        assert_eq!(ts_field_array(&["crop"]), "    fields: ['crop'],\n");
        let wide = ts_field_array(&[
            "temperature",
            "tint",
            "temperature_seen",
            "tint_seen",
            "wb_method",
            "wb_scale_version",
        ]);
        assert!(wide.starts_with("    fields: [\n"));
        assert!(wide.contains("      'temperature',\n"));
        assert!(wide.ends_with("    ],\n"));
        assert!(emit_ts().lines().all(|line| line.len() <= TS_PRINT_WIDTH));
    }

    #[test]
    fn emitters_are_deterministic() {
        assert_eq!(emit_swift(), emit_swift());
        assert_eq!(emit_ts(), emit_ts());
    }
}
