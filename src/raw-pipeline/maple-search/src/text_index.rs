//! The keyword leg: a Tantivy index of one text blob per asset, English-stemmed,
//! ranked with BM25. The index is a rebuildable cache of the API's SQLite
//! rows, so nothing here is the source of truth for any asset.
//!
//! Text is analysed like the API's FTS5 table (`unicode61`, diacritics
//! removed, porter stemming): split on non-alphanumerics, lowercased,
//! ASCII-folded and stemmed, at index and query time alike, so `cafe` and
//! `café` find each other.

use crate::error::{Result, SearchError};
use crate::terms::TextQuery;
use crate::vectors::ScoredId;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tantivy::collector::{DocSetCollector, TopDocs};
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, Occur, PhraseQuery, Query, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, FAST, STORED, STRING,
};
use tantivy::tokenizer::{
    AsciiFoldingFilter, Language, LowerCaser, RemoveLongFilter, SimpleTokenizer, Stemmer,
    TextAnalyzer,
};
use tantivy::{
    doc, DocAddress, Index, IndexReader, IndexWriter, ReloadPolicy, Searcher, TantivyDocument, Term,
};

const TOKENIZER: &str = "maple_en_folded";
const MAX_TOKEN_BYTES: usize = 40;
const WRITER_MEMORY_BYTES: usize = 256 * 1024 * 1024;

pub struct TextIndex {
    path: PathBuf,
    index: Index,
    reader: IndexReader,
    writer: Mutex<IndexWriter>,
    id: Field,
    text: Field,
}

fn schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("id", STRING | STORED | FAST);
    builder.add_text_field(
        "text",
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(TOKENIZER)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        ),
    );
    builder.build()
}

fn analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(RemoveLongFilter::limit(MAX_TOKEN_BYTES))
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

    /// Stages a replace of `id`'s text; visible to searches after [`Self::commit`].
    pub fn upsert(&self, id: &str, text: &str) -> Result<()> {
        let writer = self.lock_writer();
        writer.delete_term(Term::from_field_text(self.id, id));
        writer.add_document(doc!(self.id => id, self.text => text))?;
        Ok(())
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
    pub fn rebuild<'a>(&self, docs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Result<u64> {
        let mut writer = self.lock_writer();
        writer.delete_all_documents()?;
        for (id, text) in docs {
            writer.add_document(doc!(self.id => id, self.text => text))?;
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
        let searcher = self.reader.searcher();
        let top = searcher.search(
            &BooleanQuery::new(clauses),
            &TopDocs::with_limit(limit).order_by_score(),
        )?;
        top.into_iter()
            .map(|(score, address)| {
                Ok(ScoredId {
                    id: self.stored_id(&searcher, address)?,
                    score,
                })
            })
            .collect()
    }

    /// Every id whose text contains any of the `excluded` terms or phrases,
    /// read from the id fast field rather than the document store.
    pub fn ids_matching_any(&self, excluded: &[String]) -> Result<Vec<String>> {
        let exclusions = self.excluded_clauses(excluded, Occur::Should);
        if exclusions.is_empty() {
            return Ok(Vec::new());
        }
        let searcher = self.reader.searcher();
        let docs = searcher.search(&BooleanQuery::new(exclusions), &DocSetCollector)?;
        let columns = searcher
            .segment_readers()
            .iter()
            .map(|segment| segment.fast_fields().str("id"))
            .collect::<tantivy::Result<Vec<_>>>()?;
        docs.into_iter()
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

    /// `text` analysed the way the field was indexed: one token is a term
    /// query, several are a phrase, none (all dropped by the analyser) is
    /// `None` because nothing in the index can match it.
    fn phrase_query(&self, text: &str) -> Option<Box<dyn Query>> {
        let mut terms = Vec::new();
        let mut analyzer = self.index.tokenizers().get(TOKENIZER)?;
        analyzer
            .token_stream(text)
            .process(&mut |token| terms.push(Term::from_field_text(self.text, &token.text)));
        match terms.len() {
            0 => None,
            1 => Some(Box::new(TermQuery::new(
                terms.remove(0),
                IndexRecordOption::WithFreqs,
            ))),
            _ => Some(Box::new(PhraseQuery::new(terms))),
        }
    }

    fn stored_id(&self, searcher: &Searcher, address: DocAddress) -> Result<String> {
        let document: TantivyDocument = searcher.doc(address)?;
        document
            .get_first(self.id)
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .ok_or_else(|| self.error(format!("document {address:?} has no stored id")))
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

#[cfg(test)]
#[path = "text_index_tests.rs"]
mod tests;
