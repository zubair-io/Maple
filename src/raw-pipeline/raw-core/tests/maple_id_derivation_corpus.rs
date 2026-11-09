//! The cross-client derivation corpus (#5079): each file's primary form is
//! hashed from the capture date the server's `readExif` produced (no date
//! selects the fallback form). Pinned by `tests/maple-id-contract.test.ts`,
//! `MapleIdDerivationContractTests` and the web contract spec too.

use raw_core::MapleId;

#[test]
fn derivation_corpus_matches_the_server() {
    let ids = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test-fixtures/ids");
    let corpus: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(ids.join("derivation.json")).unwrap())
            .unwrap();
    for case in corpus["cases"].as_array().unwrap() {
        let file = case["file"].as_str().unwrap();
        let bytes = std::fs::read(ids.join(file)).unwrap();
        let id = match case["capturedAt"].as_str() {
            Some(captured_at) => MapleId::primary(&bytes, captured_at, None, None),
            None => MapleId::fallback(&bytes, bytes.len() as u64),
        };
        assert_eq!(id.to_hex(), case["id"].as_str().unwrap(), "{file}");
    }
}
