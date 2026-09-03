//! Evidence records and the release-state rule (#2430).
//!
//! An [`EvidenceRecord`] is what a harness writes after one complete run
//! (`tools/qualification/record.sh` → `test-fixtures/qualification/
//! <source>.json`). [`classify`] turns a capability's declared sources plus
//! the records on disk into a [`Classification`]: the computed
//! [`ReleaseState`] and one [`Finding`] per declared source saying exactly
//! why it did or did not count. Nothing here reads product age, issue
//! counts, or code presence — only records.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{Capability, EvidenceSource, ReleaseState, Surface};

/// The build the registry is evaluated for. A record pinned to different
/// numbers is stale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildIdentity {
    /// `raw_core::PIPELINE_OUTPUT_VERSION` at generation time.
    pub pipeline_version: u32,
    /// [`super::current_schema_version`] at generation time.
    pub schema_version: u32,
}

impl BuildIdentity {
    /// The identity of the crate this code was compiled from.
    pub fn current() -> Self {
        Self {
            pipeline_version: crate::PIPELINE_OUTPUT_VERSION,
            schema_version: super::current_schema_version(),
        }
    }
}

/// One harness run, as written to `test-fixtures/qualification/<source>.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvidenceRecord {
    pub source: EvidenceSource,
    pub backend: String,
    pub pipeline_version: u32,
    pub schema_version: u32,
    /// `blake3:<hex>` over the source's declared corpus — see [`hash_corpus`].
    pub corpus_hash: String,
    pub expected_cases: u32,
    pub executed_cases: u32,
    pub failed_cases: u32,
    pub skipped_cases: u32,
    /// Commit the run was made on. Informational: not part of the rule.
    pub git_sha: String,
    /// RFC 3339 timestamp of the run. Informational: not part of the rule.
    pub recorded_at: String,
    /// The exact command the harness ran. Informational.
    pub command: String,
}

impl EvidenceRecord {
    /// Parse a record from its JSON text. Every load-bearing field is
    /// required; a malformed record is an error, not a silent miss.
    pub fn from_json(text: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("invalid JSON: {e}"))?;
        let str_field = |k: &str| -> Result<String, String> {
            v.get(k)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("missing string field `{k}`"))
        };
        let u32_field = |k: &str| -> Result<u32, String> {
            v.get(k)
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| format!("missing or out-of-range integer field `{k}`"))
        };
        // Informational fields may be absent or null, but a present value
        // of the wrong type is still a malformed record.
        let optional_str = |k: &str| -> Result<String, String> {
            match v.get(k) {
                None | Some(Value::Null) => Ok(String::new()),
                Some(Value::String(s)) => Ok(s.clone()),
                Some(_) => Err(format!("field `{k}` must be a string when present")),
            }
        };
        let source_id = str_field("source")?;
        let source = EvidenceSource::from_id(&source_id)
            .ok_or_else(|| format!("unknown evidence source `{source_id}`"))?;
        Ok(Self {
            source,
            backend: str_field("backend")?,
            pipeline_version: u32_field("pipeline_version")?,
            schema_version: u32_field("schema_version")?,
            corpus_hash: str_field("corpus_hash")?,
            expected_cases: u32_field("expected_cases")?,
            executed_cases: u32_field("executed_cases")?,
            failed_cases: u32_field("failed_cases")?,
            skipped_cases: u32_field("skipped_cases")?,
            git_sha: optional_str("git_sha")?,
            recorded_at: optional_str("recorded_at")?,
            command: optional_str("command")?,
        })
    }

    /// Serialize in the canonical key order the writer emits.
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "source": self.source.id(),
            "backend": self.backend,
            "pipeline_version": self.pipeline_version,
            "schema_version": self.schema_version,
            "corpus_hash": self.corpus_hash,
            "expected_cases": self.expected_cases,
            "executed_cases": self.executed_cases,
            "failed_cases": self.failed_cases,
            "skipped_cases": self.skipped_cases,
            "git_sha": self.git_sha,
            "recorded_at": self.recorded_at,
            "command": self.command,
        })
    }

    /// The fields the rule reads — everything except the informational
    /// `git_sha` / `recorded_at` / `command`. Two records that agree here
    /// are the same evidence.
    pub fn load_bearing(&self) -> (EvidenceSource, &str, u32, u32, &str, u32, u32, u32, u32) {
        (
            self.source,
            &self.backend,
            self.pipeline_version,
            self.schema_version,
            &self.corpus_hash,
            self.expected_cases,
            self.executed_cases,
            self.failed_cases,
            self.skipped_cases,
        )
    }
}

/// Everything [`classify`] needs: the records on disk, the build they are
/// judged against, and the current corpus hash per source.
#[derive(Clone, Debug, Default)]
pub struct Evidence {
    pub records: BTreeMap<EvidenceSource, EvidenceRecord>,
    pub build: Option<BuildIdentity>,
    pub corpus_hashes: BTreeMap<EvidenceSource, String>,
}

