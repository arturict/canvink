use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde_json::Value;
use thiserror::Error;

use crate::model::{
    Notebook, Page, PageElement, PageMode, Section, WorkspaceState, WORKSPACE_SCHEMA_VERSION,
};

const DATABASE_SCHEMA_VERSION: i64 = 1;
const MAX_ID_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 16 * 1024;
const MAX_TIMESTAMP_BYTES: usize = 256;
const MAX_NOTEBOOKS: usize = 10_000;
const MAX_SECTIONS: usize = 100_000;
const MAX_PAGES: usize = 1_000_000;
const MAX_ELEMENTS: usize = 5_000_000;
const MAX_STATE_JSON_BYTES: usize = 256 * 1024 * 1024;
const MAX_SEARCH_TEXT_BYTES: usize = 256 * 1024;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("could not resolve the application data directory: {0}")]
    AppDataPath(String),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid workspace state: {0}")]
    InvalidState(String),
    #[error(
        "database schema version {found} is newer than the supported version {supported}; upgrade Canvink before opening this notebook"
    )]
    UnsupportedDatabaseSchema { found: i64, supported: i64 },
    #[error("stored workspace is corrupt: {0}")]
    CorruptData(String),
    #[error("SQLite could not enable WAL mode (reported `{0}`)")]
    WalUnavailable(String),
    #[error("the in-process database write lock is unavailable")]
    WriteLockUnavailable,
}

impl StorageError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidState(_) => "invalidWorkspace",
            Self::UnsupportedDatabaseSchema { .. } => "unsupportedDatabaseSchema",
            Self::CorruptData(_) => "corruptWorkspace",
            Self::WalUnavailable(_) => "durabilityUnavailable",
            Self::AppDataPath(_)
            | Self::Io(_)
            | Self::Sqlite(_)
            | Self::Json(_)
            | Self::WriteLockUnavailable => "storageFailure",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Database {
    path: PathBuf,
    write_lock: Arc<Mutex<()>>,
}

impl Database {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn initialize(&self) -> Result<(), StorageError> {
        self.connect().map(drop)
    }

    pub fn load_workspace(&self) -> Result<WorkspaceState, StorageError> {
        let connection = self.connect()?;
        load_workspace_from(&connection)
    }

    pub fn save_workspace(
        &self,
        workspace: &WorkspaceState,
    ) -> Result<WorkspaceState, StorageError> {
        let _write_guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        save_workspace_to(&mut connection, workspace)?;
        load_workspace_from(&connection)
    }

    fn connect(&self) -> Result<Connection, StorageError> {
        prepare_database_path(&self.path)?;
        let mut connection = Connection::open_with_flags(
            &self.path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
        )?;
        configure_connection(&connection, true)?;
        migrate(&mut connection)?;
        #[cfg(unix)]
        harden_unix_database_files(&self.path)?;
        Ok(connection)
    }
}

fn database_parent(path: &Path) -> Result<&Path, StorageError> {
    path.parent().ok_or_else(|| {
        StorageError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "database path has no parent directory",
        ))
    })
}

fn prepare_database_path(path: &Path) -> Result<(), StorageError> {
    let parent = database_parent(path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

        let mut directory_builder = fs::DirBuilder::new();
        directory_builder
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;

        let database_file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)?;
        database_file.set_permissions(fs::Permissions::from_mode(0o600))?;
        harden_unix_database_files(path)?;
    }

    #[cfg(not(unix))]
    fs::create_dir_all(parent)?;

    Ok(())
}

#[cfg(unix)]
fn harden_unix_database_files(path: &Path) -> Result<(), StorageError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut companion_path = path.as_os_str().to_os_string();
        companion_path.push(suffix);
        match fs::set_permissions(
            PathBuf::from(companion_path),
            fs::Permissions::from_mode(0o600),
        ) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(StorageError::Io(error)),
        }
    }

    Ok(())
}

fn configure_connection(connection: &Connection, require_wal: bool) -> Result<(), StorageError> {
    connection.busy_timeout(Duration::from_secs(10))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;

    let journal_mode: String =
        connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if require_wal && !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(StorageError::WalUnavailable(journal_mode));
    }

    // In WAL mode, FULL syncs the WAL at every commit. fullfsync and
    // checkpoint_fullfsync additionally request the strongest flush primitive on
    // platforms that expose it (and are harmless no-ops elsewhere).
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "fullfsync", "ON")?;
    connection.pragma_update(None, "checkpoint_fullfsync", "ON")?;
    connection.pragma_update(None, "wal_autocheckpoint", 1_000_i64)?;
    connection.pragma_update(None, "journal_size_limit", 64_i64 * 1024 * 1024)?;
    connection.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<(), StorageError> {
    let found: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if found > DATABASE_SCHEMA_VERSION {
        return Err(StorageError::UnsupportedDatabaseSchema {
            found,
            supported: DATABASE_SCHEMA_VERSION,
        });
    }

    let mut version = found;
    while version < DATABASE_SCHEMA_VERSION {
        let next = version + 1;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        match next {
            1 => migrate_to_v1(&transaction)?,
            _ => unreachable!("every database migration must be registered"),
        }
        transaction.pragma_update(None, "user_version", next)?;
        transaction.commit()?;
        version = next;
    }
    Ok(())
}

