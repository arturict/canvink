use rusqlite::{params, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{storage::Database, CommandError, StorageError};

const MAX_SEARCH_ROWS: usize = 100_000;
const MAX_SEARCH_FIELD_BYTES: usize = 512 * 1024;
const MAX_SEARCH_ROW_BYTES: usize = 2 * 1024 * 1024;
const MAX_QUERY_BYTES: usize = 512;
const MAX_QUERY_TOKENS: usize = 24;
const MAX_QUERY_TOKEN_CHARS: usize = 96;
const DEFAULT_RESULT_LIMIT: u32 = 25;
const MAX_RESULT_LIMIT: u32 = 100;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchProjectionRow {
    document_id: String,
    page_id: String,
    title: String,
    body: String,
    tags: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryResult {
    document_id: String,
    page_id: String,
    title: String,
    title_snippet: String,
    body_snippet: String,
    tags_snippet: String,
    score: f64,
}

fn validate_identifier(value: &str, field: &str) -> Result<(), StorageError> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(StorageError::InvalidV2(format!(
            "search projection {field} must contain 1 to 256 bytes"
        )));
    }
    Ok(())
}

fn validate_projection(row: &SearchProjectionRow) -> Result<(), StorageError> {
    validate_identifier(&row.document_id, "documentId")?;
    validate_identifier(&row.page_id, "pageId")?;

    let fields = [
        ("title", row.title.len()),
        ("body", row.body.len()),
        ("tags", row.tags.len()),
    ];
    for (field, bytes) in fields {
        if bytes > MAX_SEARCH_FIELD_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "search projection {field} exceeds {MAX_SEARCH_FIELD_BYTES} bytes"
            )));
        }
    }
    let total = fields
        .iter()
        .try_fold(0usize, |total, (_, bytes)| total.checked_add(*bytes))
        .ok_or_else(|| StorageError::LimitExceeded("search projection size overflowed".into()))?;
    if total > MAX_SEARCH_ROW_BYTES {
        return Err(StorageError::LimitExceeded(format!(
            "search projection exceeds {MAX_SEARCH_ROW_BYTES} bytes"
        )));
    }
    Ok(())
}

fn fts_query(query: &str) -> Result<String, StorageError> {
    if query.trim().is_empty() || query.len() > MAX_QUERY_BYTES {
        return Err(StorageError::InvalidV2(format!(
            "search query must contain 1 to {MAX_QUERY_BYTES} bytes"
        )));
    }

    let mut tokens = Vec::new();
    let mut current = String::new();
    for character in query.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if current.chars().count() < MAX_QUERY_TOKEN_CHARS {
                current.push(character);
            }
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
            if tokens.len() == MAX_QUERY_TOKENS {
                break;
            }
        }
    }
    if !current.is_empty() && tokens.len() < MAX_QUERY_TOKENS {
        tokens.push(current);
    }
    tokens.sort();
    tokens.dedup();

    if tokens.is_empty() {
        return Err(StorageError::InvalidV2(
            "search query does not contain searchable letters or numbers".into(),
        ));
    }
    Ok(tokens
        .into_iter()
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND "))
}

