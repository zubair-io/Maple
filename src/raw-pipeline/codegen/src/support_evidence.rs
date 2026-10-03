//! Actual measurement provenance for generated camera rows (#4081).
use raw_core::capability_registry::{Evidence, EvidenceRecord, Finding};

pub(crate) const SWIFT_TYPES: &str = "public struct CameraEvidenceRecord: Sendable {\n    public let gitSha: String\n    public let corpusHash: String\n    public let backend: String\n    public let pipelineVersion: UInt32\n    public let schemaVersion: UInt32\n}\n\npublic struct CameraQualificationEvidence: Sendable {\n    public let source: String\n    public let status: String\n    public let record: CameraEvidenceRecord?\n}\n\n";
pub(crate) const TS_TYPES: &str = "export interface CameraEvidenceRecord {\n  readonly gitSha: string;\n  readonly corpusHash: string;\n  readonly backend: string;\n  readonly pipelineVersion: number;\n  readonly schemaVersion: number;\n}\n\nexport interface CameraQualificationEvidence {\n  readonly source: string;\n  readonly status: string;\n  readonly record: CameraEvidenceRecord | null;\n}\n\n";
pub(crate) const CS_TYPES: &str = "    public sealed record CameraEvidenceRecord(string GitSha, string CorpusHash, string Backend, uint PipelineVersion, uint SchemaVersion);\n    public sealed record CameraQualificationEvidence(string Source, string Status, CameraEvidenceRecord? Record);\n\n";

/// JSON quoting also preserves arbitrary rejected record strings in TS/C#.
fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization")
}

fn swift_quoted(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn record<'a>(evidence: &'a Evidence, finding: &Finding) -> Option<&'a EvidenceRecord> {
    evidence.records.get(&finding.source)
}

pub(crate) fn swift(finding: &Finding, evidence: &Evidence) -> String {
    let value = record(evidence, finding).map_or("nil".to_owned(), |r| {
        format!("CameraEvidenceRecord(\n                        gitSha: {},\n                        corpusHash: {},\n                        backend: {},\n                        pipelineVersion: {},\n                        schemaVersion: {}\n                    )", swift_quoted(&r.git_sha), swift_quoted(&r.corpus_hash), swift_quoted(&r.backend), r.pipeline_version, r.schema_version)
    });
    format!("CameraQualificationEvidence(\n                    source: {},\n                    status: {},\n                    record: {value}\n                )", swift_quoted(finding.source.id()), swift_quoted(finding.status.id()))
}

fn ts_quoted(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    if escaped.contains('\'') && !escaped.contains('"') {
        format!("\"{escaped}\"")
    } else {
        format!("'{}'", escaped.replace('\'', "\\'"))
    }
}

pub(crate) fn ts(finding: &Finding, evidence: &Evidence) -> String {
    match record(evidence, finding) {
        None => format!("{{ source: {}, status: {}, record: null }}", ts_quoted(finding.source.id()), ts_quoted(finding.status.id())),
        Some(r) => format!("{{\n        source: {},\n        status: {},\n        record: {{\n          gitSha: {},\n          corpusHash: {},\n          backend: {},\n          pipelineVersion: {},\n          schemaVersion: {},\n        }},\n      }}", ts_quoted(finding.source.id()), ts_quoted(finding.status.id()), ts_quoted(&r.git_sha), ts_quoted(&r.corpus_hash), ts_quoted(&r.backend), r.pipeline_version, r.schema_version),
    }
}

pub(crate) fn cs(finding: &Finding, evidence: &Evidence) -> String {
    let value = record(evidence, finding).map_or("null".to_owned(), |r| {
        format!(
            "new CameraEvidenceRecord({}, {}, {}, {}, {})",
            quoted(&r.git_sha),
            quoted(&r.corpus_hash),
            quoted(&r.backend),
            r.pipeline_version,
            r.schema_version
        )
    });
    format!(
        "new CameraQualificationEvidence({}, {}, {value})",
        quoted(finding.source.id()),
        quoted(finding.status.id())
    )
}

pub(crate) fn json(finding: &Finding, evidence: &Evidence) -> crate::capability_summary::J {
    use crate::capability_summary::J;
    record(evidence, finding).map_or(J::Null, |r| {
        J::Obj(vec![
            ("git_sha", J::Str(r.git_sha.clone())),
            ("corpus_hash", J::Str(r.corpus_hash.clone())),
            ("backend", J::Str(r.backend.clone())),
            ("pipeline_version", J::Num(r.pipeline_version.into())),
            ("schema_version", J::Num(r.schema_version.into())),
        ])
    })
}

