//! The keyword leg: a Tantivy index of two texts per asset, English-stemmed,
//! ranked with BM25. The index is a rebuildable cache of the API's SQLite
//! rows, so nothing here is the source of truth for any asset.
//!
//! The two texts are the embedder template (what the vector leg embedded) and
//! the API's `search_blob`, which adds the structured vision fields (subjects,
//! setting, activity, objects, tags) the template leaves out. They are separate
//! fields so each keeps its own length normalisation: a template match scores
//! as it did before the blob was indexed, and the blob — a sorted, deduplicated
//! bag that repeats most of the template — adds a down-weighted second score.
//!
//! Text is analysed like the API's FTS5 table (`unicode61`, diacritics
//! removed, porter stemming): split on non-alphanumerics, lowercased,
//! ASCII-folded and stemmed, at index and query time alike, so `cafe` and
//! `café` find each other. Like `unicode61` there is no token length limit
//! (the stock `en_stem` drops tokens over 40 bytes), so long filenames and
//! OCR identifiers stay findable.

use crate::error::{Result, SearchError};
use crate::score_floor::ScoreFloor;
use crate::terms::TextQuery;
use crate::vectors::ScoredId;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tantivy::collector::{DocSetCollector, TopDocs};
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, BoostQuery, Occur, PhraseQuery, Query, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, FAST, STORED, STRING,
};
use tantivy::tokenizer::{
    AsciiFoldingFilter, Language, LowerCaser, SimpleTokenizer, Stemmer, TextAnalyzer,
};
use tantivy::{
    doc, DocAddress, Index, IndexReader, IndexWriter, ReloadPolicy, Searcher, TantivyDocument, Term,
};

const TOKENIZER: &str = "maple_en_folded";
/// BM25 sums can differ in the last bits between Tantivy's pruned top-k pass
/// and a full scoring pass, so the boundary is lowered by this relative margin
/// to be sure every hit tied with it is collected; the final sort and cut use
/// the full pass's scores alone.
const BOUNDARY_TOLERANCE: f32 = 1e-5;
const WRITER_MEMORY_BYTES: usize = 256 * 1024 * 1024;
/// The blob's BM25 weight against the template's 1.0. Meilisearch ranked
/// `searchBlob` as its lowest-weight attribute; a term in both texts still
/// outranks one found only among the vision tags.
pub const BLOB_BOOST: f32 = 0.5;

/// One asset's indexed text: the embedder template and its `search_blob`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SearchText<'a> {
    pub template: &'a str,
    pub blob: &'a str,
}

impl<'a> From<&'a str> for SearchText<'a> {
    fn from(template: &'a str) -> Self {
        Self { template, blob: "" }
    }
}

pub struct TextIndex {
    path: PathBuf,
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    id: Field,
    text: Field,
    blob: Field,
}

fn schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("id", STRING | STORED | FAST);
    let analysed = TextOptions::default().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(TOKENIZER)
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    );
    builder.add_text_field("text", analysed.clone());
    builder.add_text_field("blob", analysed);
    builder.build()
}

fn analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(LowerCaser)
        .filter(AsciiFoldingFilter)
        .filter(Stemmer::new(Language::English))
        .build()
}