fn migrate_to_v1(transaction: &Transaction<'_>) -> Result<(), StorageError> {
    transaction.execute_batch(
        r#"
        -- Small workspace-wide values only. Hierarchical content is normalized
        -- into the entity tables below rather than stored as one JSON document.
        CREATE TABLE meta (
            key   TEXT PRIMARY KEY NOT NULL,
            value TEXT NOT NULL
        ) STRICT;

        CREATE TABLE notebooks (
            id          TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
            title       TEXT NOT NULL,
            sort_order  INTEGER NOT NULL CHECK (sort_order >= 0),
            created_at  TEXT,
            updated_at  TEXT,
            extra_json  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
        ) STRICT;

        CREATE TABLE sections (
            id           TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
            notebook_id  TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
            title        TEXT NOT NULL,
            sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
            created_at   TEXT,
            updated_at   TEXT,
            extra_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
        ) STRICT;

        CREATE INDEX sections_by_notebook
            ON sections(notebook_id, sort_order, id);

        CREATE TABLE pages (
            id              TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
            section_id      TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
            parent_page_id  TEXT REFERENCES pages(id) ON DELETE SET NULL
                                DEFERRABLE INITIALLY DEFERRED,
            title           TEXT NOT NULL,
            mode            TEXT NOT NULL CHECK (mode IN ('free', 'a4')),
            sort_order      INTEGER NOT NULL CHECK (sort_order >= 0),
            created_at      TEXT,
            updated_at      TEXT,
            deleted_at      TEXT,
            extra_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_json))
        ) STRICT;

        CREATE INDEX pages_by_section
            ON pages(section_id, sort_order, id);
        CREATE INDEX pages_by_parent
            ON pages(parent_page_id);

        CREATE TABLE elements (
            id           TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
            page_id      TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
            kind         TEXT NOT NULL CHECK (length(trim(kind)) > 0),
            sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
            x            REAL NOT NULL,
            y            REAL NOT NULL,
            width        REAL CHECK (width IS NULL OR width >= 0),
            height       REAL CHECK (height IS NULL OR height >= 0),
            rotation     REAL,
            z_index      INTEGER,
            created_at   TEXT,
            updated_at   TEXT,
            data_json    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data_json))
        ) STRICT;

        CREATE INDEX elements_by_page
            ON elements(page_id, sort_order, id);
        CREATE INDEX elements_by_z_index
            ON elements(page_id, z_index, sort_order);

        -- Contentless FTS avoids coupling the index to one entity table. It is
        -- rebuilt in the same transaction as every full-state save.
        CREATE VIRTUAL TABLE search_fts USING fts5(
            entity_id UNINDEXED,
            page_id UNINDEXED,
            entity_kind UNINDEXED,
            title,
            body,
            tokenize = 'unicode61 remove_diacritics 2'
        );

        INSERT INTO meta(key, value)
        VALUES ('workspace.schemaVersion', '1');
        "#,
    )?;
    Ok(())
}