impl Database {
    pub fn search_v2_replace(&self, rows: Vec<SearchProjectionRow>) -> Result<(), StorageError> {
        if rows.len() > MAX_SEARCH_ROWS {
            return Err(StorageError::LimitExceeded(format!(
                "search rebuild exceeds {MAX_SEARCH_ROWS} rows"
            )));
        }
        for row in &rows {
            validate_projection(row)?;
        }

        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("DELETE FROM search_v2", [])?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO search_v2(document_id, page_id, title, body, tags) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for row in rows {
                statement.execute(params![
                    row.document_id,
                    row.page_id,
                    row.title,
                    row.body,
                    row.tags
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn search_v2_upsert(&self, row: SearchProjectionRow) -> Result<(), StorageError> {
        validate_projection(&row)?;
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM search_v2 WHERE document_id = ?1",
            params![row.document_id],
        )?;
        transaction.execute(
            "INSERT INTO search_v2(document_id, page_id, title, body, tags) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![row.document_id, row.page_id, row.title, row.body, row.tags],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn search_v2_remove(&self, document_id: &str) -> Result<(), StorageError> {
        validate_identifier(document_id, "documentId")?;
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        self.connect()?.execute(
            "DELETE FROM search_v2 WHERE document_id = ?1",
            params![document_id],
        )?;
        Ok(())
    }

    pub fn search_v2_clear(&self) -> Result<(), StorageError> {
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        self.connect()?.execute("DELETE FROM search_v2", [])?;
        Ok(())
    }

    pub fn search_v2_query(
        &self,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Vec<SearchQueryResult>, StorageError> {
        let query = fts_query(query)?;
        let limit = limit
            .unwrap_or(DEFAULT_RESULT_LIMIT)
            .clamp(1, MAX_RESULT_LIMIT);
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            r#"
            SELECT document_id,
                   page_id,
                   title,
                   snippet(search_v2, 2, '<mark>', '</mark>', ' … ', 18),
                   snippet(search_v2, 3, '<mark>', '</mark>', ' … ', 28),
                   snippet(search_v2, 4, '<mark>', '</mark>', ' … ', 18),
                   -bm25(search_v2, 0.0, 0.0, 12.0, 3.0, 8.0) AS score
            FROM search_v2
            WHERE search_v2 MATCH ?1
            ORDER BY score DESC, document_id ASC
            LIMIT ?2
            "#,
        )?;
        let results = statement
            .query_map(params![query, limit], |row| {
                Ok(SearchQueryResult {
                    document_id: row.get(0)?,
                    page_id: row.get(1)?,
                    title: row.get(2)?,
                    title_snippet: row.get(3)?,
                    body_snippet: row.get(4)?,
                    tags_snippet: row.get(5)?,
                    score: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(results)
    }
}

#[tauri::command]
pub async fn search_v2_replace(
    database: tauri::State<'_, Database>,
    rows: Vec<SearchProjectionRow>,
) -> Result<(), CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.search_v2_replace(rows))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_v2_upsert(
    database: tauri::State<'_, Database>,
    row: SearchProjectionRow,
) -> Result<(), CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.search_v2_upsert(row))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_v2_remove(
    database: tauri::State<'_, Database>,
    document_id: String,
) -> Result<(), CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.search_v2_remove(&document_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_v2_clear(database: tauri::State<'_, Database>) -> Result<(), CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.search_v2_clear())
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn search_v2_query(
    database: tauri::State<'_, Database>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SearchQueryResult>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.search_v2_query(&query, limit))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDatabase {
        database: Database,
        directory: std::path::PathBuf,
    }

    impl TestDatabase {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir().join(format!(
                "canvink-search-test-{}-{nonce}-{id}",
                std::process::id()
            ));
            let database = Database::new(directory.join("notebook.sqlite"));
            database.initialize().unwrap();
            Self {
                database,
                directory,
            }
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn row(id: &str, title: &str, body: &str) -> SearchProjectionRow {
        SearchProjectionRow {
            document_id: id.into(),
            page_id: format!("page-{id}"),
            title: title.into(),
            body: body.into(),
            tags: "physics school".into(),
        }
    }

    #[test]
    fn replace_query_upsert_remove_and_clear_are_deterministic() {
        let test = TestDatabase::new();
        test.database
            .search_v2_replace(vec![
                row("body", "Other", "Impulserhaltung appears here"),
                row("title", "Impulserhaltung", "Short body"),
            ])
            .unwrap();
        let results = test
            .database
            .search_v2_query("IMPULSERHALTUNG", Some(10))
            .unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].document_id, "title");
        assert!(results[0].title_snippet.contains("<mark>"));

        test.database
            .search_v2_upsert(row("body", "Changed", "No match"))
            .unwrap();
        assert_eq!(
            test.database
                .search_v2_query("Impulserhaltung", None)
                .unwrap()
                .len(),
            1
        );
        test.database.search_v2_remove("title").unwrap();
        assert!(test
            .database
            .search_v2_query("Impulserhaltung", None)
            .unwrap()
            .is_empty());
        test.database
            .search_v2_upsert(row("again", "Impulserhaltung", "body"))
            .unwrap();
        test.database.search_v2_clear().unwrap();
        assert!(test
            .database
            .search_v2_query("Impulserhaltung", None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn query_builder_quotes_fts_operators_and_enforces_bounds() {
        assert_eq!(
            fts_query("title:foo OR bar").unwrap(),
            "\"bar\" AND \"foo\" AND \"or\" AND \"title\""
        );
        assert!(fts_query("∑ √").is_err());
        assert!(fts_query(&"x".repeat(MAX_QUERY_BYTES + 1)).is_err());
    }
}
