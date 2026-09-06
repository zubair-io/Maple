//! Windows consumer of the same support vocabulary and evidence as Swift/TS.
use crate::support_tiers::{closed_enums, fallback_rows, BANNER};
use raw_core::{
    capability_registry::Evidence,
    support_tiers::{SupportRegistry, SUPPORT_TIER_SCHEMA_VERSION},
};

fn member(id: &str) -> String {
    id.split('_')
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect()
}

fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

pub(crate) fn emit_cs(registry: &SupportRegistry, evidence: &Evidence) -> String {
    let build = evidence.build.expect("evidence carries a build identity");
    let mut out: String = BANNER
        .lines()
        .map(|line| format!("//{}{line}\n", if line.is_empty() { "" } else { " " }))
        .collect();
    out.push_str("\nusing System;\nusing System.Collections.Generic;\nusing System.Linq;\n\nnamespace Maple.WinUI.Generated\n{\n");
    for (name, cases) in closed_enums() {
        out.push_str(&format!(
            "    public enum {name} {{ {} }}\n",
            cases
                .iter()
                .map(|(id, _, _)| member(id))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    out.push_str(&format!(
        "    public enum ProfileResolution {{ {} }}\n\n",
        fallback_rows()
            .iter()
            .map(|(id, _)| member(id))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    out.push_str("    public sealed record SupportedCamera(string Key, string DisplayName, string Fixture, CameraTier Tier, LensSupport Lens, ProfileResolution Resolution);\n\n    public static class CameraSupportRegistry\n    {\n");
    out.push_str(&format!("        public const uint SchemaVersion = {SUPPORT_TIER_SCHEMA_VERSION};\n        public const uint PipelineOutputVersion = {};\n        public const uint BundledModelCount = {};\n        public const string ProfileBundleDigest = {};\n\n",build.pipeline_version,registry.bundled_models.len(),quoted(&registry.profile_bundle_digest)));
    for (name, cases) in closed_enums() {
        for (method, index) in [("Id", 0), ("Label", 1), ("Explanation", 2)] {
            out.push_str(&format!(
                "        public static string {method}({name} value) => value switch\n        {{\n"
            ));
            for (id, label, explanation) in &cases {
                let text = [*id, *label, *explanation][index];
                out.push_str(&format!(
                    "            {name}.{} => {},\n",
                    member(id),
                    quoted(text)
                ));
            }
            out.push_str("            _ => throw new ArgumentOutOfRangeException(nameof(value)),\n        };\n\n");
        }
    }
    out.push_str("        public static ProfileResolution ParseResolution(string value) => value switch\n        {\n");
    for (id, _) in fallback_rows() {
        out.push_str(&format!(
            "            {} => ProfileResolution.{},\n",
            quoted(id),
            member(id)
        ));
    }
    out.push_str("            _ => throw new ArgumentException(\"Unknown profile resolution\", nameof(value)),\n        };\n\n        public static LensSupport ParseLens(string value) => value switch\n        {\n");
    for (id, _, _) in &closed_enums()[1].1 {
        out.push_str(&format!(
            "            {} => LensSupport.{},\n",
            quoted(id),
            member(id)
        ));
    }
    out.push_str("            _ => throw new ArgumentException(\"Unknown lens support\", nameof(value)),\n        };\n\n        public static CameraTier TierForResolution(ProfileResolution resolution) => resolution switch\n        {\n");
    for (resolution, tier) in fallback_rows() {
        out.push_str(&format!(
            "            ProfileResolution.{} => CameraTier.{},\n",
            member(resolution),
            member(tier)
        ));
    }
    out.push_str("            _ => throw new ArgumentOutOfRangeException(nameof(resolution)),\n        };\n\n");
    out.push_str("        public static CameraTier TierFor(string key, ProfileResolution resolution)\n        {\n            var resolved = TierForResolution(resolution);\n            var measured = FixturedCameras.FirstOrDefault(body => body.Key == key);\n            return measured != null && (int)resolved >= (int)TierForResolution(measured.Resolution)\n                ? (CameraTier)Math.Max((int)measured.Tier, (int)resolved) : resolved;\n        }\n\n");
    out.push_str("        public static readonly IReadOnlyList<SupportedCamera> FixturedCameras = new SupportedCamera[]\n        {\n");
    for body in &registry.bodies {
        out.push_str(&format!(
            "            new({}, {}, {}, CameraTier.{}, LensSupport.{}, ProfileResolution.{}),\n",
            quoted(body.key),
            quoted(body.display_name),
            quoted(body.fixture),
            member(body.tier.id()),
            member(body.lens.id()),
            member(body.resolution.id())
        ));
    }
    out.push_str("        };\n    }\n}\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::support_tiers_summary::test_support::{evidence, registry};
    #[test]
    fn windows_vocabulary_and_rows_come_from_the_shared_registry() {
        let output = emit_cs(&registry(), &evidence());
        for (_, cases) in closed_enums() {
            for (_, label, explanation) in cases {
                assert!(output.contains(&quoted(label)));
                assert!(output.contains(&quoted(explanation)));
            }
        }
        for (resolution, _) in fallback_rows() {
            assert!(output.contains(&quoted(resolution)));
        }
        assert!(output.contains("TierFor(string key, ProfileResolution resolution)"));
        assert!(output.contains("CameraTier.DecodeOnly"));
        assert!(output.lines().all(|line| line == line.trim_end()));
    }
}