fn load_workspace_from(connection: &Connection) -> Result<WorkspaceState, StorageError> {
    let mut workspace = WorkspaceState::default();
    workspace.schema_version = meta_value(connection, "workspace.schemaVersion")?
        .map(|value| {
            value.parse::<u32>().map_err(|error| {
                StorageError::CorruptData(format!(
                    "workspace.schemaVersion is not an integer: {error}"
                ))
            })
        })
        .transpose()?
        .unwrap_or(WORKSPACE_SCHEMA_VERSION);
    workspace.updated_at =
        meta_value(connection, "workspace.updatedAt")?.unwrap_or(workspace.updated_at);
    workspace.active_notebook_id =
        meta_value(connection, "workspace.activeNotebookId")?.unwrap_or_default();
    workspace.active_section_id =
        meta_value(connection, "workspace.activeSectionId")?.unwrap_or_default();
    workspace.active_page_id =
        meta_value(connection, "workspace.activePageId")?.unwrap_or_default();
    workspace.trash = parse_json_or_default(
        meta_value(connection, "workspace.trash")?,
        "workspace.trash",
    )?;
    workspace.extra = parse_json_or_default(
        meta_value(connection, "workspace.extra")?,
        "workspace.extra",
    )?;

    let notebook_rows = {
        let mut statement = connection.prepare(
            "SELECT id, title, created_at, updated_at, extra_json
             FROM notebooks
             ORDER BY sort_order, id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(StoredNotebook {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                    extra_json: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    for stored_notebook in notebook_rows {
        let section_rows = {
            let mut statement = connection.prepare(
                "SELECT id, title, created_at, updated_at, extra_json
                 FROM sections
                 WHERE notebook_id = ?1
                 ORDER BY sort_order, id",
            )?;
            let rows = statement
                .query_map([&stored_notebook.id], |row| {
                    Ok(StoredSection {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        created_at: row.get(2)?,
                        updated_at: row.get(3)?,
                        extra_json: row.get(4)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };

        let mut sections = Vec::with_capacity(section_rows.len());
        for stored_section in section_rows {
            let page_rows = {
                let mut statement = connection.prepare(
                    "SELECT id, parent_page_id, title, mode, created_at, updated_at,
                            deleted_at, extra_json
                     FROM pages
                     WHERE section_id = ?1
                     ORDER BY sort_order, id",
                )?;
                let rows = statement
                    .query_map([&stored_section.id], |row| {
                        Ok(StoredPage {
                            id: row.get(0)?,
                            parent_page_id: row.get(1)?,
                            title: row.get(2)?,
                            mode: row.get(3)?,
                            created_at: row.get(4)?,
                            updated_at: row.get(5)?,
                            deleted_at: row.get(6)?,
                            extra_json: row.get(7)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };

            let mut pages = Vec::with_capacity(page_rows.len());
            for stored_page in page_rows {
                let element_rows = {
                    let mut statement = connection.prepare(
                        "SELECT id, kind, x, y, width, height, rotation, z_index,
                                created_at, updated_at, data_json
                         FROM elements
                         WHERE page_id = ?1
                         ORDER BY sort_order, id",
                    )?;
                    let rows = statement
                        .query_map([&stored_page.id], |row| {
                            Ok(StoredElement {
                                id: row.get(0)?,
                                kind: row.get(1)?,
                                x: row.get(2)?,
                                y: row.get(3)?,
                                width: row.get(4)?,
                                height: row.get(5)?,
                                rotation: row.get(6)?,
                                z_index: row.get(7)?,
                                created_at: row.get(8)?,
                                updated_at: row.get(9)?,
                                data_json: row.get(10)?,
                            })
                        })?
                        .collect::<rusqlite::Result<Vec<_>>>()?;
                    rows
                };

                let elements = element_rows
                    .into_iter()
                    .map(|element| {
                        Ok(PageElement {
                            id: element.id,
                            kind: element.kind,
                            x: element.x,
                            y: element.y,
                            width: element.width,
                            height: element.height,
                            rotation: element.rotation,
                            z_index: element.z_index,
                            created_at: element.created_at,
                            updated_at: element.updated_at,
                            payload: parse_object(&element.data_json, "elements.data_json")?,
                        })
                    })
                    .collect::<Result<Vec<_>, StorageError>>()?;

                pages.push(Page {
                    id: stored_page.id,
                    title: stored_page.title,
                    parent_page_id: stored_page.parent_page_id,
                    mode: PageMode::try_from(stored_page.mode.as_str())
                        .map_err(StorageError::CorruptData)?,
                    created_at: stored_page.created_at,
                    updated_at: stored_page.updated_at,
                    deleted_at: stored_page.deleted_at,
                    elements,
                    extra: parse_object(&stored_page.extra_json, "pages.extra_json")?,
                });
            }

            sections.push(Section {
                id: stored_section.id,
                title: stored_section.title,
                created_at: stored_section.created_at,
                updated_at: stored_section.updated_at,
                pages,
                extra: parse_object(&stored_section.extra_json, "sections.extra_json")?,
            });
        }

        workspace.notebooks.push(Notebook {
            id: stored_notebook.id,
            title: stored_notebook.title,
            created_at: stored_notebook.created_at,
            updated_at: stored_notebook.updated_at,
            sections,
            extra: parse_object(&stored_notebook.extra_json, "notebooks.extra_json")?,
        });
    }

    validate_workspace(&workspace).map_err(|error| StorageError::CorruptData(error.to_string()))?;
    Ok(workspace)
}

fn save_workspace_to(
    connection: &mut Connection,
    workspace: &WorkspaceState,
) -> Result<(), StorageError> {
    validate_workspace(workspace)?;
    let serialized_size = serde_json::to_vec(workspace)?.len();
    if serialized_size > MAX_STATE_JSON_BYTES {
        return Err(StorageError::InvalidState(format!(
            "serialized workspace is {serialized_size} bytes; maximum is {MAX_STATE_JSON_BYTES}"
        )));
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "DELETE FROM search_fts;
         DELETE FROM elements;
         DELETE FROM pages;
         DELETE FROM sections;
         DELETE FROM notebooks;
         DELETE FROM meta WHERE key GLOB 'workspace.*';",
    )?;

    put_meta(
        &transaction,
        "workspace.schemaVersion",
        &workspace.schema_version.to_string(),
    )?;
    put_meta(&transaction, "workspace.updatedAt", &workspace.updated_at)?;
    put_meta(
        &transaction,
        "workspace.activeNotebookId",
        &workspace.active_notebook_id,
    )?;
    put_meta(
        &transaction,
        "workspace.activeSectionId",
        &workspace.active_section_id,
    )?;
    put_meta(
        &transaction,
        "workspace.activePageId",
        &workspace.active_page_id,
    )?;
    put_meta(
        &transaction,
        "workspace.trash",
        &serde_json::to_string(&workspace.trash)?,
    )?;
    put_meta(
        &transaction,
        "workspace.extra",
        &serde_json::to_string(&workspace.extra)?,
    )?;

    {
        let mut insert_notebook = transaction.prepare_cached(
            "INSERT INTO notebooks(
                 id, title, sort_order, created_at, updated_at, extra_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        let mut insert_section = transaction.prepare_cached(
            "INSERT INTO sections(
                 id, notebook_id, title, sort_order, created_at, updated_at, extra_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        let mut insert_page = transaction.prepare_cached(
            "INSERT INTO pages(
                 id, section_id, parent_page_id, title, mode, sort_order,
                 created_at, updated_at, deleted_at, extra_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        let mut insert_element = transaction.prepare_cached(
            "INSERT INTO elements(
                 id, page_id, kind, sort_order, x, y, width, height, rotation,
                 z_index, created_at, updated_at, data_json
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
             )",
        )?;
        let mut insert_search = transaction.prepare_cached(
            "INSERT INTO search_fts(
                 entity_id, page_id, entity_kind, title, body
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;

        for (notebook_order, notebook) in workspace.notebooks.iter().enumerate() {
            let notebook_extra = serde_json::to_string(&notebook.extra)?;
            insert_notebook.execute(params![
                notebook.id,
                notebook.title,
                index_to_i64(notebook_order)?,
                notebook.created_at,
                notebook.updated_at,
                notebook_extra,
            ])?;
            insert_search.execute(params![
                notebook.id,
                "",
                "notebook",
                notebook.title,
                search_text_from_map(&notebook.extra),
            ])?;

            for (section_order, section) in notebook.sections.iter().enumerate() {
                let section_extra = serde_json::to_string(&section.extra)?;
                insert_section.execute(params![
                    section.id,
                    notebook.id,
                    section.title,
                    index_to_i64(section_order)?,
                    section.created_at,
                    section.updated_at,
                    section_extra,
                ])?;
                insert_search.execute(params![
                    section.id,
                    "",
                    "section",
                    section.title,
                    search_text_from_map(&section.extra),
                ])?;

                for (page_order, page) in section.pages.iter().enumerate() {
                    let page_extra = serde_json::to_string(&page.extra)?;
                    insert_page.execute(params![
                        page.id,
                        section.id,
                        page.parent_page_id,
                        page.title,
                        page.mode.as_str(),
                        index_to_i64(page_order)?,
                        page.created_at,
                        page.updated_at,
                        page.deleted_at,
                        page_extra,
                    ])?;
                    insert_search.execute(params![
                        page.id,
                        page.id,
                        "page",
                        page.title,
                        search_text_from_map(&page.extra),
                    ])?;

                    for (element_order, element) in page.elements.iter().enumerate() {
                        let element_data = serde_json::to_string(&element.payload)?;
                        insert_element.execute(params![
                            element.id,
                            page.id,
                            element.kind,
                            index_to_i64(element_order)?,
                            element.x,
                            element.y,
                            element.width,
                            element.height,
                            element.rotation,
                            element.z_index,
                            element.created_at,
                            element.updated_at,
                            element_data,
                        ])?;
                        insert_search.execute(params![
                            element.id,
                            page.id,
                            "element",
                            "",
                            search_text_from_map(&element.payload),
                        ])?;
                    }
                }
            }
        }
    }

    transaction.commit()?;
    Ok(())
}

fn put_meta(transaction: &Transaction<'_>, key: &str, value: &str) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn meta_value(connection: &Connection, key: &str) -> Result<Option<String>, StorageError> {
    Ok(connection
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn parse_json_or_default<T>(value: Option<String>, context: &str) -> Result<T, StorageError>
where
    T: serde::de::DeserializeOwned + Default,
{
    value
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                StorageError::CorruptData(format!("{context} contains invalid JSON: {error}"))
            })
        })
        .transpose()
        .map(Option::unwrap_or_default)
}

fn parse_object(json: &str, context: &str) -> Result<BTreeMap<String, Value>, StorageError> {
    serde_json::from_str(json).map_err(|error| {
        StorageError::CorruptData(format!("{context} contains invalid JSON: {error}"))
    })
}

fn index_to_i64(index: usize) -> Result<i64, StorageError> {
    i64::try_from(index).map_err(|_| {
        StorageError::InvalidState("workspace ordering exceeds SQLite integer limits".to_owned())
    })
}

fn validate_workspace(workspace: &WorkspaceState) -> Result<(), StorageError> {
    if workspace.schema_version != WORKSPACE_SCHEMA_VERSION {
        return Err(StorageError::InvalidState(format!(
            "schemaVersion must be {WORKSPACE_SCHEMA_VERSION}, got {}",
            workspace.schema_version
        )));
    }
    validate_timestamp("workspace.updatedAt", Some(&workspace.updated_at))?;
    validate_extra_keys(
        "workspace",
        &workspace.extra,
        &[
            "schemaVersion",
            "updatedAt",
            "notebooks",
            "trash",
            "activeNotebookId",
            "activeSectionId",
            "activePageId",
        ],
    )?;

    if workspace.notebooks.len() > MAX_NOTEBOOKS {
        return invalid(format!(
            "workspace contains {} notebooks; maximum is {MAX_NOTEBOOKS}",
            workspace.notebooks.len()
        ));
    }

    let mut notebook_ids = HashSet::new();
    let mut section_ids = HashSet::new();
    let mut page_ids = HashSet::new();
    let mut element_ids = HashSet::new();
    let mut section_owners = HashMap::new();
    let mut page_owners = HashMap::new();
    let mut section_count = 0_usize;
    let mut page_count = 0_usize;
    let mut element_count = 0_usize;

    for notebook in &workspace.notebooks {
        validate_id("notebook", &notebook.id)?;
        if !notebook_ids.insert(notebook.id.as_str()) {
            return invalid(format!("duplicate notebook id `{}`", notebook.id));
        }
        validate_title("notebook", &notebook.title)?;
        validate_timestamp("notebook.createdAt", notebook.created_at.as_deref())?;
        validate_timestamp("notebook.updatedAt", notebook.updated_at.as_deref())?;
        validate_extra_keys(
            "notebook",
            &notebook.extra,
            &["id", "title", "createdAt", "updatedAt", "sections"],
        )?;

        section_count = section_count
            .checked_add(notebook.sections.len())
            .ok_or_else(|| StorageError::InvalidState("section count overflow".to_owned()))?;
        if section_count > MAX_SECTIONS {
            return invalid(format!(
                "workspace contains more than {MAX_SECTIONS} sections"
            ));
        }

        for section in &notebook.sections {
            validate_id("section", &section.id)?;
            if !section_ids.insert(section.id.as_str()) {
                return invalid(format!("duplicate section id `{}`", section.id));
            }
            section_owners.insert(section.id.as_str(), notebook.id.as_str());
            validate_title("section", &section.title)?;
            validate_timestamp("section.createdAt", section.created_at.as_deref())?;
            validate_timestamp("section.updatedAt", section.updated_at.as_deref())?;
            validate_extra_keys(
                "section",
                &section.extra,
                &["id", "title", "createdAt", "updatedAt", "pages"],
            )?;

            page_count = page_count
                .checked_add(section.pages.len())
                .ok_or_else(|| StorageError::InvalidState("page count overflow".to_owned()))?;
            if page_count > MAX_PAGES {
                return invalid(format!("workspace contains more than {MAX_PAGES} pages"));
            }

            let mut local_page_parents = HashMap::new();
            for page in &section.pages {
                validate_id("page", &page.id)?;
                if !page_ids.insert(page.id.as_str()) {
                    return invalid(format!("duplicate page id `{}`", page.id));
                }
                page_owners.insert(page.id.as_str(), section.id.as_str());
                local_page_parents.insert(page.id.as_str(), page.parent_page_id.as_deref());
                validate_title("page", &page.title)?;
                validate_timestamp("page.createdAt", page.created_at.as_deref())?;
                validate_timestamp("page.updatedAt", page.updated_at.as_deref())?;
                validate_timestamp("page.deletedAt", page.deleted_at.as_deref())?;
                validate_extra_keys(
                    "page",
                    &page.extra,
                    &[
                        "id",
                        "title",
                        "parentPageId",
                        "mode",
                        "createdAt",
                        "updatedAt",
                        "deletedAt",
                        "elements",
                    ],
                )?;

                element_count =
                    element_count
                        .checked_add(page.elements.len())
                        .ok_or_else(|| {
                            StorageError::InvalidState("element count overflow".to_owned())
                        })?;
                if element_count > MAX_ELEMENTS {
                    return invalid(format!(
                        "workspace contains more than {MAX_ELEMENTS} elements"
                    ));
                }

                for element in &page.elements {
                    validate_id("element", &element.id)?;
                    if !element_ids.insert(element.id.as_str()) {
                        return invalid(format!("duplicate element id `{}`", element.id));
                    }
                    validate_id("element kind", &element.kind)?;
                    validate_number("element.x", element.x)?;
                    validate_number("element.y", element.y)?;
                    validate_optional_size("element.width", element.width)?;
                    validate_optional_size("element.height", element.height)?;
                    if let Some(rotation) = element.rotation {
                        validate_number("element.rotation", rotation)?;
                    }
                    validate_timestamp("element.createdAt", element.created_at.as_deref())?;
                    validate_timestamp("element.updatedAt", element.updated_at.as_deref())?;
                    validate_extra_keys(
                        "element",
                        &element.payload,
                        &[
                            "id",
                            "kind",
                            "type",
                            "x",
                            "y",
                            "width",
                            "height",
                            "rotation",
                            "zIndex",
                            "createdAt",
                            "updatedAt",
                        ],
                    )?;
                }
            }

            validate_page_tree(&section.id, &local_page_parents)?;
        }
    }

    validate_active_selection(
        workspace,
        &notebook_ids,
        &section_ids,
        &page_ids,
        &section_owners,
        &page_owners,
    )?;
    Ok(())
}

fn validate_page_tree(
    section_id: &str,
    parents: &HashMap<&str, Option<&str>>,
) -> Result<(), StorageError> {
    for (&page_id, &parent_id) in parents {
        if let Some(parent_id) = parent_id {
            if parent_id == page_id {
                return invalid(format!("page `{page_id}` cannot be its own parent"));
            }
            if !parents.contains_key(parent_id) {
                return invalid(format!(
                    "page `{page_id}` references parent `{parent_id}` outside section `{section_id}`"
                ));
            }
        }

        let mut seen = HashSet::new();
        let mut current = Some(page_id);
        while let Some(candidate) = current {
            if !seen.insert(candidate) {
                return invalid(format!(
                    "page hierarchy in section `{section_id}` contains a cycle at `{candidate}`"
                ));
            }
            current = parents.get(candidate).copied().flatten();
        }
    }
    Ok(())
}

fn validate_active_selection(
    workspace: &WorkspaceState,
    notebook_ids: &HashSet<&str>,
    section_ids: &HashSet<&str>,
    page_ids: &HashSet<&str>,
    section_owners: &HashMap<&str, &str>,
    page_owners: &HashMap<&str, &str>,
) -> Result<(), StorageError> {
    let active_notebook = workspace.active_notebook_id.as_str();
    let active_section = workspace.active_section_id.as_str();
    let active_page = workspace.active_page_id.as_str();

    if !active_notebook.is_empty() && !notebook_ids.contains(active_notebook) {
        return invalid(format!(
            "activeNotebookId `{active_notebook}` does not exist"
        ));
    }
    if !active_section.is_empty() && !section_ids.contains(active_section) {
        return invalid(format!("activeSectionId `{active_section}` does not exist"));
    }
    if !active_page.is_empty() && !page_ids.contains(active_page) {
        return invalid(format!("activePageId `{active_page}` does not exist"));
    }

    if !active_section.is_empty() {
        if active_notebook.is_empty() {
            return invalid("activeSectionId requires activeNotebookId".to_owned());
        }
        if section_owners.get(active_section).copied() != Some(active_notebook) {
            return invalid(format!(
                "active section `{active_section}` is not inside active notebook `{active_notebook}`"
            ));
        }
    }
    if !active_page.is_empty() {
        if active_section.is_empty() {
            return invalid("activePageId requires activeSectionId".to_owned());
        }
        if page_owners.get(active_page).copied() != Some(active_section) {
            return invalid(format!(
                "active page `{active_page}` is not inside active section `{active_section}`"
            ));
        }
    }
    Ok(())
}

fn validate_id(kind: &str, value: &str) -> Result<(), StorageError> {
    if value.trim().is_empty() {
        return invalid(format!("{kind} id must not be empty"));
    }
    if value.len() > MAX_ID_BYTES {
        return invalid(format!(
            "{kind} id is {} bytes; maximum is {MAX_ID_BYTES}",
            value.len()
        ));
    }
    if value.contains('\0') {
        return invalid(format!("{kind} id must not contain NUL"));
    }
    Ok(())
}

fn validate_title(kind: &str, value: &str) -> Result<(), StorageError> {
    if value.len() > MAX_TITLE_BYTES {
        return invalid(format!(
            "{kind} title is {} bytes; maximum is {MAX_TITLE_BYTES}",
            value.len()
        ));
    }
    if value.contains('\0') {
        return invalid(format!("{kind} title must not contain NUL"));
    }
    Ok(())
}

fn validate_timestamp(label: &str, value: Option<&str>) -> Result<(), StorageError> {
    if let Some(value) = value {
        if value.len() > MAX_TIMESTAMP_BYTES {
            return invalid(format!(
                "{label} is {} bytes; maximum is {MAX_TIMESTAMP_BYTES}",
                value.len()
            ));
        }
        if value.contains('\0') {
            return invalid(format!("{label} must not contain NUL"));
        }
    }
    Ok(())
}

fn validate_number(label: &str, value: f64) -> Result<(), StorageError> {
    if !value.is_finite() {
        return invalid(format!("{label} must be finite"));
    }
    Ok(())
}

fn validate_optional_size(label: &str, value: Option<f64>) -> Result<(), StorageError> {
    if let Some(value) = value {
        validate_number(label, value)?;
        if value < 0.0 {
            return invalid(format!("{label} must not be negative"));
        }
    }
    Ok(())
}

fn validate_extra_keys(
    context: &str,
    map: &BTreeMap<String, Value>,
    reserved: &[&str],
) -> Result<(), StorageError> {
    if let Some(key) = reserved.iter().find(|key| map.contains_key(**key)) {
        return invalid(format!(
            "{context} extension data duplicates reserved key `{key}`"
        ));
    }
    Ok(())
}

fn invalid<T>(message: String) -> Result<T, StorageError> {
    Err(StorageError::InvalidState(message))
}

fn search_text_from_map(map: &BTreeMap<String, Value>) -> String {
    let mut output = String::new();
    for (key, value) in map {
        append_search_value(Some(key.as_str()), value, &mut output);
        if output.len() >= MAX_SEARCH_TEXT_BYTES {
            output.truncate(MAX_SEARCH_TEXT_BYTES);
            break;
        }
    }
    output
}

fn append_search_value(key: Option<&str>, value: &Value, output: &mut String) {
    if output.len() >= MAX_SEARCH_TEXT_BYTES {
        return;
    }
    match value {
        Value::String(text) if key.is_some_and(is_searchable_key) => {
            if !output.is_empty() {
                output.push(' ');
            }
            let remaining = MAX_SEARCH_TEXT_BYTES.saturating_sub(output.len());
            if text.len() <= remaining {
                output.push_str(text);
            } else {
                let mut boundary = remaining;
                while boundary > 0 && !text.is_char_boundary(boundary) {
                    boundary -= 1;
                }
                output.push_str(&text[..boundary]);
            }
        }
        Value::Array(values) => {
            for item in values {
                append_search_value(key, item, output);
            }
        }
        Value::Object(values) => {
            for (child_key, child_value) in values {
                append_search_value(Some(child_key), child_value, output);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
}

fn is_searchable_key(key: &str) -> bool {
    matches!(
        key,
        "text"
            | "title"
            | "alt"
            | "name"
            | "sourceName"
            | "label"
            | "caption"
            | "markdown"
            | "html"
            | "content"
            | "tags"
    )
}

struct StoredNotebook {
    id: String,
    title: String,
    created_at: Option<String>,
    updated_at: Option<String>,
    extra_json: String,
}

struct StoredSection {
    id: String,
    title: String,
    created_at: Option<String>,
    updated_at: Option<String>,
    extra_json: String,
}

struct StoredPage {
    id: String,
    parent_page_id: Option<String>,
    title: String,
    mode: String,
    created_at: Option<String>,
    updated_at: Option<String>,
    deleted_at: Option<String>,
    extra_json: String,
}

struct StoredElement {
    id: String,
    kind: String,
    x: f64,
    y: f64,
    width: Option<f64>,
    height: Option<f64>,
    rotation: Option<f64>,
    z_index: Option<i64>,
    created_at: Option<String>,
    updated_at: Option<String>,
    data_json: String,
}

#[cfg(test)]
mod tests {
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::*;

    static TEST_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDatabase {
        database: Database,
        directory: PathBuf,
    }

    impl TestDatabase {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after Unix epoch")
                .as_nanos();
            let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir().join(format!(
                "canvink-storage-test-{}-{nonce}-{id}",
                std::process::id()
            ));
            let database = Database::new(directory.join("notebook.sqlite"));
            database.initialize().expect("test database initializes");
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

    fn sample_workspace() -> WorkspaceState {
        let mut element_payload = BTreeMap::new();
        element_payload.insert("text".to_owned(), json!("Offline-first notes"));
        element_payload.insert("color".to_owned(), json!("#172554"));
        element_payload.insert("customFutureField".to_owned(), json!({"nested": true}));

        let mut page_extra = BTreeMap::new();
        page_extra.insert("background".to_owned(), json!("grid"));

        let mut notebook_extra = BTreeMap::new();
        notebook_extra.insert("color".to_owned(), json!("#2563eb"));

        let page = Page {
            id: "page-1".to_owned(),
            title: "Architecture".to_owned(),
            parent_page_id: None,
            mode: PageMode::Free,
            created_at: Some("2026-07-29T10:00:00.000Z".to_owned()),
            updated_at: Some("2026-07-29T10:03:00.000Z".to_owned()),
            deleted_at: None,
            elements: vec![PageElement {
                id: "element-1".to_owned(),
                kind: "text".to_owned(),
                x: 24.5,
                y: 48.0,
                width: Some(420.0),
                height: Some(180.0),
                rotation: Some(0.0),
                z_index: Some(2),
                created_at: Some("2026-07-29T10:01:00.000Z".to_owned()),
                updated_at: Some("2026-07-29T10:02:00.000Z".to_owned()),
                payload: element_payload,
            }],
            extra: page_extra,
        };

        let mut workspace = WorkspaceState {
            schema_version: 1,
            updated_at: "2026-07-29T10:03:00.000Z".to_owned(),
            notebooks: vec![Notebook {
                id: "notebook-1".to_owned(),
                title: "Canvink".to_owned(),
                created_at: Some("2026-07-29T09:59:00.000Z".to_owned()),
                updated_at: Some("2026-07-29T10:03:00.000Z".to_owned()),
                sections: vec![Section {
                    id: "section-1".to_owned(),
                    title: "Product".to_owned(),
                    created_at: None,
                    updated_at: None,
                    pages: vec![page],
                    extra: BTreeMap::new(),
                }],
                extra: notebook_extra,
            }],
            trash: vec![json!({
                "id": "trash-1",
                "kind": "element",
                "deletedAt": "2026-07-28T12:00:00.000Z",
                "item": {"id": "old", "kind": "text", "text": "old"}
            })],
            active_notebook_id: "notebook-1".to_owned(),
            active_section_id: "section-1".to_owned(),
            active_page_id: "page-1".to_owned(),
            extra: BTreeMap::new(),
        };
        workspace
            .extra
            .insert("futureWorkspaceSetting".to_owned(), json!(true));
        workspace
    }

    #[test]
    fn round_trip_preserves_typed_and_unknown_state_and_rebuilds_fts() {
        let test_database = TestDatabase::new();
        let expected = sample_workspace();

        let saved = test_database
            .database
            .save_workspace(&expected)
            .expect("workspace saves");
        assert_eq!(saved, expected);

        let connection = test_database.database.connect().expect("database opens");
        let notebook_count: i64 = connection
            .query_row("SELECT count(*) FROM notebooks", [], |row| row.get(0))
            .expect("notebooks can be counted");
        let search_hits: i64 = connection
            .query_row(
                "SELECT count(*) FROM search_fts WHERE search_fts MATCH 'offline'",
                [],
                |row| row.get(0),
            )
            .expect("FTS search works");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode can be read");
        let synchronous: i64 = connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .expect("synchronous pragma can be read");

        assert_eq!(notebook_count, 1);
        assert_eq!(search_hits, 1);
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 2, "SQLite FULL synchronous is numeric value 2");
    }

    #[test]
    fn round_trip_preserves_checklists_and_page_task_metadata() {
        let test_database = TestDatabase::new();
        let mut expected = sample_workspace();
        let page = &mut expected.notebooks[0].sections[0].pages[0];
        page.extra
            .insert("tags".to_owned(), json!(["todo", "important"]));
        page.extra.insert("taskState".to_owned(), json!("open"));

        let mut checklist_payload = BTreeMap::new();
        checklist_payload.insert("color".to_owned(), json!("#1f2937"));
        checklist_payload.insert("fontSize".to_owned(), json!(16));
        checklist_payload.insert(
            "items".to_owned(),
            json!([
                {"id": "check-1", "text": "Prepare notes", "checked": false},
                {"id": "check-2", "text": "Share summary", "checked": true}
            ]),
        );
        page.elements.push(PageElement {
            id: "checklist-1".to_owned(),
            kind: "checklist".to_owned(),
            x: 30.0,
            y: 240.0,
            width: Some(360.0),
            height: Some(120.0),
            rotation: None,
            z_index: Some(3),
            created_at: Some("2026-07-29T10:04:00.000Z".to_owned()),
            updated_at: Some("2026-07-29T10:04:00.000Z".to_owned()),
            payload: checklist_payload,
        });

        let saved = test_database
            .database
            .save_workspace(&expected)
            .expect("workspace with checklist saves");

        assert_eq!(saved, expected);
        assert_eq!(
            saved.notebooks[0].sections[0].pages[0].elements[1].kind,
            "checklist"
        );
    }

    #[cfg(unix)]
    #[test]
    fn initialization_repairs_private_unix_storage_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let test_database = TestDatabase::new();
        let database_path = test_database.directory.join("notebook.sqlite");
        fs::set_permissions(&test_database.directory, fs::Permissions::from_mode(0o755))
            .expect("test directory permissions can be relaxed");
        fs::set_permissions(&database_path, fs::Permissions::from_mode(0o644))
            .expect("test database permissions can be relaxed");

        test_database
            .database
            .initialize()
            .expect("database permissions are repaired during initialization");

        assert_eq!(
            fs::metadata(&test_database.directory)
                .expect("test directory metadata exists")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&database_path)
                .expect("test database metadata exists")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_sqlite_companion_files_are_restricted_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;

        let test_database = TestDatabase::new();
        let database_path = test_database.directory.join("notebook.sqlite");

        for suffix in ["-journal", "-wal", "-shm"] {
            let mut companion_path = database_path.as_os_str().to_os_string();
            companion_path.push(suffix);
            let companion_path = PathBuf::from(companion_path);
            fs::write(&companion_path, b"legacy companion")
                .expect("legacy companion can be created");
            fs::set_permissions(&companion_path, fs::Permissions::from_mode(0o644))
                .expect("legacy companion permissions can be relaxed");
        }

        harden_unix_database_files(&database_path)
            .expect("legacy companion permissions are repaired");

        for suffix in ["-journal", "-wal", "-shm"] {
            let mut companion_path = database_path.as_os_str().to_os_string();
            companion_path.push(suffix);
            assert_eq!(
                fs::metadata(PathBuf::from(companion_path))
                    .expect("legacy companion metadata exists")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn invalid_state_is_rejected_without_mutating_the_saved_workspace() {
        let test_database = TestDatabase::new();
        let expected = sample_workspace();
        test_database
            .database
            .save_workspace(&expected)
            .expect("baseline saves");

        let mut invalid_workspace = expected.clone();
        let duplicate = invalid_workspace.notebooks[0].sections[0].pages[0].clone();
        invalid_workspace.notebooks[0].sections[0]
            .pages
            .push(duplicate);

        let error = test_database
            .database
            .save_workspace(&invalid_workspace)
            .expect_err("duplicate page id is rejected");
        assert!(matches!(error, StorageError::InvalidState(_)));
        assert_eq!(
            test_database
                .database
                .load_workspace()
                .expect("baseline remains readable"),
            expected
        );
    }

    #[test]
    fn sqlite_failure_rolls_back_the_full_state_replacement() {
        let test_database = TestDatabase::new();
        let expected = sample_workspace();
        test_database
            .database
            .save_workspace(&expected)
            .expect("baseline saves");

        let connection = test_database.database.connect().expect("database opens");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_test_element
                 BEFORE INSERT ON elements
                 WHEN NEW.id = 'force-rollback'
                 BEGIN
                     SELECT RAISE(ABORT, 'forced test failure');
                 END;",
            )
            .expect("failure trigger installs");
        drop(connection);

        let mut replacement = expected.clone();
        replacement.notebooks[0].sections[0].pages[0].elements[0].id = "force-rollback".to_owned();
        replacement.updated_at = "2026-07-29T11:00:00.000Z".to_owned();

        let error = test_database
            .database
            .save_workspace(&replacement)
            .expect_err("trigger forces insertion failure");
        assert!(matches!(error, StorageError::Sqlite(_)));
        assert_eq!(
            test_database
                .database
                .load_workspace()
                .expect("original state survives rollback"),
            expected
        );
    }
}