impl Evidence {
    /// Load every `<source>.json` under `dir` and hash the corpus (under
    /// `repo_root`) of every source that has one. A missing directory is an
    /// empty evidence set (every capability stays `Core`); an unparseable
    /// record or an unhashable corpus is an error.
    pub fn load(repo_root: &Path, dir: &Path) -> Result<Self, String> {
        let mut records = BTreeMap::new();
        for source in EvidenceSource::ALL {
            let path = dir.join(format!("{}.json", source.id()));
            if !path.exists() {
                continue;
            }
            let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let record =
                EvidenceRecord::from_json(&text).map_err(|e| format!("{}: {e}", path.display()))?;
            if record.source != *source {
                return Err(format!(
                    "{}: record names source `{}` but the file is `{}`",
                    path.display(),
                    record.source.id(),
                    source.id()
                ));
            }
            records.insert(*source, record);
        }
        // A corpus hash is only ever compared against a record, so only the
        // recorded sources are hashed — `tools/codegen.sh` loads evidence
        // once per emitted target, and the corpora include binary fixtures.
        let corpus_hashes = records
            .keys()
            .map(|s| hash_corpus(repo_root, s.corpus()).map(|h| (*s, h)))
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        Ok(Self {
            records,
            build: Some(BuildIdentity::current()),
            corpus_hashes,
        })
    }
}

/// `blake3:<hex>` over the concatenated contents of `paths` (repo-relative;
/// a directory contributes every file under it in sorted path order). Text
/// files have their CR bytes dropped before hashing so a CRLF checkout on
/// Windows hashes the same corpus as a LF checkout; binary files (any NUL
/// byte in the first 8 KiB — the `.dng` / `.png` fixtures) are hashed byte
/// for byte, since a 0x0D there is data, not a line ending. A missing path
/// is an error — a corpus that has disappeared is not "unchanged".
pub fn hash_corpus(repo_root: &Path, paths: &[&str]) -> Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    for rel in paths {
        let root = repo_root.join(rel);
        for file in walk_sorted(&root)? {
            let bytes = fs::read(&file).map_err(|e| format!("{}: {e}", file.display()))?;
            let stripped: Vec<u8> = if is_binary(&bytes) {
                bytes
            } else {
                bytes.into_iter().filter(|b| *b != b'\r').collect()
            };
            let rel_name = file
                .strip_prefix(repo_root)
                .unwrap_or(&file)
                .to_string_lossy()
                .replace('\\', "/");
            hasher.update(rel_name.as_bytes());
            hasher.update(&[0]);
            hasher.update(&(stripped.len() as u64).to_le_bytes());
            hasher.update(&stripped);
        }
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

/// Git's own heuristic: a NUL byte in the first 8 KiB means binary.
fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

fn walk_sorted(path: &Path) -> Result<Vec<PathBuf>, String> {
    if path.is_file() {
        return Ok(vec![path.to_path_buf()]);
    }
    if !path.is_dir() {
        return Err(format!("corpus path does not exist: {}", path.display()));
    }
    let mut entries: Vec<PathBuf> = fs::read_dir(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .map(|e| {
            e.map(|e| e.path())
                .map_err(|e| format!("{}: {e}", path.display()))
        })
        .collect::<Result<_, _>>()?;
    entries.sort();
    entries.iter().try_fold(Vec::new(), |mut acc, e| {
        acc.extend(walk_sorted(e)?);
        Ok(acc)
    })
}

/// Why a declared source did or did not count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordStatus {
    /// No `<source>.json` record exists.
    Missing,
    /// The record was made on a different pipeline output version.
    StalePipeline { recorded: u32, current: u32 },
    /// The record was made on a different sidecar schema version.
    StaleSchema { recorded: u32, current: u32 },
    /// The corpus changed since the record was written.
    StaleCorpus,
    /// The record claims a backend the source does not accept.
    UnacceptedBackend(String),
    /// The record's expected count disagrees with the registry's, or the
    /// run executed a different number of cases than expected.
    CountMismatch { expected: u32, executed: u32 },
    /// Zero cases were expected or executed — a green run that compared
    /// nothing is not evidence (#1082).
    Vacuous,
    /// At least one case failed.
    Failed(u32),
    /// At least one case was skipped.
    Skipped(u32),
    /// The record satisfies the source.
    Satisfied,
}

impl RecordStatus {
    /// Stable identifier for the machine-readable summary.
    pub fn id(&self) -> &'static str {
        match self {
            RecordStatus::Missing => "missing",
            RecordStatus::StalePipeline { .. } => "stale_pipeline",
            RecordStatus::StaleSchema { .. } => "stale_schema",
            RecordStatus::StaleCorpus => "stale_corpus",
            RecordStatus::UnacceptedBackend(_) => "unaccepted_backend",
            RecordStatus::CountMismatch { .. } => "count_mismatch",
            RecordStatus::Vacuous => "vacuous",
            RecordStatus::Failed(_) => "failed",
            RecordStatus::Skipped(_) => "skipped",
            RecordStatus::Satisfied => "satisfied",
        }
    }

    /// Human sentence for the markdown summary.
    pub fn describe(&self) -> String {
        match self {
            RecordStatus::Missing => "no record".to_owned(),
            RecordStatus::StalePipeline { recorded, current } => {
                format!("recorded on pipeline v{recorded}, current is v{current}")
            }
            RecordStatus::StaleSchema { recorded, current } => {
                format!("recorded on schema v{recorded}, current is v{current}")
            }
            RecordStatus::StaleCorpus => "corpus changed since the record".to_owned(),
            RecordStatus::UnacceptedBackend(b) => format!("backend `{b}` not accepted"),
            RecordStatus::CountMismatch { expected, executed } => {
                format!("executed {executed} of {expected} expected cases")
            }
            RecordStatus::Vacuous => "zero cases".to_owned(),
            RecordStatus::Failed(n) => format!("{n} failed"),
            RecordStatus::Skipped(n) => format!("{n} skipped"),
            RecordStatus::Satisfied => "satisfied".to_owned(),
        }
    }

    pub fn is_satisfied(&self) -> bool {
        *self == RecordStatus::Satisfied
    }
}

