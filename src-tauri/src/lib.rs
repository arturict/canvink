mod android_update;
mod desktop_auth;
mod key_protection;
mod math_recognition;
mod math_units;
mod model;
mod ocr;
mod onenote_auth;
mod search;
mod storage;
mod v2;

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use key_protection::{protect_key_material, unprotect_key_material};
pub use model::{
    Notebook, Page, PageElement, PageMode, Section, WorkspaceState, WORKSPACE_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use storage::{Database, StorageError};
use tauri::Manager;
use v2::{
    AssetBlob, AssetMetadata, CommitMigrationRequest, DeleteOutboxRequest,
    DeleteSnapshotGuardedRequest, DocumentBlob, DocumentChunk, DocumentMetadata, MigrationMarker,
    OutboxRecord, PutAssetRequest, PutDocumentRequest, PutOutboxRequest, PutSnapshotRequest,
    RepoStorageEntry, RepoStorageMutation, ResetSyncCursorRequest, RollbackMigrationRequest,
    RollbackWorkspaceImportRequest, SnapshotBlob, SnapshotMetadata, StageMigrationRequest,
    SyncCursor, WorkspaceAdditiveImportRequest, WorkspaceDeltaCommitRequest,
    WorkspaceImportOperationResult, WorkspaceRevisionCommitRequest, WorkspaceRevisionCommitStatus,
    WorkspaceStageEntriesRequest, WorkspaceV2Authority,
};

const MAX_BASE64_REPO_VALUE_BYTES: usize = 32 * 1024 * 1024;
const MAX_BASE64_ASSET_BYTES: usize = 64 * 1024 * 1024;
const MAX_BASE64_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_BASE64_ACTIVATION_BYTES: usize = 16 * 1024 * 1024;
const MAX_BASE64_BACKUP_BYTES: usize = 256 * 1024 * 1024;
const MAX_BASE64_MIGRATION_ASSETS: usize = 10_000;
const MAX_BASE64_ATOMIC_MUTATIONS: usize = 20_000;
const MAX_BASE64_ATOMIC_WRITE_BYTES: usize = 256 * 1024 * 1024;

fn decode_base64(value: &str, label: &str, max_bytes: usize) -> Result<Vec<u8>, StorageError> {
    let max_encoded = max_bytes
        .checked_add(2)
        .and_then(|bytes| bytes.checked_div(3))
        .and_then(|groups| groups.checked_mul(4))
        .ok_or_else(|| StorageError::LimitExceeded(format!("{label} limit overflowed")))?;
    if value.is_empty() || value.len() > max_encoded {
        return Err(StorageError::LimitExceeded(format!(
            "{label} must decode to 1 to {max_bytes} bytes"
        )));
    }
    let decoded = BASE64_STANDARD
        .decode(value)
        .map_err(|_| StorageError::InvalidV2(format!("{label} is not strict Base64")))?;
    if decoded.is_empty() || decoded.len() > max_bytes {
        return Err(StorageError::LimitExceeded(format!(
            "{label} must decode to 1 to {max_bytes} bytes"
        )));
    }
    if BASE64_STANDARD.encode(&decoded) != value {
        return Err(StorageError::InvalidV2(format!(
            "{label} is not canonical padded Base64"
        )));
    }
    Ok(decoded)
}

fn decode_repo_base64(value: &str, label: &str) -> Result<Vec<u8>, StorageError> {
    if value.is_empty() {
        Ok(Vec::new())
    } else {
        decode_base64(value, label, MAX_BASE64_REPO_VALUE_BYTES)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Base64RepoEntryRequest {
    key: Vec<String>,
    data_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Base64RepoEntryResponse {
    key: Vec<String>,
    data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Base64RepoMutationRequest {
    Save {
        key: Vec<String>,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
    Remove {
        key: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Base64MigrationAssetRequest {
    asset_id: String,
    mime_type: String,
    data_base64: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Base64WorkspaceMigrationRequest {
    identity: v2::MigrationIdentity,
    prepared_at: String,
    manifest_base64: String,
    activation_base64: String,
    backup_base64: String,
    assets: Vec<Base64MigrationAssetRequest>,
    repo_entries: Vec<Base64RepoEntryRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Base64WorkspaceAdditiveImportRequest {
    expected_activation_base64: String,
    activation_base64: String,
    receipt_base64: String,
    assets: Vec<Base64MigrationAssetRequest>,
    repo_entries: Vec<Base64RepoEntryRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Base64WorkspaceRevisionRequest {
    expected_activation_base64: String,
    activation_base64: String,
    assets: Vec<Base64MigrationAssetRequest>,
    repo_entries: Vec<Base64RepoEntryRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Base64WorkspaceDeltaRequest {
    expected_activation_base64: String,
    activation_base64: String,
    receipt_base64: Option<String>,
    assets: Vec<Base64MigrationAssetRequest>,
    repo_entries: Vec<Base64RepoEntryRequest>,
    removed_prefixes: Vec<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Base64WorkspaceStageRequest {
    assets: Vec<Base64MigrationAssetRequest>,
    repo_entries: Vec<Base64RepoEntryRequest>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Base64WorkspaceAuthorityResponse {
    migration_id: String,
    activation_base64: String,
    backup_base64: String,
    activated_at: String,
}

impl From<WorkspaceV2Authority> for Base64WorkspaceAuthorityResponse {
    fn from(value: WorkspaceV2Authority) -> Self {
        Self {
            migration_id: value.migration_id,
            activation_base64: BASE64_STANDARD.encode(value.activation),
            backup_base64: BASE64_STANDARD.encode(value.backup),
            activated_at: value.activated_at,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Base64AssetResponse {
    asset_id: String,
    checksum: String,
    size: u64,
    data_base64: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Base64WorkspaceImportOperationResponse {
    import_id: String,
    status: v2::WorkspaceImportOperationStatus,
    receipt_base64: String,
}

impl From<WorkspaceImportOperationResult> for Base64WorkspaceImportOperationResponse {
    fn from(value: WorkspaceImportOperationResult) -> Self {
        Self {
            import_id: value.import_id,
            status: value.status,
            receipt_base64: BASE64_STANDARD.encode(value.receipt),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl CommandError {
    fn task(message: String) -> Self {
        Self {
            code: "databaseTaskFailed",
            message,
        }
    }

    fn onenote(message: String) -> Self {
        Self {
            code: "onenoteSystemBrowserFailed",
            message,
        }
    }
}

impl From<StorageError> for CommandError {
    fn from(error: StorageError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

#[tauri::command]
async fn load_workspace(
    database: tauri::State<'_, Database>,
) -> Result<WorkspaceState, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.load_workspace())
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn save_workspace(
    database: tauri::State<'_, Database>,
    workspace: WorkspaceState,
) -> Result<WorkspaceState, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.save_workspace(&workspace))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_put_document(
    database: tauri::State<'_, Database>,
    request: PutDocumentRequest,
) -> Result<DocumentMetadata, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_put_document(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_document(
    database: tauri::State<'_, Database>,
    document_id: String,
) -> Result<Option<DocumentBlob>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_get_document(&document_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_document_chunk(
    database: tauri::State<'_, Database>,
    document_id: String,
    chunk_index: u32,
) -> Result<Option<DocumentChunk>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_get_document_chunk(&document_id, chunk_index)
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_list_documents(
    database: tauri::State<'_, Database>,
    notebook_id: String,
    after_document_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<DocumentMetadata>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_list_documents(&notebook_id, after_document_id.as_deref(), limit)
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_delete_document(
    database: tauri::State<'_, Database>,
    document_id: String,
) -> Result<bool, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_delete_document(&document_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_put_asset(
    database: tauri::State<'_, Database>,
    request: PutAssetRequest,
) -> Result<AssetMetadata, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_put_asset(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_asset_metadata(
    database: tauri::State<'_, Database>,
    asset_id: String,
) -> Result<Option<AssetMetadata>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_get_asset_metadata(&asset_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_asset(
    database: tauri::State<'_, Database>,
    asset_id: String,
) -> Result<Option<AssetBlob>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_get_asset(&asset_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_repo_load(
    database: tauri::State<'_, Database>,
    key: Vec<String>,
) -> Result<Option<Vec<u8>>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_repo_load(&key))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_repo_save(
    database: tauri::State<'_, Database>,
    key: Vec<String>,
    data: Vec<u8>,
) -> Result<(), CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_repo_save(RepoStorageEntry { key, data })
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_repo_remove(
    database: tauri::State<'_, Database>,
    key: Vec<String>,
) -> Result<bool, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_repo_remove(&key))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_repo_load_range(
    database: tauri::State<'_, Database>,
    prefix: Vec<String>,
) -> Result<Vec<RepoStorageEntry>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_repo_load_range(&prefix))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_repo_remove_range(
    database: tauri::State<'_, Database>,
    prefix: Vec<String>,
) -> Result<u64, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_repo_remove_range(&prefix))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_repo_load_base64(
    database: tauri::State<'_, Database>,
    key: Vec<String>,
) -> Result<Option<String>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database
            .v2_repo_load(&key)
            .map(|value| value.map(|bytes| BASE64_STANDARD.encode(bytes)))
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_repo_load_range_base64(
    database: tauri::State<'_, Database>,
    prefix: Vec<String>,
) -> Result<Vec<Base64RepoEntryResponse>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_repo_load_range(&prefix).map(|entries| {
            entries
                .into_iter()
                .map(|entry| Base64RepoEntryResponse {
                    key: entry.key,
                    data_base64: BASE64_STANDARD.encode(entry.data),
                })
                .collect()
        })
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_repo_commit_base64(
    database: tauri::State<'_, Database>,
    mutations: Vec<Base64RepoMutationRequest>,
) -> Result<(), CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if mutations.len() > MAX_BASE64_ATOMIC_MUTATIONS {
            return Err(StorageError::LimitExceeded(
                "atomic Repo commit contains too many mutations".to_owned(),
            ));
        }
        let mut decoded = Vec::with_capacity(mutations.len());
        let mut total_bytes = 0usize;
        for mutation in mutations {
            decoded.push(match mutation {
                Base64RepoMutationRequest::Save { key, data_base64 } => {
                    let data = decode_repo_base64(&data_base64, "repo mutation dataBase64")?;
                    total_bytes = total_bytes.checked_add(data.len()).ok_or_else(|| {
                        StorageError::LimitExceeded(
                            "atomic Repo commit byte count overflowed".to_owned(),
                        )
                    })?;
                    if total_bytes > MAX_BASE64_ATOMIC_WRITE_BYTES {
                        return Err(StorageError::LimitExceeded(
                            "atomic Repo commit exceeds the byte limit".to_owned(),
                        ));
                    }
                    RepoStorageMutation::Save { key, data }
                }
                Base64RepoMutationRequest::Remove { key } => RepoStorageMutation::Remove { key },
            });
        }
        database.v2_repo_commit(decoded)
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_stage_migration(
    database: tauri::State<'_, Database>,
    request: StageMigrationRequest,
) -> Result<MigrationMarker, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_stage_migration(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_stage_workspace_migration_base64(
    database: tauri::State<'_, Database>,
    request: Base64WorkspaceMigrationRequest,
) -> Result<MigrationMarker, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if request.assets.len() > MAX_BASE64_MIGRATION_ASSETS
            || request.repo_entries.len() > MAX_BASE64_ATOMIC_MUTATIONS
        {
            return Err(StorageError::LimitExceeded(
                "workspace migration contains too many assets or Repo entries".to_owned(),
            ));
        }
        let assets = request
            .assets
            .into_iter()
            .map(|asset| {
                Ok(PutAssetRequest {
                    asset_id: asset.asset_id,
                    mime_type: asset.mime_type,
                    bytes: decode_base64(
                        &asset.data_base64,
                        "migration asset dataBase64",
                        MAX_BASE64_ASSET_BYTES,
                    )?,
                    created_at: asset.created_at,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        let repo_entries = request
            .repo_entries
            .into_iter()
            .map(|entry| {
                Ok(RepoStorageEntry {
                    key: entry.key,
                    data: decode_repo_base64(
                        &entry.data_base64,
                        "migration repo entry dataBase64",
                    )?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        database.v2_stage_migration(StageMigrationRequest {
            identity: request.identity,
            prepared_at: request.prepared_at,
            manifest: decode_base64(
                &request.manifest_base64,
                "migration manifestBase64",
                MAX_BASE64_MANIFEST_BYTES,
            )?,
            documents: vec![],
            assets,
            repo_entries,
            workspace_authority: Some(v2::MigrationWorkspaceAuthority {
                activation: decode_base64(
                    &request.activation_base64,
                    "migration activationBase64",
                    MAX_BASE64_ACTIVATION_BYTES,
                )?,
                backup: decode_base64(
                    &request.backup_base64,
                    "migration backupBase64",
                    MAX_BASE64_BACKUP_BYTES,
                )?,
            }),
        })
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_commit_migration(
    database: tauri::State<'_, Database>,
    request: CommitMigrationRequest,
) -> Result<MigrationMarker, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_commit_migration(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_rollback_migration(
    database: tauri::State<'_, Database>,
    request: RollbackMigrationRequest,
) -> Result<MigrationMarker, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_rollback_migration(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_migration_marker(
    database: tauri::State<'_, Database>,
    migration_id: String,
) -> Result<Option<MigrationMarker>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_get_migration_marker(&migration_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_workspace_authority_base64(
    database: tauri::State<'_, Database>,
) -> Result<Option<Base64WorkspaceAuthorityResponse>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database
            .v2_get_workspace_authority()
            .map(|authority| authority.map(Base64WorkspaceAuthorityResponse::from))
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_asset_base64(
    database: tauri::State<'_, Database>,
    asset_id: String,
) -> Result<Option<Base64AssetResponse>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_get_asset(&asset_id).map(|asset| {
            asset.map(|blob| Base64AssetResponse {
                asset_id: blob.metadata.asset_id.clone(),
                checksum: blob.metadata.asset_id,
                size: blob.metadata.byte_size,
                data_base64: BASE64_STANDARD.encode(blob.bytes),
            })
        })
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_put_outbox(
    database: tauri::State<'_, Database>,
    request: PutOutboxRequest,
) -> Result<OutboxRecord, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_put_outbox(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

fn decode_base64_assets(
    assets: Vec<Base64MigrationAssetRequest>,
) -> Result<Vec<PutAssetRequest>, StorageError> {
    if assets.len() > MAX_BASE64_MIGRATION_ASSETS {
        return Err(StorageError::LimitExceeded(
            "workspace operation contains too many assets".to_owned(),
        ));
    }
    assets
        .into_iter()
        .map(|asset| {
            Ok(PutAssetRequest {
                asset_id: asset.asset_id,
                mime_type: asset.mime_type,
                bytes: decode_base64(
                    &asset.data_base64,
                    "workspace asset dataBase64",
                    MAX_BASE64_ASSET_BYTES,
                )?,
                created_at: asset.created_at,
            })
        })
        .collect()
}

fn decode_base64_repo_entries(
    entries: Vec<Base64RepoEntryRequest>,
) -> Result<Vec<RepoStorageEntry>, StorageError> {
    if entries.len() > MAX_BASE64_ATOMIC_MUTATIONS {
        return Err(StorageError::LimitExceeded(
            "workspace operation contains too many Repo entries".to_owned(),
        ));
    }
    entries
        .into_iter()
        .map(|entry| {
            Ok(RepoStorageEntry {
                key: entry.key,
                data: decode_repo_base64(&entry.data_base64, "workspace Repo dataBase64")?,
            })
        })
        .collect()
}

#[tauri::command]
async fn v2_additive_import_base64(
    database: tauri::State<'_, Database>,
    request: Base64WorkspaceAdditiveImportRequest,
) -> Result<Base64WorkspaceImportOperationResponse, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database
            .v2_additive_import(WorkspaceAdditiveImportRequest {
                expected_activation: decode_base64(
                    &request.expected_activation_base64,
                    "expectedActivationBase64",
                    MAX_BASE64_ACTIVATION_BYTES,
                )?,
                activation: decode_base64(
                    &request.activation_base64,
                    "activationBase64",
                    MAX_BASE64_ACTIVATION_BYTES,
                )?,
                receipt: decode_base64(
                    &request.receipt_base64,
                    "receiptBase64",
                    MAX_BASE64_MANIFEST_BYTES,
                )?,
                assets: decode_base64_assets(request.assets)?,
                repo_entries: decode_base64_repo_entries(request.repo_entries)?,
            })
            .map(Base64WorkspaceImportOperationResponse::from)
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_workspace_import_receipt_base64(
    database: tauri::State<'_, Database>,
    import_id: String,
) -> Result<Option<String>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database
            .v2_get_workspace_import_receipt(&import_id)
            .map(|receipt| receipt.map(|bytes| BASE64_STANDARD.encode(bytes)))
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_rollback_workspace_import(
    database: tauri::State<'_, Database>,
    request: RollbackWorkspaceImportRequest,
) -> Result<Base64WorkspaceImportOperationResponse, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database
            .v2_rollback_workspace_import(request)
            .map(Base64WorkspaceImportOperationResponse::from)
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_commit_workspace_revision_base64(
    database: tauri::State<'_, Database>,
    request: Base64WorkspaceRevisionRequest,
) -> Result<WorkspaceRevisionCommitStatus, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_commit_workspace_revision(WorkspaceRevisionCommitRequest {
            expected_activation: decode_base64(
                &request.expected_activation_base64,
                "expectedActivationBase64",
                MAX_BASE64_ACTIVATION_BYTES,
            )?,
            activation: decode_base64(
                &request.activation_base64,
                "activationBase64",
                MAX_BASE64_ACTIVATION_BYTES,
            )?,
            assets: decode_base64_assets(request.assets)?,
            repo_entries: decode_base64_repo_entries(request.repo_entries)?,
        })
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_commit_workspace_delta_base64(
    database: tauri::State<'_, Database>,
    request: Base64WorkspaceDeltaRequest,
) -> Result<WorkspaceRevisionCommitStatus, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_commit_workspace_delta(WorkspaceDeltaCommitRequest {
            expected_activation: decode_base64(
                &request.expected_activation_base64,
                "expectedActivationBase64",
                MAX_BASE64_ACTIVATION_BYTES,
            )?,
            activation: decode_base64(
                &request.activation_base64,
                "activationBase64",
                MAX_BASE64_ACTIVATION_BYTES,
            )?,
            receipt: request
                .receipt_base64
                .map(|receipt| decode_base64(&receipt, "receiptBase64", MAX_BASE64_MANIFEST_BYTES))
                .transpose()?,
            assets: decode_base64_assets(request.assets)?,
            repo_entries: decode_base64_repo_entries(request.repo_entries)?,
            removed_prefixes: request.removed_prefixes,
        })
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_stage_workspace_entries_base64(
    database: tauri::State<'_, Database>,
    request: Base64WorkspaceStageRequest,
) -> Result<(), CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_stage_workspace_entries(WorkspaceStageEntriesRequest {
            assets: decode_base64_assets(request.assets)?,
            repo_entries: decode_base64_repo_entries(request.repo_entries)?,
        })
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_list_outbox(
    database: tauri::State<'_, Database>,
    notebook_id: String,
    after_local_order: Option<u64>,
    limit: Option<u32>,
) -> Result<Vec<OutboxRecord>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        database.v2_list_outbox(&notebook_id, after_local_order, limit)
    })
    .await
    .map_err(|error| CommandError::task(error.to_string()))?
    .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_delete_outbox(
    database: tauri::State<'_, Database>,
    request: DeleteOutboxRequest,
) -> Result<bool, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_delete_outbox(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_put_sync_cursor(
    database: tauri::State<'_, Database>,
    cursor: SyncCursor,
) -> Result<SyncCursor, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_put_sync_cursor(cursor))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_sync_cursor(
    database: tauri::State<'_, Database>,
    notebook_id: String,
) -> Result<Option<SyncCursor>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_get_sync_cursor(&notebook_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_reset_sync_cursor(
    database: tauri::State<'_, Database>,
    request: ResetSyncCursorRequest,
) -> Result<SyncCursor, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_reset_sync_cursor(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_put_snapshot(
    database: tauri::State<'_, Database>,
    request: PutSnapshotRequest,
) -> Result<SnapshotMetadata, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_put_snapshot(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_get_snapshot(
    database: tauri::State<'_, Database>,
    snapshot_id: String,
) -> Result<Option<SnapshotBlob>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_get_snapshot(&snapshot_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_list_snapshots(
    database: tauri::State<'_, Database>,
    document_id: String,
    limit: Option<u32>,
) -> Result<Vec<SnapshotMetadata>, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_list_snapshots(&document_id, limit))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_delete_snapshot(
    database: tauri::State<'_, Database>,
    snapshot_id: String,
) -> Result<bool, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_delete_snapshot(&snapshot_id))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
async fn v2_delete_snapshot_guarded(
    database: tauri::State<'_, Database>,
    request: DeleteSnapshotGuardedRequest,
) -> Result<bool, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.v2_delete_snapshot_guarded(request))
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, StorageError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| StorageError::AppDataPath(error.to_string()))?;
    Ok(app_data.join("canvink").join("notebook.sqlite"))
}

fn app_data_path(app: &tauri::AppHandle) -> Result<PathBuf, StorageError> {
    app.path()
        .app_data_dir()
        .map_err(|error| StorageError::AppDataPath(error.to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // First, so a second launch carrying `canvink://…` (Windows starts a new
    // process per deep link) is forwarded to this instance's deep-link
    // plugin (the `deep-link` feature) instead of opening a second window.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    // The updater downloads a signed installer; the process plugin only
    // relaunches the app after the frontend has flushed its edits. Android is
    // replaced through the system package installer instead.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    // Opens the sign-in page in the system browser (desktop_auth).
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_opener::init());
    builder
        .plugin(tauri_plugin_deep_link::init())
        .manage(desktop_auth::DesktopAuthState::default())
        .setup(|app| {
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Installers register `canvink://`; a debug build registers
                // itself so `tauri dev` can receive the sign-in too.
                #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
                let _ = app.deep_link().register_all();
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        desktop_auth::handle_deep_link(&handle, &url);
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        desktop_auth::handle_deep_link(app.handle(), &url);
                    }
                }
            }
            let database = Database::new(database_path(app.handle())?);
            database.initialize()?;
            app.manage(database);
            app.manage(math_recognition::MathRecognitionState::new(app_data_path(
                app.handle(),
            )?));
            app.manage(math_units::MathUnitsState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            protect_key_material,
            unprotect_key_material,
            math_recognition::math_provider_configure,
            math_recognition::math_provider_status,
            math_recognition::math_provider_delete,
            math_recognition::math_recognition_cancel,
            math_recognition::math_recognize,
            math_units::math_units_convert,
            math_units::math_currency_convert,
            v2_put_document,
            v2_get_document,
            v2_get_document_chunk,
            v2_list_documents,
            v2_delete_document,
            v2_put_asset,
            v2_get_asset_metadata,
            v2_get_asset,
            v2_repo_load,
            v2_repo_save,
            v2_repo_remove,
            v2_repo_load_range,
            v2_repo_remove_range,
            v2_repo_load_base64,
            v2_repo_load_range_base64,
            v2_repo_commit_base64,
            v2_stage_migration,
            v2_stage_workspace_migration_base64,
            v2_commit_migration,
            v2_rollback_migration,
            v2_get_migration_marker,
            v2_get_workspace_authority_base64,
            v2_get_asset_base64,
            v2_additive_import_base64,
            v2_get_workspace_import_receipt_base64,
            v2_rollback_workspace_import,
            v2_commit_workspace_revision_base64,
            v2_commit_workspace_delta_base64,
            v2_stage_workspace_entries_base64,
            v2_put_outbox,
            v2_list_outbox,
            v2_delete_outbox,
            v2_put_sync_cursor,
            v2_get_sync_cursor,
            v2_reset_sync_cursor,
            v2_put_snapshot,
            v2_get_snapshot,
            v2_list_snapshots,
            v2_delete_snapshot,
            v2_delete_snapshot_guarded,
            ocr::ocr_available_languages,
            ocr::ocr_recognize_image,
            search::search_v2_replace,
            search::search_v2_upsert,
            search::search_v2_remove,
            search::search_v2_clear,
            search::search_v2_query,
            android_update::android_update_check,
            android_update::android_update_open,
            desktop_auth::desktop_auth_status,
            desktop_auth::desktop_login_start,
            desktop_auth::desktop_login_cancel,
            desktop_auth::desktop_login_submit,
            desktop_auth::desktop_access_token,
            desktop_auth::desktop_logout,
            onenote_auth::onenote_system_browser_authorize,
            onenote_auth::onenote_cancel_system_browser_authorization,
            onenote_auth::onenote_open_system_browser_logout,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Canvink");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_ipc_decoder_requires_canonical_padding_and_limits() {
        assert_eq!(
            decode_base64("AQID", "test", 3).expect("canonical Base64 decodes"),
            vec![1, 2, 3]
        );
        assert!(matches!(
            decode_base64("AQI", "test", 3),
            Err(StorageError::InvalidV2(_))
        ));
        assert!(matches!(
            decode_base64("AQI=\n", "test", 3),
            Err(StorageError::LimitExceeded(_) | StorageError::InvalidV2(_))
        ));
        assert!(matches!(
            decode_base64("AQID", "test", 2),
            Err(StorageError::LimitExceeded(_))
        ));
        assert_eq!(
            decode_repo_base64("", "repo").expect("empty Repo values are valid"),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn repo_mutation_ipc_accepts_renderer_camel_case() {
        let mutation: Base64RepoMutationRequest = serde_json::from_value(serde_json::json!({
            "type": "save",
            "key": ["automerge-repo", "document"],
            "dataBase64": "AQID"
        }))
        .expect("renderer-shaped Repo mutation deserializes");

        match mutation {
            Base64RepoMutationRequest::Save { key, data_base64 } => {
                assert_eq!(key, ["automerge-repo", "document"]);
                assert_eq!(data_base64, "AQID");
            }
            Base64RepoMutationRequest::Remove { .. } => panic!("expected a save mutation"),
        }

        assert!(
            serde_json::from_value::<Base64RepoMutationRequest>(serde_json::json!({
                "type": "save",
                "key": ["automerge-repo", "document"],
                "data_base64": "AQID"
            }))
            .is_err()
        );
    }
}