impl TextIndex {
    /// Opens the index under `path`, creating an empty one if none exists.
    pub fn open(path: &Path) -> Result<Self> {
        let at_path = |message: String| SearchError::TextIndex {
            path: path.to_path_buf(),
            message,
        };
        std::fs::create_dir_all(path).map_err(|e| at_path(e.to_string()))?;
        let directory = MmapDirectory::open(path).map_err(|e| at_path(e.to_string()))?;
        let index = Index::open_or_create(directory, schema())?;
        index.tokenizers().register(TOKENIZER, analyzer());
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;
        let writer = index.writer(WRITER_MEMORY_BYTES)?;
        let field = |name: &str| {
            index
                .schema()
                .get_field(name)
                .map_err(|e| at_path(e.to_string()))
        };
        Ok(Self {
            id: field("id")?,
            text: field("text")?,
            blob: field("blob")?,
            path: path.to_path_buf(),
            index,
            reader,
            writer: Mutex::new(writer),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn num_docs(&self) -> u64 {
        self.reader.searcher().num_docs()
    }

    /// Stages a replace of `id`'s texts; visible to searches after [`Self::commit`].
    pub fn upsert<'a>(&self, id: &str, text: impl Into<SearchText<'a>>) -> Result<()> {
        let writer = self.lock_writer();
        writer.delete_term(Term::from_field_text(self.id, id));
        writer.add_document(self.document(id, text.into()))?;
        Ok(())
    }

    fn document(&self, id: &str, text: SearchText<'_>) -> TantivyDocument {
        doc!(self.id => id, self.text => text.template, self.blob => text.blob)
    }

    /// Stages a delete of `id`; visible to searches after [`Self::commit`].
    pub fn delete(&self, id: &str) {
        self.lock_writer()
            .delete_term(Term::from_field_text(self.id, id));
    }

    /// Stages removal of every document; visible after [`Self::commit`].
    pub fn clear(&self) -> Result<()> {
        self.lock_writer().delete_all_documents()?;
        Ok(())
    }

    pub fn commit(&self) -> Result<()> {
        self.lock_writer().commit()?;
        self.reader.reload()?;
        Ok(())
    }

    /// Replaces the whole index with `docs` and commits. Searches keep
    /// answering from the previous contents until the commit lands.
    pub fn rebuild<'a, T: Into<SearchText<'a>>>(
        &self,
        docs: impl IntoIterator<Item = (&'a str, T)>,
    ) -> Result<u64> {
        let mut writer = self.lock_writer();
        writer.delete_all_documents()?;
        for (id, text) in docs {
            writer.add_document(self.document(id, text.into()))?;
        }
        writer.commit()?;
        drop(writer);
        self.reader.reload()?;
        Ok(self.num_docs())
    }

    /// BM25 top `limit` for a parsed query: every required phrase must match,
    /// at least one optional term must match, no excluded term may match.
    pub fn search(&self, query: &TextQuery, limit: usize) -> Result<Vec<ScoredId>> {
        let TextQuery::Terms {
            required_phrases,
            optional_terms,
            excluded,
        } = query
        else {
            return Ok(Vec::new());
        };
        let Some(required) = required_phrases
            .iter()
            .map(|phrase| self.phrase_query(phrase))
            .collect::<Option<Vec<_>>>()
        else {
            return Ok(Vec::new());
        };
        let optional: Vec<(Occur, Box<dyn Query>)> = optional_terms
            .iter()
            .filter_map(|term| self.phrase_query(term))
            .map(|query| (Occur::Should, query))
            .collect();
        if limit == 0 || (!optional_terms.is_empty() && optional.is_empty()) {
            return Ok(Vec::new());
        }
        let clauses: Vec<(Occur, Box<dyn Query>)> = required
            .into_iter()
            .map(|query| (Occur::Must, query))
            .chain((!optional.is_empty()).then(|| {
                (
                    Occur::Must,
                    Box::new(BooleanQuery::new(optional)) as Box<dyn Query>,
                )
            }))
            .chain(self.excluded_clauses(excluded, Occur::MustNot))
            .collect();
        let query = BooleanQuery::new(clauses);
        let searcher = self.reader.searcher();
        let top = searcher.search(&query, &TopDocs::with_limit(limit).order_by_score())?;
        let hits = match top.get(limit - 1) {
            Some(&(boundary, _)) => searcher.search(
                &query,
                &ScoreFloor(boundary - boundary.abs() * BOUNDARY_TOLERANCE),
            )?,
            None => top,
        };
        let ids = self.ids_of(&searcher, hits.iter().map(|&(_, address)| address))?;
        let mut scored: Vec<ScoredId> = hits
            .into_iter()
            .zip(ids)
            .map(|((score, _), id)| ScoredId { id, score })
            .collect();
        scored.sort_by(|a, b| b.score.total_cmp(&a.score).then_with(|| a.id.cmp(&b.id)));
        scored.truncate(limit);
        Ok(scored)
    }

    /// Every id whose texts contain any of the `excluded` terms or phrases,
    /// read from the id fast field rather than the document store.
    pub fn ids_matching_any(&self, excluded: &[String]) -> Result<Vec<String>> {
        let exclusions = self.excluded_clauses(excluded, Occur::Should);
        if exclusions.is_empty() {
            return Ok(Vec::new());
        }
        let searcher = self.reader.searcher();
        let docs = searcher.search(&BooleanQuery::new(exclusions), &DocSetCollector)?;
        self.ids_of(&searcher, docs)
    }

    /// The ids of `addresses`, in order, from the id fast field.
    fn ids_of(
        &self,
        searcher: &Searcher,
        addresses: impl IntoIterator<Item = DocAddress>,
    ) -> Result<Vec<String>> {
        let columns = searcher
            .segment_readers()
            .iter()
            .map(|segment| segment.fast_fields().str("id"))
            .collect::<tantivy::Result<Vec<_>>>()?;
        addresses
            .into_iter()
            .map(|address| {
                let mut id = String::new();
                let found = columns[address.segment_ord as usize]
                    .as_ref()
                    .and_then(|column| {
                        let ord = column.term_ords(address.doc_id).next()?;
                        Some(column.ord_to_str(ord, &mut id))
                    })
                    .transpose()
                    .map_err(|e| self.error(e.to_string()))?;
                match found {
                    Some(true) => Ok(id),
                    _ => Err(self.error(format!("document {address:?} has no id"))),
                }
            })
            .collect()
    }

    fn excluded_clauses(&self, excluded: &[String], occur: Occur) -> Vec<(Occur, Box<dyn Query>)> {
        excluded
            .iter()
            .filter_map(|text| self.phrase_query(text))
            .map(|query| (occur, query))
            .collect()
    }

    /// `text` analysed the way both fields were indexed and matched in
    /// either, scored as the template's match plus the blob's down-weighted
    /// one. `None` when the analyser drops every token, because nothing in the
    /// index can match it.
    fn phrase_query(&self, text: &str) -> Option<Box<dyn Query>> {
        let mut tokens = Vec::new();
        let mut analyzer = self.index.tokenizers().get(TOKENIZER)?;
        analyzer
            .token_stream(text)
            .process(&mut |token| tokens.push(token.text.clone()));
        if tokens.is_empty() {
            return None;
        }
        let blob = BoostQuery::new(field_phrase(self.blob, &tokens), BLOB_BOOST);
        Some(Box::new(BooleanQuery::new(vec![
            (Occur::Should, field_phrase(self.text, &tokens)),
            (Occur::Should, Box::new(blob)),
        ])))
    }

    fn error(&self, message: String) -> SearchError {
        SearchError::TextIndex {
            path: self.path.clone(),
            message,
        }
    }

    fn lock_writer(&self) -> std::sync::MutexGuard<'_, IndexWriter> {
        self.writer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// One token is a term query, several are a phrase that must be adjacent.
fn field_phrase(field: Field, tokens: &[String]) -> Box<dyn Query> {
    let mut terms: Vec<Term> = tokens
        .iter()
        .map(|token| Term::from_field_text(field, token))
        .collect();
    if terms.len() == 1 {
        Box::new(TermQuery::new(
            terms.remove(0),
            IndexRecordOption::WithFreqs,
        ))
    } else {
        Box::new(PhraseQuery::new(terms))
    }
}

#[cfg(test)]
#[path = "text_index_tests.rs"]
mod tests;