/// The verdict for one declared source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Finding {
    pub source: EvidenceSource,
    pub status: RecordStatus,
}

/// A capability's computed state plus the per-source reasoning.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classification {
    pub state: ReleaseState,
    pub integration: Vec<Finding>,
    pub qualification: Vec<Finding>,
}

/// Judge one source's record against what the registry declares today.
pub fn judge(source: EvidenceSource, evidence: &Evidence) -> RecordStatus {
    let Some(record) = evidence.records.get(&source) else {
        return RecordStatus::Missing;
    };
    let Some(build) = evidence.build else {
        return RecordStatus::Missing;
    };
    if record.pipeline_version != build.pipeline_version {
        return RecordStatus::StalePipeline {
            recorded: record.pipeline_version,
            current: build.pipeline_version,
        };
    }
    if record.schema_version != build.schema_version {
        return RecordStatus::StaleSchema {
            recorded: record.schema_version,
            current: build.schema_version,
        };
    }
    if evidence.corpus_hashes.get(&source) != Some(&record.corpus_hash) {
        return RecordStatus::StaleCorpus;
    }
    if !source
        .accepted_backends()
        .contains(&record.backend.as_str())
    {
        return RecordStatus::UnacceptedBackend(record.backend.clone());
    }
    let expected = source.expected_cases();
    if expected == 0 || record.executed_cases == 0 {
        return RecordStatus::Vacuous;
    }
    if record.expected_cases != expected || record.executed_cases != expected {
        return RecordStatus::CountMismatch {
            expected,
            executed: record.executed_cases,
        };
    }
    if record.failed_cases > 0 {
        return RecordStatus::Failed(record.failed_cases);
    }
    if record.skipped_cases > 0 {
        return RecordStatus::Skipped(record.skipped_cases);
    }
    RecordStatus::Satisfied
}

fn findings(sources: &[EvidenceSource], evidence: &Evidence) -> Vec<Finding> {
    sources
        .iter()
        .map(|s| Finding {
            source: *s,
            status: judge(*s, evidence),
        })
        .collect()
}

/// A tier is met when every declared source is satisfied AND every
/// declared surface is covered by at least one satisfied source. An empty
/// tier is never met — silence is not evidence.
fn tier_met(surfaces: &[Surface], findings: &[Finding]) -> bool {
    let all_satisfied = !findings.is_empty() && findings.iter().all(|f| f.status.is_satisfied());
    let every_surface_covered = surfaces.iter().all(|surface| {
        findings
            .iter()
            .any(|f| f.status.is_satisfied() && f.source.covers().contains(surface))
    });
    all_satisfied && every_surface_covered
}

/// Compute a capability's release state from the evidence.
pub fn classify(capability: &Capability, evidence: &Evidence) -> Classification {
    let integration = findings(capability.integration, evidence);
    let qualification = findings(capability.qualification, evidence);
    let surfaced = !capability.surfaces.is_empty();
    let integrated = surfaced && tier_met(capability.surfaces, &integration);
    let qualified = integrated && tier_met(capability.surfaces, &qualification);
    let state = match (integrated, qualified) {
        (true, true) => ReleaseState::Released,
        (true, false) => ReleaseState::Integrated,
        (false, _) => ReleaseState::Core,
    };
    Classification {
        state,
        integration,
        qualification,
    }
}
