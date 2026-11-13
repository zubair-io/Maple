//! The Kotlin transfer table Android pastes with must be raw-core's own (#5900).
use raw_core::types::{
    transfer_mode, AdjustmentGroup, NON_COPYABLE_FIELDS, TRANSFER_XMP_ATTRIBUTES,
    TRANSFER_XMP_ELEMENTS,
};

const KOTLIN: &str =
    include_str!("../../app/src/main/java/app/justmaple/aperture/generated/AdjustmentTransfer.kt");

fn quoted(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| format!("\"{value}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn rows(section: &str) -> Vec<&'static str> {
    let start = KOTLIN.find(section).expect("generated section") + section.len();
    let end = start + KOTLIN[start..].find("\n    )\n").expect("section end");
    KOTLIN[start..end]
        .lines()
        .filter(|line| !line.is_empty())
        .collect()
}

#[test]
fn the_generated_kotlin_table_matches_raw_core() {
    let fields: Vec<&str> = AdjustmentGroup::ALL
        .iter()
        .flat_map(|group| group.fields().iter().copied())
        .chain(NON_COPYABLE_FIELDS.iter().copied())
        .collect();
    let modes: Vec<String> = fields
        .iter()
        .map(|field| {
            let mode = transfer_mode(field).expect("transfer decision").name();
            format!("        \"{field}\" to AdjustmentTransferMode.{mode},")
        })
        .collect();
    assert_eq!(
        rows("val modes: Map<String, AdjustmentTransferMode> = mapOf(\n"),
        modes
    );

    let attributes: Vec<String> = TRANSFER_XMP_ATTRIBUTES
        .iter()
        .map(|(field, keys)| format!("        \"{field}\" to listOf({}),", quoted(keys)))
        .collect();
    assert_eq!(
        rows("val xmpAttributes: Map<String, List<String>> = mapOf(\n"),
        attributes
    );

    let elements: Vec<String> = TRANSFER_XMP_ELEMENTS
        .iter()
        .map(|(field, key)| format!("        \"{field}\" to \"{key}\","))
        .collect();
    assert_eq!(
        rows("val xmpElements: Map<String, String> = mapOf(\n"),
        elements
    );

    let groups = rows("val groups: List<AdjustmentTransferGroup> = listOf(\n").join("\n");
    let expected = AdjustmentGroup::ALL
        .iter()
        .map(|group| {
            let members = group
                .fields()
                .iter()
                .map(|field| format!("                \"{field}\",\n"))
                .collect::<String>();
            format!(
                "        AdjustmentTransferGroup(\n            \"{}\",\n            \"{}\",\n            listOf(\n{members}            ),\n        ),",
                group.id(),
                group.label()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(groups, expected);
}