pub(crate) fn md(finding: &Finding, evidence: &Evidence) -> String {
    record(evidence, finding).map_or(String::new(), |r| {
        let commit = if r.git_sha.len() == 40 && r.git_sha.bytes().all(|c| c.is_ascii_hexdigit()) {
            format!("[{}](https://github.com/zubair-io/Maple/commit/{})", r.git_sha, r.git_sha)
        } else if r.git_sha.is_empty() { "unknown".to_owned() }
        else { format!("`{}`", r.git_sha) };
        format!("- `{}` measured record: commit {commit}, corpus `{}`, backend `{}`, pipeline v{}, schema v{}\n", finding.source.id(), r.corpus_hash, r.backend, r.pipeline_version, r.schema_version)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{support_tiers, support_tiers_cs, support_tiers_summary};
    use raw_core::capability_registry::{BuildIdentity, EvidenceSource};
    use raw_core::support_tiers::SupportRegistry;

    fn outputs(evidence: &Evidence) -> Vec<String> {
        let registry = SupportRegistry::compute(evidence);
        vec![
            support_tiers::emit_swift(&registry, evidence),
            support_tiers::emit_ts(&registry, evidence),
            support_tiers_cs::emit_cs(&registry, evidence),
            support_tiers_summary::emit_md(&registry, evidence),
            support_tiers_summary::emit_json(&registry, evidence),
        ]
    }

    #[test]
    fn absent_measurements_emit_null_without_inventing_identity() {
        let evidence = Evidence {
            build: Some(BuildIdentity::current()),
            ..Evidence::default()
        };
        let values = outputs(&evidence);
        assert!(values[0].contains("record: nil"));
        assert!(values[1].contains("record: null"));
        assert!(values[2].contains("\"missing\", null"));
        let json: serde_json::Value = serde_json::from_str(&values[4]).unwrap();
        for body in json["fixtured_bodies"].as_array().unwrap() {
            for finding in body["qualification"].as_array().unwrap() {
                assert!(finding["record"].is_null());
                assert_eq!(finding["status"], "missing");
            }
        }
    }

    #[test]
    fn actual_record_identity_survives_a_rejected_pipeline_verdict() {
        let build = BuildIdentity::current();
        let source = EvidenceSource::ColorHarness;
        let value = serde_json::json!({
            "source": source.id(), "backend": "cpu-reference",
            "pipeline_version": build.pipeline_version + 1,
            "schema_version": build.schema_version,
            "corpus_hash": format!("blake3:{}", "a".repeat(64)),
            "expected_cases": source.expected_cases(),
            "executed_cases": source.expected_cases(),
            "failed_cases": 0, "skipped_cases": 0,
            "git_sha": "1234567890123456789012345678901234567890",
        });
        let record = EvidenceRecord::from_json(&value.to_string()).unwrap();
        let evidence = Evidence {
            build: Some(build),
            records: [(source, record.clone())].into(),
            corpus_hashes: [(source, record.corpus_hash.clone())].into(),
        };
        let values = outputs(&evidence);
        for (index, output) in values.iter().enumerate() {
            assert!(output.contains(&record.git_sha));
            assert!(output.contains(&record.corpus_hash));
            if index != 3 {
                assert!(output.contains("stale_pipeline"));
            } else {
                assert!(output.contains("recorded on pipeline"));
            }
        }
        let json: serde_json::Value = serde_json::from_str(&values[4]).unwrap();
        for body in json["fixtured_bodies"].as_array().unwrap() {
            assert_ne!(body["tier"], "qualified");
            for finding in body["qualification"].as_array().unwrap() {
                assert_eq!(
                    finding["record"]["pipeline_version"],
                    record.pipeline_version
                );
                assert_eq!(finding["record"]["git_sha"], record.git_sha);
                assert_eq!(finding["record"]["backend"], record.backend);
            }
            assert_eq!(
                body["profile_bundle_digest"],
                json["build"]["profile_bundle_digest"]
            );
        }
    }

    #[test]
    fn record_strings_are_escaped_for_each_consumer() {
        assert_eq!(swift_quoted("x\n\"\\\u{1}"), "\"x\\n\\\"\\\\\\u{1}\"");
        assert_eq!(ts_quoted("camera's"), "\"camera's\"");
        assert_eq!(quoted("x\n\"\\"), "\"x\\n\\\"\\\\\"");
    }
}
