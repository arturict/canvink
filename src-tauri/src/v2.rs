use std::{cmp::Ordering, collections::HashSet};

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::storage::{Database, StorageError};

const MAX_ID_BYTES: usize = 256;
const MAX_TIMESTAMP_BYTES: usize = 64;
const MAX_NAME_BYTES: usize = 512;
const MAX_MIME_BYTES: usize = 255;
const MAX_HEADS: usize = 256;
const MAX_HEAD_BYTES: usize = 256;
const MAX_DOCUMENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_DOCUMENT_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const MAX_DOCUMENT_CHUNKS: usize = 4_096;
const MAX_ASSET_BYTES: usize = 64 * 1024 * 1024;
const MAX_OUTBOX_BYTES: usize = 8 * 1024 * 1024;
const MAX_REPO_KEY_COMPONENTS: usize = 32;
const MAX_REPO_KEY_COMPONENT_BYTES: usize = 4 * 1024;
const MAX_REPO_KEY_BYTES: usize = 16 * 1024;
const MAX_REPO_ENCODED_KEY_BYTES: usize = MAX_REPO_KEY_BYTES * 2 + MAX_REPO_KEY_COMPONENTS;
const MAX_REPO_VALUE_BYTES: usize = 32 * 1024 * 1024;
const MAX_REPO_RANGE_ENTRIES: usize = 10_000;
const MAX_REPO_RANGE_BYTES: usize = 128 * 1024 * 1024;
const MAX_REPO_ATOMIC_MUTATIONS: usize = 20_000;
const MAX_MANIFEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_ACTIVATION_BYTES: usize = 16 * 1024 * 1024;
const MAX_V1_BACKUP_BYTES: usize = 256 * 1024 * 1024;
const MAX_MIGRATION_DOCUMENTS: usize = 100_000;
const MAX_MIGRATION_ASSETS: usize = 10_000;
const MAX_MIGRATION_BYTES: usize = 256 * 1024 * 1024;
const MAX_LIST_LIMIT: u32 = 1_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocumentKind {
    Notebook,
    Page,
}

impl DocumentKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Notebook => "notebook",
            Self::Page => "page",
        }
    }

    fn parse(value: &str) -> Result<Self, StorageError> {
        match value {
            "notebook" => Ok(Self::Notebook),
            "page" => Ok(Self::Page),
            _ => Err(StorageError::CorruptData(format!(
                "invalid schema-v2 document kind `{value}`"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentFormat {
    CanvinkJsonV2,
    Automerge,
}

impl DocumentFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::CanvinkJsonV2 => "canvink-json-v2",
            Self::Automerge => "automerge",
        }
    }

    fn parse(value: &str) -> Result<Self, StorageError> {
        match value {
            "canvink-json-v2" => Ok(Self::CanvinkJsonV2),
            "automerge" => Ok(Self::Automerge),
            _ => Err(StorageError::CorruptData(format!(
                "invalid schema-v2 document format `{value}`"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocumentEncoding {
    Utf8Json,
    Binary,
}

impl DocumentEncoding {
    fn as_str(self) -> &'static str {
        match self {
            Self::Utf8Json => "utf8-json",
            Self::Binary => "binary",
        }
    }

    fn parse(value: &str) -> Result<Self, StorageError> {
        match value {
            "utf8-json" => Ok(Self::Utf8Json),
            "binary" => Ok(Self::Binary),
            _ => Err(StorageError::CorruptData(format!(
                "invalid schema-v2 document encoding `{value}`"
            ))),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutDocumentRequest {
    pub document_id: String,
    pub notebook_id: String,
    pub kind: DocumentKind,
    pub document_format: DocumentFormat,
    pub encoding: DocumentEncoding,
    pub heads: Vec<String>,
    pub updated_at: String,
    pub expected_sha256: String,
    #[serde(default)]
    pub bytes: Option<Vec<u8>>,
    #[serde(default)]
    pub chunks: Option<Vec<Vec<u8>>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMetadata {
    pub document_id: String,
    pub notebook_id: String,
    pub kind: DocumentKind,
    pub document_format: DocumentFormat,
    pub encoding: DocumentEncoding,
    pub sha256: String,
    pub byte_size: u64,
    pub chunk_count: u32,
    pub heads: Vec<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentBlob {
    pub metadata: DocumentMetadata,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentChunk {
    pub document_id: String,
    pub chunk_index: u32,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutAssetRequest {
    pub asset_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMetadata {
    pub asset_id: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBlob {
    pub metadata: AssetMetadata,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoStorageEntry {
    pub key: Vec<String>,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum RepoStorageMutation {
    Save { key: Vec<String>, data: Vec<u8> },
    Remove { key: Vec<String> },
}

struct PreparedRepoEntry {
    key_encoded: String,
    key_json: String,
    hash: String,
    data: Vec<u8>,
}

enum PreparedRepoMutation {
    Save(PreparedRepoEntry),
    Remove(String),
}

struct PreparedDocument {
    metadata: DocumentMetadata,
    hash: String,
    chunks: Vec<PreparedChunk>,
}

struct PreparedChunk {
    hash: String,
    bytes: Vec<u8>,
}

struct PreparedAsset {
    metadata: AssetMetadata,
    hash: String,
    bytes: Vec<u8>,
}

fn validate_id(value: &str, label: &str) -> Result<(), StorageError> {
    if value.is_empty() || value.len() > MAX_ID_BYTES {
        return Err(StorageError::InvalidV2(format!(
            "{label} must contain 1 to {MAX_ID_BYTES} ASCII bytes"
        )));
    }
    if !value.as_bytes().iter().enumerate().all(|(index, byte)| {
        byte.is_ascii_alphanumeric() || (index > 0 && matches!(*byte, b'-' | b'_' | b'.' | b':'))
    }) {
        return Err(StorageError::InvalidV2(format!(
            "{label} contains a non-canonical character"
        )));
    }
    Ok(())
}

fn validate_timestamp(value: &str, label: &str) -> Result<(), StorageError> {
    let bytes = value.as_bytes();
    let fixed = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    let digit_ranges = [0..4, 5..7, 8..10, 11..13, 14..16, 17..19];
    let valid_fraction = bytes.get(19) == Some(&b'Z')
        || (bytes.get(19) == Some(&b'.')
            && bytes.len() > 21
            && bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit));
    let two_digits = |start: usize| -> u32 {
        u32::from(bytes[start] - b'0') * 10 + u32::from(bytes[start + 1] - b'0')
    };
    if bytes.len() < 20
        || bytes.len() > MAX_TIMESTAMP_BYTES
        || !value.is_ascii()
        || !fixed
            .iter()
            .all(|(index, expected)| bytes.get(*index) == Some(expected))
        || !digit_ranges.iter().all(|range| {
            bytes
                .get(range.clone())
                .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
        })
        || !value.ends_with('Z')
        || !valid_fraction
        || bytes.iter().any(|byte| byte.is_ascii_control())
        || !(1..=12).contains(&two_digits(5))
        || !(1..=31).contains(&two_digits(8))
        || two_digits(11) > 23
        || two_digits(14) > 59
        || two_digits(17) > 59
    {
        return Err(StorageError::InvalidV2(format!(
            "{label} must be a bounded UTC ISO-8601 timestamp"
        )));
    }
    Ok(())
}

fn validate_heads(heads: &[String]) -> Result<String, StorageError> {
    if heads.len() > MAX_HEADS {
        return Err(StorageError::LimitExceeded(format!(
            "a document may have at most {MAX_HEADS} heads"
        )));
    }
    let mut unique = HashSet::with_capacity(heads.len());
    for head in heads {
        if head.is_empty()
            || head.len() > MAX_HEAD_BYTES
            || !head.is_ascii()
            || head
                .bytes()
                .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
        {
            return Err(StorageError::InvalidV2(
                "document heads must be bounded non-whitespace ASCII strings".to_owned(),
            ));
        }
        if !unique.insert(head) {
            return Err(StorageError::InvalidV2(
                "document heads must not contain duplicates".to_owned(),
            ));
        }
    }
    Ok(serde_json::to_string(heads)?)
}

fn validate_mime(value: &str) -> Result<(), StorageError> {
    if value.is_empty()
        || value.len() > MAX_MIME_BYTES
        || value.trim() != value
        || !value.is_ascii()
        || !value.contains('/')
        || value
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(StorageError::InvalidV2(
            "mimeType must be a bounded canonical ASCII media type".to_owned(),
        ));
    }
    Ok(())
}

fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

fn parse_sha256(value: &str, label: &str) -> Result<String, StorageError> {
    let Some(hash) = value.strip_prefix("sha256:") else {
        return Err(StorageError::InvalidV2(format!(
            "{label} must use the canonical sha256:<digest> form"
        )));
    };
    if hash.len() != 64
        || !hash
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(*byte, b'a'..=b'f'))
    {
        return Err(StorageError::InvalidV2(format!(
            "{label} must contain 64 lowercase hexadecimal characters"
        )));
    }
    Ok(hash.to_owned())
}

fn external_hash(hash: &str) -> String {
    format!("sha256:{hash}")
}

fn prepare_repo_key(key: &[String], allow_empty: bool) -> Result<(String, String), StorageError> {
    if (!allow_empty && key.is_empty()) || key.len() > MAX_REPO_KEY_COMPONENTS {
        return Err(StorageError::InvalidV2(format!(
            "repo storage key must contain {} to {MAX_REPO_KEY_COMPONENTS} components",
            usize::from(!allow_empty)
        )));
    }
    let mut encoded = String::new();
    let mut total_bytes = 0usize;
    for component in key {
        if component.is_empty()
            || component.len() > MAX_REPO_KEY_COMPONENT_BYTES
            || component
                .chars()
                .any(|character| (character as u32) <= 0x1f || character as u32 == 0x7f)
        {
            return Err(StorageError::InvalidV2(format!(
                "repo storage key components must be non-empty, control-free, and at most {MAX_REPO_KEY_COMPONENT_BYTES} UTF-8 bytes"
            )));
        }
        total_bytes += component.len();
        if total_bytes > MAX_REPO_KEY_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "a repo storage key may contain at most {MAX_REPO_KEY_BYTES} UTF-8 bytes"
            )));
        }
        encoded.reserve(component.len() * 2 + 1);
        for byte in component.as_bytes() {
            use std::fmt::Write as _;
            write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
        }
        encoded.push('/');
    }
    if encoded.len() > MAX_REPO_ENCODED_KEY_BYTES {
        return Err(StorageError::LimitExceeded(
            "encoded repo storage key is too large".to_owned(),
        ));
    }
    Ok((encoded, serde_json::to_string(key)?))
}

fn prepare_repo_entry(entry: RepoStorageEntry) -> Result<PreparedRepoEntry, StorageError> {
    let (key_encoded, key_json) = prepare_repo_key(&entry.key, false)?;
    if entry.data.len() > MAX_REPO_VALUE_BYTES {
        return Err(StorageError::LimitExceeded(format!(
            "a repo storage value may contain at most {MAX_REPO_VALUE_BYTES} bytes"
        )));
    }
    Ok(PreparedRepoEntry {
        key_encoded,
        key_json,
        hash: hash_bytes(&entry.data),
        data: entry.data,
    })
}

fn checked_limit(limit: Option<u32>) -> Result<i64, StorageError> {
    let value = limit.unwrap_or(100);
    if value == 0 || value > MAX_LIST_LIMIT {
        return Err(StorageError::InvalidV2(format!(
            "list limit must be between 1 and {MAX_LIST_LIMIT}"
        )));
    }
    Ok(i64::from(value))
}

fn prepare_document(request: PutDocumentRequest) -> Result<PreparedDocument, StorageError> {
    validate_id(&request.document_id, "documentId")?;
    validate_id(&request.notebook_id, "notebookId")?;
    validate_timestamp(&request.updated_at, "updatedAt")?;
    validate_heads(&request.heads)?;
    if matches!(request.document_format, DocumentFormat::Automerge)
        && !matches!(request.encoding, DocumentEncoding::Binary)
    {
        return Err(StorageError::InvalidV2(
            "Automerge documents must use binary encoding".to_owned(),
        ));
    }
    if matches!(request.document_format, DocumentFormat::CanvinkJsonV2)
        && !matches!(request.encoding, DocumentEncoding::Utf8Json)
    {
        return Err(StorageError::InvalidV2(
            "Canvink JSON documents must use utf8-json encoding".to_owned(),
        ));
    }

    let chunks = match (request.bytes, request.chunks) {
        (Some(bytes), None) => {
            if bytes.is_empty() {
                return Err(StorageError::InvalidV2(
                    "document bytes must not be empty".to_owned(),
                ));
            }
            bytes
                .chunks(MAX_DOCUMENT_CHUNK_BYTES)
                .map(|chunk| chunk.to_vec())
                .collect::<Vec<_>>()
        }
        (None, Some(chunks)) if !chunks.is_empty() => chunks,
        _ => {
            return Err(StorageError::InvalidV2(
                "exactly one of bytes or non-empty chunks must be supplied".to_owned(),
            ))
        }
    };
    if chunks.len() > MAX_DOCUMENT_CHUNKS {
        return Err(StorageError::LimitExceeded(format!(
            "a document may have at most {MAX_DOCUMENT_CHUNKS} chunks"
        )));
    }
    let mut total = 0usize;
    let mut hasher = Sha256::new();
    let mut prepared_chunks = Vec::with_capacity(chunks.len());
    for bytes in chunks {
        if bytes.is_empty() || bytes.len() > MAX_DOCUMENT_CHUNK_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "every document chunk must contain 1 to {MAX_DOCUMENT_CHUNK_BYTES} bytes"
            )));
        }
        total = total.checked_add(bytes.len()).ok_or_else(|| {
            StorageError::LimitExceeded("document byte count overflowed".to_owned())
        })?;
        if total > MAX_DOCUMENT_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "a document may contain at most {MAX_DOCUMENT_BYTES} bytes"
            )));
        }
        hasher.update(&bytes);
        prepared_chunks.push(PreparedChunk {
            hash: hash_bytes(&bytes),
            bytes,
        });
    }
    let hash = {
        let digest = hasher.finalize();
        let mut output = String::with_capacity(64);
        for byte in digest {
            use std::fmt::Write as _;
            write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
        }
        output
    };
    let expected = parse_sha256(&request.expected_sha256, "expectedSha256")?;
    if hash != expected {
        return Err(StorageError::Integrity(format!(
            "document {} does not match expectedSha256",
            request.document_id
        )));
    }
    if matches!(request.encoding, DocumentEncoding::Utf8Json) {
        let joined = prepared_chunks
            .iter()
            .flat_map(|chunk| chunk.bytes.iter().copied())
            .collect::<Vec<_>>();
        let text = std::str::from_utf8(&joined).map_err(|_| {
            StorageError::InvalidV2("utf8-json document is not valid UTF-8".to_owned())
        })?;
        serde_json::from_str::<serde_json::Value>(text).map_err(|error| {
            StorageError::InvalidV2(format!("utf8-json document is not valid JSON: {error}"))
        })?;
    }
    Ok(PreparedDocument {
        metadata: DocumentMetadata {
            document_id: request.document_id,
            notebook_id: request.notebook_id,
            kind: request.kind,
            document_format: request.document_format,
            encoding: request.encoding,
            sha256: external_hash(&hash),
            byte_size: total as u64,
            chunk_count: prepared_chunks.len() as u32,
            heads: request.heads,
            updated_at: request.updated_at,
        },
        hash,
        chunks: prepared_chunks,
    })
}

fn prepare_asset(request: PutAssetRequest) -> Result<PreparedAsset, StorageError> {
    validate_mime(&request.mime_type)?;
    validate_timestamp(&request.created_at, "createdAt")?;
    if request.bytes.is_empty() || request.bytes.len() > MAX_ASSET_BYTES {
        return Err(StorageError::LimitExceeded(format!(
            "an asset must contain 1 to {MAX_ASSET_BYTES} bytes"
        )));
    }
    let expected = parse_sha256(&request.asset_id, "assetId")?;
    let actual = hash_bytes(&request.bytes);
    if actual != expected {
        return Err(StorageError::Integrity(
            "asset bytes do not match assetId".to_owned(),
        ));
    }
    Ok(PreparedAsset {
        metadata: AssetMetadata {
            asset_id: external_hash(&actual),
            mime_type: request.mime_type,
            byte_size: request.bytes.len() as u64,
            created_at: request.created_at,
        },
        hash: actual,
        bytes: request.bytes,
    })
}

impl Database {
    pub fn v2_put_document(
        &self,
        request: PutDocumentRequest,
    ) -> Result<DocumentMetadata, StorageError> {
        let prepared = prepare_document(request)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        store_document(&transaction, &prepared)?;
        transaction.commit()?;
        Ok(prepared.metadata)
    }

    pub fn v2_get_document(&self, document_id: &str) -> Result<Option<DocumentBlob>, StorageError> {
        validate_id(document_id, "documentId")?;
        let connection = self.connect()?;
        let Some(metadata) = read_document_metadata(&connection, document_id)? else {
            return Ok(None);
        };
        let mut statement = connection.prepare(
            "SELECT chunk_index, chunk_hash, byte_size, payload
             FROM crdt_document_chunks
             WHERE document_id = ?1
             ORDER BY chunk_index",
        )?;
        let rows = statement
            .query_map([document_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len() != metadata.chunk_count as usize {
            return Err(StorageError::CorruptData(format!(
                "document {document_id} has an inconsistent chunk count"
            )));
        }
        let capacity = usize::try_from(metadata.byte_size).map_err(|_| {
            StorageError::CorruptData(format!("document {document_id} is too large"))
        })?;
        if capacity > MAX_DOCUMENT_BYTES {
            return Err(StorageError::CorruptData(format!(
                "document {document_id} exceeds the supported byte limit"
            )));
        }
        let mut bytes = Vec::with_capacity(capacity);
        for (expected_index, (index, chunk_hash, byte_size, payload)) in
            rows.into_iter().enumerate()
        {
            if index != expected_index as i64
                || byte_size <= 0
                || byte_size as usize != payload.len()
                || payload.len() > MAX_DOCUMENT_CHUNK_BYTES
                || hash_bytes(&payload) != chunk_hash
            {
                return Err(StorageError::Integrity(format!(
                    "document {document_id} chunk {expected_index} failed verification"
                )));
            }
            bytes.extend_from_slice(&payload);
        }
        if bytes.len() != capacity || external_hash(&hash_bytes(&bytes)) != metadata.sha256 {
            return Err(StorageError::Integrity(format!(
                "document {document_id} failed complete-blob verification"
            )));
        }
        Ok(Some(DocumentBlob { metadata, bytes }))
    }

    pub fn v2_get_document_chunk(
        &self,
        document_id: &str,
        chunk_index: u32,
    ) -> Result<Option<DocumentChunk>, StorageError> {
        validate_id(document_id, "documentId")?;
        if chunk_index as usize >= MAX_DOCUMENT_CHUNKS {
            return Err(StorageError::InvalidV2(
                "chunkIndex exceeds the supported range".to_owned(),
            ));
        }
        let connection = self.connect()?;
        let Some(metadata) = read_document_metadata(&connection, document_id)? else {
            return Ok(None);
        };
        if chunk_index >= metadata.chunk_count {
            return Ok(None);
        }
        let row = connection
            .query_row(
                "SELECT chunk_hash, byte_size, payload
                 FROM crdt_document_chunks
                 WHERE document_id = ?1 AND chunk_index = ?2",
                params![document_id, i64::from(chunk_index)],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((hash, byte_size, bytes)) = row else {
            return Err(StorageError::Integrity(format!(
                "document {document_id} is missing chunk {chunk_index}"
            )));
        };
        if byte_size <= 0
            || byte_size as usize != bytes.len()
            || bytes.len() > MAX_DOCUMENT_CHUNK_BYTES
            || hash_bytes(&bytes) != hash
        {
            return Err(StorageError::Integrity(format!(
                "document {document_id} chunk {chunk_index} failed verification"
            )));
        }
        Ok(Some(DocumentChunk {
            document_id: document_id.to_owned(),
            chunk_index,
            sha256: external_hash(&hash),
            bytes,
        }))
    }

    pub fn v2_list_documents(
        &self,
        notebook_id: &str,
        after_document_id: Option<&str>,
        limit: Option<u32>,
    ) -> Result<Vec<DocumentMetadata>, StorageError> {
        validate_id(notebook_id, "notebookId")?;
        if let Some(after) = after_document_id {
            validate_id(after, "afterDocumentId")?;
        }
        let limit = checked_limit(limit)?;
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT id, notebook_id, document_kind, document_format, encoding,
                    content_hash, byte_size, chunk_count, heads_json, updated_at
             FROM crdt_documents
             WHERE notebook_id = ?1 AND (?2 IS NULL OR id > ?2)
             ORDER BY id
             LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                params![notebook_id, after_document_id, limit],
                document_metadata_from_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(parse_document_row).collect()
    }

    pub fn v2_delete_document(&self, document_id: &str) -> Result<bool, StorageError> {
        validate_id(document_id, "documentId")?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed =
            transaction.execute("DELETE FROM crdt_documents WHERE id = ?1", [document_id])?;
        transaction.commit()?;
        Ok(changed == 1)
    }

    pub fn v2_put_asset(&self, request: PutAssetRequest) -> Result<AssetMetadata, StorageError> {
        let prepared = prepare_asset(request)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let metadata = store_asset(&transaction, &prepared)?;
        transaction.commit()?;
        Ok(metadata)
    }

    pub fn v2_get_asset_metadata(
        &self,
        asset_id: &str,
    ) -> Result<Option<AssetMetadata>, StorageError> {
        self.v2_get_asset(asset_id)
            .map(|asset| asset.map(|blob| blob.metadata))
    }

    pub fn v2_get_asset(&self, asset_id: &str) -> Result<Option<AssetBlob>, StorageError> {
        let hash = parse_sha256(asset_id, "assetId")?;
        let connection = self.connect()?;
        let row = connection
            .query_row(
                "SELECT mime_type, byte_size, payload, created_at FROM assets WHERE hash = ?1",
                [&hash],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((mime_type, byte_size, bytes, created_at)) = row else {
            return Ok(None);
        };
        validate_mime(&mime_type).map_err(|error| {
            StorageError::CorruptData(format!("stored asset metadata is invalid: {error}"))
        })?;
        validate_timestamp(&created_at, "stored createdAt").map_err(|error| {
            StorageError::CorruptData(format!("stored asset timestamp is invalid: {error}"))
        })?;
        if byte_size <= 0
            || byte_size as usize != bytes.len()
            || bytes.len() > MAX_ASSET_BYTES
            || hash_bytes(&bytes) != hash
        {
            return Err(StorageError::Integrity(format!(
                "stored asset {asset_id} failed verification"
            )));
        }
        Ok(Some(AssetBlob {
            metadata: AssetMetadata {
                asset_id: asset_id.to_owned(),
                mime_type,
                byte_size: byte_size as u64,
                created_at,
            },
            bytes,
        }))
    }

    pub fn v2_repo_save(&self, entry: RepoStorageEntry) -> Result<(), StorageError> {
        let entry = prepare_repo_entry(entry)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        store_repo_entry(&transaction, &entry)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn v2_repo_commit(&self, mutations: Vec<RepoStorageMutation>) -> Result<(), StorageError> {
        if mutations.len() > MAX_REPO_ATOMIC_MUTATIONS {
            return Err(StorageError::LimitExceeded(format!(
                "an atomic repo commit may contain at most {MAX_REPO_ATOMIC_MUTATIONS} mutations"
            )));
        }
        let mut seen = HashSet::with_capacity(mutations.len());
        let mut total_bytes = 0usize;
        let mut prepared = Vec::with_capacity(mutations.len());
        for mutation in mutations {
            let mutation = match mutation {
                RepoStorageMutation::Save { key, data } => {
                    let entry = prepare_repo_entry(RepoStorageEntry { key, data })?;
                    total_bytes = total_bytes.checked_add(entry.data.len()).ok_or_else(|| {
                        StorageError::LimitExceeded(
                            "atomic repo commit byte count overflowed".to_owned(),
                        )
                    })?;
                    if total_bytes > MAX_MIGRATION_BYTES {
                        return Err(StorageError::LimitExceeded(format!(
                            "an atomic repo commit may write at most {MAX_MIGRATION_BYTES} bytes"
                        )));
                    }
                    PreparedRepoMutation::Save(entry)
                }
                RepoStorageMutation::Remove { key } => {
                    let (encoded, _) = prepare_repo_key(&key, false)?;
                    PreparedRepoMutation::Remove(encoded)
                }
            };
            let encoded = match &mutation {
                PreparedRepoMutation::Save(entry) => &entry.key_encoded,
                PreparedRepoMutation::Remove(encoded) => encoded,
            };
            if !seen.insert(encoded.clone()) {
                return Err(StorageError::InvalidV2(
                    "an atomic repo commit contains a duplicate key".to_owned(),
                ));
            }
            prepared.push(mutation);
        }
        if prepared.is_empty() {
            return Ok(());
        }
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for mutation in &prepared {
            match mutation {
                PreparedRepoMutation::Save(entry) => store_repo_entry(&transaction, entry)?,
                PreparedRepoMutation::Remove(encoded) => {
                    transaction
                        .execute("DELETE FROM repo_storage WHERE key_encoded = ?1", [encoded])?;
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn v2_repo_load(&self, key: &[String]) -> Result<Option<Vec<u8>>, StorageError> {
        let (encoded, _) = prepare_repo_key(key, false)?;
        let connection = self.connect()?;
        let row = connection
            .query_row(
                "SELECT value_hash, byte_size, payload FROM repo_storage WHERE key_encoded = ?1",
                [&encoded],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                    ))
                },
            )
            .optional()?;
        row.map(|(hash, byte_size, data)| verify_repo_value(&encoded, hash, byte_size, data))
            .transpose()
    }

    pub fn v2_repo_remove(&self, key: &[String]) -> Result<bool, StorageError> {
        let (encoded, _) = prepare_repo_key(key, false)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "DELETE FROM repo_storage WHERE key_encoded = ?1",
            [&encoded],
        )?;
        transaction.commit()?;
        Ok(changed == 1)
    }

    pub fn v2_repo_load_range(
        &self,
        prefix: &[String],
    ) -> Result<Vec<RepoStorageEntry>, StorageError> {
        let (encoded_prefix, _) = prepare_repo_key(prefix, true)?;
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT key_encoded, key_json, value_hash, byte_size, payload
             FROM repo_storage
             WHERE substr(key_encoded, 1, length(?1)) = ?1
             ORDER BY key_encoded
             LIMIT ?2",
        )?;
        let rows = statement
            .query_map(
                params![encoded_prefix, (MAX_REPO_RANGE_ENTRIES + 1) as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.len() > MAX_REPO_RANGE_ENTRIES {
            return Err(StorageError::LimitExceeded(format!(
                "repo storage range contains more than {MAX_REPO_RANGE_ENTRIES} entries"
            )));
        }
        let range_bytes = rows.iter().try_fold(0usize, |total, row| {
            total.checked_add(row.4.len()).ok_or_else(|| {
                StorageError::LimitExceeded("repo storage range byte count overflowed".to_owned())
            })
        })?;
        if range_bytes > MAX_REPO_RANGE_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "repo storage range contains more than {MAX_REPO_RANGE_BYTES} bytes"
            )));
        }
        let mut entries = rows
            .into_iter()
            .map(|(encoded, key_json, hash, byte_size, data)| {
                let key = serde_json::from_str::<Vec<String>>(&key_json).map_err(|error| {
                    StorageError::CorruptData(format!("repo storage key JSON is invalid: {error}"))
                })?;
                let (expected_encoded, _) = prepare_repo_key(&key, false).map_err(|error| {
                    StorageError::CorruptData(format!("repo storage key is invalid: {error}"))
                })?;
                if encoded != expected_encoded {
                    return Err(StorageError::Integrity(
                        "repo storage key encoding does not match its JSON key".to_owned(),
                    ));
                }
                Ok(RepoStorageEntry {
                    key,
                    data: verify_repo_value(&encoded, hash, byte_size, data)?,
                })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        entries.sort_by(|left, right| compare_repo_keys(&left.key, &right.key));
        Ok(entries)
    }

    pub fn v2_repo_remove_range(&self, prefix: &[String]) -> Result<u64, StorageError> {
        let (encoded_prefix, _) = prepare_repo_key(prefix, true)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (entries, bytes): (i64, i64) = transaction.query_row(
            "SELECT count(*), COALESCE(sum(byte_size), 0)
             FROM repo_storage
             WHERE substr(key_encoded, 1, length(?1)) = ?1",
            [&encoded_prefix],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if entries > MAX_REPO_RANGE_ENTRIES as i64 || bytes > MAX_REPO_RANGE_BYTES as i64 {
            return Err(StorageError::LimitExceeded(
                "repo storage range exceeds the bounded remove limit".to_owned(),
            ));
        }
        let changed = transaction.execute(
            "DELETE FROM repo_storage
             WHERE substr(key_encoded, 1, length(?1)) = ?1",
            [&encoded_prefix],
        )?;
        transaction.commit()?;
        Ok(changed as u64)
    }
}

fn store_repo_entry(
    transaction: &Transaction<'_>,
    entry: &PreparedRepoEntry,
) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO repo_storage(key_encoded, key_json, value_hash, byte_size, payload)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(key_encoded) DO UPDATE SET
             key_json = excluded.key_json,
             value_hash = excluded.value_hash,
             byte_size = excluded.byte_size,
             payload = excluded.payload",
        params![
            entry.key_encoded,
            entry.key_json,
            entry.hash,
            entry.data.len() as i64,
            entry.data,
        ],
    )?;
    Ok(())
}

fn verify_repo_value(
    key_encoded: &str,
    hash: String,
    byte_size: i64,
    data: Vec<u8>,
) -> Result<Vec<u8>, StorageError> {
    if byte_size < 0
        || byte_size as usize != data.len()
        || data.len() > MAX_REPO_VALUE_BYTES
        || hash_bytes(&data) != hash
    {
        return Err(StorageError::Integrity(format!(
            "repo storage value {key_encoded} failed verification"
        )));
    }
    Ok(data)
}

fn compare_repo_keys(left: &[String], right: &[String]) -> Ordering {
    if left.starts_with(right) || right.starts_with(left) {
        return left.len().cmp(&right.len());
    }
    match left.last().cmp(&right.last()) {
        Ordering::Equal => {}
        ordering => return ordering,
    }
    for (left_component, right_component) in left.iter().zip(right) {
        match left_component.cmp(right_component) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
    }
    left.len().cmp(&right.len())
}

type StoredRepoRow = (String, String, String, i64, Vec<u8>);

fn validate_stored_repo_rows(
    rows: Vec<StoredRepoRow>,
) -> Result<Vec<PreparedRepoEntry>, StorageError> {
    if rows.len() > MAX_REPO_RANGE_ENTRIES {
        return Err(StorageError::LimitExceeded(
            "stored Repo image contains too many entries".to_owned(),
        ));
    }
    let mut total = 0usize;
    rows.into_iter()
        .map(|(key_encoded, key_json, hash, byte_size, data)| {
            total = total.checked_add(data.len()).ok_or_else(|| {
                StorageError::LimitExceeded("stored Repo image byte count overflowed".to_owned())
            })?;
            if total > MAX_REPO_RANGE_BYTES {
                return Err(StorageError::LimitExceeded(
                    "stored Repo image exceeds the byte limit".to_owned(),
                ));
            }
            let key = serde_json::from_str::<Vec<String>>(&key_json).map_err(|error| {
                StorageError::CorruptData(format!("stored Repo key is invalid JSON: {error}"))
            })?;
            let (expected_encoded, expected_json) =
                prepare_repo_key(&key, false).map_err(|error| {
                    StorageError::CorruptData(format!("stored Repo key is invalid: {error}"))
                })?;
            if expected_encoded != key_encoded || expected_json != key_json {
                return Err(StorageError::Integrity(
                    "stored Repo key encoding failed verification".to_owned(),
                ));
            }
            let data = verify_repo_value(&key_encoded, hash.clone(), byte_size, data)?;
            Ok(PreparedRepoEntry {
                key_encoded,
                key_json,
                hash,
                data,
            })
        })
        .collect()
}

fn load_active_repo_image(
    connection: &rusqlite::Connection,
) -> Result<Vec<PreparedRepoEntry>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT key_encoded, key_json, value_hash, byte_size, payload
         FROM repo_storage ORDER BY key_encoded",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<StoredRepoRow>>>()?;
    validate_stored_repo_rows(rows)
}

fn load_import_backup_repo_image(
    connection: &rusqlite::Connection,
    import_id: &str,
) -> Result<Vec<PreparedRepoEntry>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT key_encoded, key_json, value_hash, byte_size, payload
         FROM workspace_v2_import_backup_repo
         WHERE import_id = ?1 ORDER BY key_encoded",
    )?;
    let rows = statement
        .query_map([import_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<StoredRepoRow>>>()?;
    validate_stored_repo_rows(rows)
}

fn publish_workspace_image(
    transaction: &Transaction<'_>,
    activation: &[u8],
    activation_hash: &str,
    activated_at: &str,
    assets: &[PreparedAsset],
    repo_entries: &[PreparedRepoEntry],
) -> Result<(), StorageError> {
    for asset in assets {
        let _ = store_asset(transaction, asset)?;
    }
    let activation_json = validate_activation_json(activation, "activation")?;
    for asset_id in json_string_array(&activation_json, "assetIds", "activation")? {
        let hash = parse_sha256(&asset_id, "activation.assetId")?;
        let exists = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE hash = ?1)",
            [&hash],
            |row| row.get::<_, bool>(0),
        )?;
        if !exists {
            return Err(StorageError::Integrity(format!(
                "activation references missing asset {asset_id}"
            )));
        }
    }
    transaction.execute("DELETE FROM repo_storage", [])?;
    for entry in repo_entries {
        store_repo_entry(transaction, entry)?;
    }
    transaction.execute(
        "UPDATE workspace_v2_authority
         SET activation_hash = ?1, activation = ?2, activated_at = ?3
         WHERE selector = 'activation:v2'",
        params![activation_hash, activation, activated_at],
    )?;
    if transaction.changes() != 1 {
        return Err(StorageError::CorruptData(
            "activation:v2 authority row is missing".to_owned(),
        ));
    }
    Ok(())
}

fn stage_document(
    transaction: &Transaction<'_>,
    migration_id: &str,
    document: &PreparedDocument,
) -> Result<(), StorageError> {
    let heads_json = validate_heads(&document.metadata.heads)?;
    transaction.execute(
        "INSERT INTO migration_stage_documents(
             migration_id, id, notebook_id, document_kind, document_format,
             encoding, content_hash, byte_size, chunk_count, heads_json, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            migration_id,
            document.metadata.document_id,
            document.metadata.notebook_id,
            document.metadata.kind.as_str(),
            document.metadata.document_format.as_str(),
            document.metadata.encoding.as_str(),
            document.hash,
            document.metadata.byte_size as i64,
            i64::from(document.metadata.chunk_count),
            heads_json,
            document.metadata.updated_at,
        ],
    )?;
    for (index, chunk) in document.chunks.iter().enumerate() {
        transaction.execute(
            "INSERT INTO migration_stage_document_chunks(
                 migration_id, document_id, chunk_index, chunk_hash, byte_size, payload
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                migration_id,
                document.metadata.document_id,
                index as i64,
                chunk.hash,
                chunk.bytes.len() as i64,
                chunk.bytes,
            ],
        )?;
    }
    Ok(())
}

fn read_migration_marker(
    connection: &rusqlite::Connection,
    migration_id: &str,
) -> Result<Option<MigrationMarker>, StorageError> {
    let row = connection
        .query_row(
            "SELECT source_fingerprint, artifact_fingerprint, manifest_hash,
                    status, started_at, completed_at, error
             FROM migration_runs WHERE id = ?1",
            [migration_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()?;
    row.map(
        |(source, artifact, manifest, status, started_at, completed_at, error)| {
            let status = match status.as_str() {
                "prepared" => MigrationStatus::Prepared,
                "committed" => MigrationStatus::Committed,
                "rolled_back" => MigrationStatus::RolledBack,
                _ => {
                    return Err(StorageError::CorruptData(format!(
                        "migration {migration_id} has an invalid status"
                    )))
                }
            };
            Ok(MigrationMarker {
                migration_id: migration_id.to_owned(),
                source_fingerprint: external_hash(&source),
                artifact_fingerprint: external_hash(&artifact),
                manifest_sha256: external_hash(&manifest),
                status,
                started_at,
                completed_at,
                error,
            })
        },
    )
    .transpose()
}

fn ensure_same_migration(
    marker: &MigrationMarker,
    identity: &MigrationIdentity,
) -> Result<(), StorageError> {
    if marker.migration_id != identity.migration_id
        || marker.source_fingerprint != identity.source_fingerprint
        || marker.artifact_fingerprint != identity.artifact_fingerprint
    {
        return Err(StorageError::Conflict(
            "migration identity does not match the durable marker".to_owned(),
        ));
    }
    Ok(())
}

fn load_staged_documents(
    transaction: &Transaction<'_>,
    migration_id: &str,
) -> Result<Vec<PreparedDocument>, StorageError> {
    let mut statement = transaction.prepare(
        "SELECT id, notebook_id, document_kind, document_format, encoding,
                content_hash, byte_size, chunk_count, heads_json, updated_at
         FROM migration_stage_documents
         WHERE migration_id = ?1
         ORDER BY id",
    )?;
    let rows = statement
        .query_map([migration_id], document_metadata_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(statement);
    let mut documents = Vec::with_capacity(rows.len());
    for row in rows {
        let metadata = parse_document_row(row)?;
        let expected_hash = parse_sha256(&metadata.sha256, "stored document hash")?;
        let mut chunks_statement = transaction.prepare(
            "SELECT chunk_index, chunk_hash, byte_size, payload
             FROM migration_stage_document_chunks
             WHERE migration_id = ?1 AND document_id = ?2
             ORDER BY chunk_index",
        )?;
        let chunk_rows = chunks_statement
            .query_map(params![migration_id, metadata.document_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if chunk_rows.len() != metadata.chunk_count as usize {
            return Err(StorageError::Integrity(format!(
                "staged document {} has an inconsistent chunk count",
                metadata.document_id
            )));
        }
        let mut hasher = Sha256::new();
        let mut chunks = Vec::with_capacity(chunk_rows.len());
        for (expected_index, (index, chunk_hash, byte_size, bytes)) in
            chunk_rows.into_iter().enumerate()
        {
            if index != expected_index as i64
                || byte_size <= 0
                || byte_size as usize != bytes.len()
                || bytes.len() > MAX_DOCUMENT_CHUNK_BYTES
                || hash_bytes(&bytes) != chunk_hash
            {
                return Err(StorageError::Integrity(format!(
                    "staged document {} chunk {expected_index} failed verification",
                    metadata.document_id
                )));
            }
            hasher.update(&bytes);
            chunks.push(PreparedChunk {
                hash: chunk_hash,
                bytes,
            });
        }
        let actual = {
            let digest = hasher.finalize();
            let mut output = String::with_capacity(64);
            for byte in digest {
                use std::fmt::Write as _;
                write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
            }
            output
        };
        let actual_size = chunks.iter().map(|chunk| chunk.bytes.len()).sum::<usize>();
        if actual != expected_hash || actual_size as u64 != metadata.byte_size {
            return Err(StorageError::Integrity(format!(
                "staged document {} failed complete-blob verification",
                metadata.document_id
            )));
        }
        documents.push(PreparedDocument {
            metadata,
            hash: actual,
            chunks,
        });
    }
    Ok(documents)
}

fn load_staged_assets(
    transaction: &Transaction<'_>,
    migration_id: &str,
) -> Result<Vec<PreparedAsset>, StorageError> {
    let mut statement = transaction.prepare(
        "SELECT hash, mime_type, byte_size, payload, created_at
         FROM migration_stage_assets
         WHERE migration_id = ?1
         ORDER BY hash",
    )?;
    let rows = statement
        .query_map([migration_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut assets = Vec::with_capacity(rows.len());
    for (hash, mime_type, byte_size, bytes, created_at) in rows {
        validate_mime(&mime_type).map_err(|error| {
            StorageError::CorruptData(format!("staged asset metadata is invalid: {error}"))
        })?;
        validate_timestamp(&created_at, "stored createdAt").map_err(|error| {
            StorageError::CorruptData(format!("staged asset timestamp is invalid: {error}"))
        })?;
        if byte_size <= 0
            || byte_size as usize != bytes.len()
            || bytes.len() > MAX_ASSET_BYTES
            || hash_bytes(&bytes) != hash
        {
            return Err(StorageError::Integrity(format!(
                "staged asset {} failed verification",
                external_hash(&hash)
            )));
        }
        assets.push(PreparedAsset {
            metadata: AssetMetadata {
                asset_id: external_hash(&hash),
                mime_type,
                byte_size: byte_size as u64,
                created_at,
            },
            hash,
            bytes,
        });
    }
    Ok(assets)
}

fn load_staged_repo_entries(
    transaction: &Transaction<'_>,
    migration_id: &str,
) -> Result<Vec<PreparedRepoEntry>, StorageError> {
    let mut statement = transaction.prepare(
        "SELECT key_encoded, key_json, value_hash, byte_size, payload
         FROM migration_stage_repo_storage
         WHERE migration_id = ?1
         ORDER BY key_encoded",
    )?;
    let rows = statement
        .query_map([migration_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Vec<u8>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut entries = Vec::with_capacity(rows.len());
    for (key_encoded, key_json, hash, byte_size, data) in rows {
        let key = serde_json::from_str::<Vec<String>>(&key_json).map_err(|error| {
            StorageError::CorruptData(format!("staged repo key is invalid JSON: {error}"))
        })?;
        let (expected_encoded, expected_json) = prepare_repo_key(&key, false).map_err(|error| {
            StorageError::CorruptData(format!("staged repo key is invalid: {error}"))
        })?;
        if expected_encoded != key_encoded || expected_json != key_json {
            return Err(StorageError::Integrity(
                "staged repo key failed canonical verification".to_owned(),
            ));
        }
        let data = verify_repo_value(&key_encoded, hash.clone(), byte_size, data)?;
        entries.push(PreparedRepoEntry {
            key_encoded,
            key_json,
            hash,
            data,
        });
    }
    Ok(entries)
}

fn store_document(
    transaction: &Transaction<'_>,
    document: &PreparedDocument,
) -> Result<(), StorageError> {
    let heads_json = validate_heads(&document.metadata.heads)?;
    transaction.execute(
        "INSERT INTO crdt_documents(
             id, notebook_id, document_kind, document_format, encoding,
             content_hash, byte_size, chunk_count, heads_json, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
             notebook_id = excluded.notebook_id,
             document_kind = excluded.document_kind,
             document_format = excluded.document_format,
             encoding = excluded.encoding,
             content_hash = excluded.content_hash,
             byte_size = excluded.byte_size,
             chunk_count = excluded.chunk_count,
             heads_json = excluded.heads_json,
             updated_at = excluded.updated_at",
        params![
            document.metadata.document_id,
            document.metadata.notebook_id,
            document.metadata.kind.as_str(),
            document.metadata.document_format.as_str(),
            document.metadata.encoding.as_str(),
            document.hash,
            document.metadata.byte_size as i64,
            i64::from(document.metadata.chunk_count),
            heads_json,
            document.metadata.updated_at,
        ],
    )?;
    transaction.execute(
        "DELETE FROM crdt_document_chunks WHERE document_id = ?1",
        [&document.metadata.document_id],
    )?;
    for (index, chunk) in document.chunks.iter().enumerate() {
        transaction.execute(
            "INSERT INTO crdt_document_chunks(
                 document_id, chunk_index, chunk_hash, byte_size, payload
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                document.metadata.document_id,
                index as i64,
                chunk.hash,
                chunk.bytes.len() as i64,
                chunk.bytes,
            ],
        )?;
    }
    Ok(())
}

fn store_asset(
    transaction: &Transaction<'_>,
    asset: &PreparedAsset,
) -> Result<AssetMetadata, StorageError> {
    let existing = transaction
        .query_row(
            "SELECT mime_type, byte_size, payload, created_at FROM assets WHERE hash = ?1",
            [&asset.hash],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()?;
    if let Some((mime_type, byte_size, payload, created_at)) = existing {
        if mime_type != asset.metadata.mime_type
            || byte_size != asset.bytes.len() as i64
            || payload != asset.bytes
        {
            return Err(StorageError::Conflict(format!(
                "asset {} already exists with different metadata or bytes",
                asset.metadata.asset_id
            )));
        }
        return Ok(AssetMetadata {
            asset_id: asset.metadata.asset_id.clone(),
            mime_type,
            byte_size: byte_size as u64,
            created_at,
        });
    }
    transaction.execute(
        "INSERT INTO assets(hash, mime_type, byte_size, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            asset.hash,
            asset.metadata.mime_type,
            asset.bytes.len() as i64,
            asset.bytes,
            asset.metadata.created_at,
        ],
    )?;
    Ok(asset.metadata.clone())
}

type DocumentRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    String,
    String,
);

fn document_metadata_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocumentRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

fn parse_document_row(row: DocumentRow) -> Result<DocumentMetadata, StorageError> {
    let (id, notebook_id, kind, format, encoding, hash, byte_size, chunk_count, heads, updated_at) =
        row;
    if byte_size <= 0
        || byte_size as usize > MAX_DOCUMENT_BYTES
        || chunk_count <= 0
        || chunk_count as usize > MAX_DOCUMENT_CHUNKS
        || hash.len() != 64
    {
        return Err(StorageError::CorruptData(format!(
            "document {id} has invalid stored limits"
        )));
    }
    validate_id(&id, "stored documentId").map_err(|error| {
        StorageError::CorruptData(format!("document {id} has an invalid id: {error}"))
    })?;
    validate_id(&notebook_id, "stored notebookId").map_err(|error| {
        StorageError::CorruptData(format!("document {id} has an invalid notebook id: {error}"))
    })?;
    validate_timestamp(&updated_at, "stored updatedAt").map_err(|error| {
        StorageError::CorruptData(format!("document {id} has an invalid timestamp: {error}"))
    })?;
    let heads = serde_json::from_str::<Vec<String>>(&heads).map_err(|error| {
        StorageError::CorruptData(format!("document {id} has invalid heads: {error}"))
    })?;
    validate_heads(&heads).map_err(|error| {
        StorageError::CorruptData(format!("document {id} has invalid heads: {error}"))
    })?;
    let document_format = DocumentFormat::parse(&format)?;
    let encoding = DocumentEncoding::parse(&encoding)?;
    if (matches!(document_format, DocumentFormat::Automerge)
        && !matches!(encoding, DocumentEncoding::Binary))
        || (matches!(document_format, DocumentFormat::CanvinkJsonV2)
            && !matches!(encoding, DocumentEncoding::Utf8Json))
    {
        return Err(StorageError::CorruptData(format!(
            "document {id} has an incompatible format and encoding"
        )));
    }
    Ok(DocumentMetadata {
        document_id: id,
        notebook_id,
        kind: DocumentKind::parse(&kind)?,
        document_format,
        encoding,
        sha256: external_hash(&hash),
        byte_size: byte_size as u64,
        chunk_count: chunk_count as u32,
        heads,
        updated_at,
    })
}

fn read_document_metadata(
    connection: &rusqlite::Connection,
    document_id: &str,
) -> Result<Option<DocumentMetadata>, StorageError> {
    let row = connection
        .query_row(
            "SELECT id, notebook_id, document_kind, document_format, encoding,
                    content_hash, byte_size, chunk_count, heads_json, updated_at
             FROM crdt_documents WHERE id = ?1",
            [document_id],
            document_metadata_from_row,
        )
        .optional()?;
    row.map(parse_document_row).transpose()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationIdentity {
    pub migration_id: String,
    pub source_fingerprint: String,
    pub artifact_fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageMigrationRequest {
    pub identity: MigrationIdentity,
    pub prepared_at: String,
    pub manifest: Vec<u8>,
    pub documents: Vec<PutDocumentRequest>,
    pub assets: Vec<PutAssetRequest>,
    #[serde(default)]
    pub repo_entries: Vec<RepoStorageEntry>,
    #[serde(default)]
    pub workspace_authority: Option<MigrationWorkspaceAuthority>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationWorkspaceAuthority {
    pub activation: Vec<u8>,
    pub backup: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitMigrationRequest {
    pub identity: MigrationIdentity,
    pub committed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackMigrationRequest {
    pub identity: MigrationIdentity,
    pub rolled_back_at: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MigrationStatus {
    Prepared,
    Committed,
    RolledBack,
    AlreadyPrepared,
    AlreadyCommitted,
    AlreadyRolledBack,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationMarker {
    pub migration_id: String,
    pub source_fingerprint: String,
    pub artifact_fingerprint: String,
    pub manifest_sha256: String,
    pub status: MigrationStatus,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceV2Authority {
    pub migration_id: String,
    pub activation: Vec<u8>,
    pub backup: Vec<u8>,
    pub activated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceAdditiveImportRequest {
    pub expected_activation: Vec<u8>,
    pub activation: Vec<u8>,
    pub receipt: Vec<u8>,
    pub assets: Vec<PutAssetRequest>,
    pub repo_entries: Vec<RepoStorageEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRevisionCommitRequest {
    pub expected_activation: Vec<u8>,
    pub activation: Vec<u8>,
    pub assets: Vec<PutAssetRequest>,
    pub repo_entries: Vec<RepoStorageEntry>,
}

/// A delta commit writes only the Repo chunks of new or changed documents
/// (and their derived page index entries), removes the key prefixes of
/// removed documents, and publishes the replacement activation, all in one
/// `IMMEDIATE` transaction guarded by a compare-and-swap on the current
/// activation. With a receipt it is an additive import whose rollback
/// removes the prefixes named in the receipt.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceDeltaCommitRequest {
    pub expected_activation: Vec<u8>,
    pub activation: Vec<u8>,
    #[serde(default)]
    pub receipt: Option<Vec<u8>>,
    pub assets: Vec<PutAssetRequest>,
    pub repo_entries: Vec<RepoStorageEntry>,
    pub removed_prefixes: Vec<Vec<String>>,
}

/// Unreferenced Repo chunks and assets written ahead of a delta commit.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStageEntriesRequest {
    pub assets: Vec<PutAssetRequest>,
    pub repo_entries: Vec<RepoStorageEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackWorkspaceImportRequest {
    pub import_id: String,
    pub rolled_back_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceImportOperationStatus {
    Committed,
    AlreadyCommitted,
    RolledBack,
    AlreadyRolledBack,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceRevisionCommitStatus {
    Committed,
    AlreadyCommitted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceImportOperationResult {
    pub import_id: String,
    pub status: WorkspaceImportOperationStatus,
    pub receipt: Vec<u8>,
}

struct PreparedMigration {
    identity: MigrationIdentity,
    prepared_at: String,
    manifest: Vec<u8>,
    manifest_hash: String,
    documents: Vec<PreparedDocument>,
    assets: Vec<PreparedAsset>,
    repo_entries: Vec<PreparedRepoEntry>,
    workspace_authority: Option<PreparedWorkspaceAuthority>,
}

struct PreparedWorkspaceAuthority {
    activation: Vec<u8>,
    activation_hash: String,
    backup: Vec<u8>,
    backup_hash: String,
}

struct PreparedAdditiveImport {
    import_id: String,
    artifact_fingerprint: String,
    prepared_at: String,
    expected_activation: Vec<u8>,
    activation: Vec<u8>,
    activation_hash: String,
    activated_at: String,
    receipt: Vec<u8>,
    receipt_hash: String,
    assets: Vec<PreparedAsset>,
    repo_entries: Vec<PreparedRepoEntry>,
}

struct PreparedWorkspaceDelta {
    expected_activation: Vec<u8>,
    activation: Vec<u8>,
    activation_hash: String,
    activated_at: String,
    new_asset_ids: Vec<String>,
    receipt: Option<PreparedDeltaReceipt>,
    assets: Vec<PreparedAsset>,
    repo_entries: Vec<PreparedRepoEntry>,
    removed_prefixes: Vec<String>,
}

struct PreparedDeltaReceipt {
    import_id: String,
    artifact_fingerprint: String,
    prepared_at: String,
    receipt: Vec<u8>,
    receipt_hash: String,
}

struct PreparedWorkspaceRevision {
    expected_activation: Vec<u8>,
    activation: Vec<u8>,
    activation_hash: String,
    activated_at: String,
    assets: Vec<PreparedAsset>,
    repo_entries: Vec<PreparedRepoEntry>,
}

fn validate_migration_identity(
    identity: &MigrationIdentity,
) -> Result<(String, String), StorageError> {
    validate_id(&identity.migration_id, "migrationId")?;
    let source = parse_sha256(&identity.source_fingerprint, "sourceFingerprint")?;
    let artifact = parse_sha256(&identity.artifact_fingerprint, "artifactFingerprint")?;
    Ok((source, artifact))
}

fn json_string<'a>(
    value: &'a serde_json::Value,
    field: &str,
    label: &str,
) -> Result<&'a str, StorageError> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| StorageError::InvalidV2(format!("{label}.{field} must be a string")))
}

fn prepare_workspace_authority(
    authority: MigrationWorkspaceAuthority,
    identity: &MigrationIdentity,
    manifest: &serde_json::Value,
) -> Result<PreparedWorkspaceAuthority, StorageError> {
    if authority.activation.is_empty() || authority.activation.len() > MAX_ACTIVATION_BYTES {
        return Err(StorageError::LimitExceeded(format!(
            "a workspace activation must contain 1 to {MAX_ACTIVATION_BYTES} bytes"
        )));
    }
    if authority.backup.is_empty() || authority.backup.len() > MAX_V1_BACKUP_BYTES {
        return Err(StorageError::LimitExceeded(format!(
            "a v1 rollback backup must contain 1 to {MAX_V1_BACKUP_BYTES} bytes"
        )));
    }
    let activation: serde_json::Value =
        serde_json::from_slice(&authority.activation).map_err(|error| {
            StorageError::InvalidV2(format!("workspace activation is not valid JSON: {error}"))
        })?;
    let backup: serde_json::Value = serde_json::from_slice(&authority.backup).map_err(|error| {
        StorageError::InvalidV2(format!("v1 rollback backup is not valid JSON: {error}"))
    })?;
    if activation
        .get("version")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
        || activation
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(2)
        || json_string(&activation, "format", "activation")? != "canvink-automerge-v2"
        || json_string(&activation, "migrationId", "activation")? != identity.migration_id
        || json_string(&activation, "sourceFingerprint", "activation")?
            != identity.source_fingerprint
        || json_string(&activation, "artifactFingerprint", "activation")?
            != identity.artifact_fingerprint
        || activation.get("manifest") != Some(manifest)
    {
        return Err(StorageError::InvalidV2(
            "workspace activation does not match the staged migration".to_owned(),
        ));
    }
    validate_timestamp(
        json_string(&activation, "activatedAt", "activation")?,
        "activation.activatedAt",
    )?;
    if !activation
        .get("documents")
        .is_some_and(serde_json::Value::is_array)
        || !activation
            .get("chunks")
            .is_some_and(serde_json::Value::is_array)
        || !activation
            .get("assetIds")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err(StorageError::InvalidV2(
            "workspace activation is missing its document, chunk, or asset index".to_owned(),
        ));
    }
    if backup.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || json_string(&backup, "migrationId", "backup")? != identity.migration_id
        || json_string(&backup, "sourceFingerprint", "backup")? != identity.source_fingerprint
        || !backup
            .get("workspace")
            .is_some_and(serde_json::Value::is_object)
    {
        return Err(StorageError::InvalidV2(
            "v1 rollback backup does not match the staged migration".to_owned(),
        ));
    }
    validate_timestamp(
        json_string(&backup, "createdAt", "backup")?,
        "backup.createdAt",
    )?;
    Ok(PreparedWorkspaceAuthority {
        activation_hash: hash_bytes(&authority.activation),
        activation: authority.activation,
        backup_hash: hash_bytes(&authority.backup),
        backup: authority.backup,
    })
}

fn json_string_array(
    value: &serde_json::Value,
    field: &str,
    label: &str,
) -> Result<Vec<String>, StorageError> {
    value
        .get(field)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| StorageError::InvalidV2(format!("{label}.{field} must be an array")))?
        .iter()
        .map(|item| {
            item.as_str().map(str::to_owned).ok_or_else(|| {
                StorageError::InvalidV2(format!("{label}.{field} must contain only strings"))
            })
        })
        .collect()
}

fn validate_activation_json(bytes: &[u8], label: &str) -> Result<serde_json::Value, StorageError> {
    if bytes.is_empty() || bytes.len() > MAX_ACTIVATION_BYTES {
        return Err(StorageError::LimitExceeded(format!(
            "{label} must contain 1 to {MAX_ACTIVATION_BYTES} bytes"
        )));
    }
    let activation: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| StorageError::InvalidV2(format!("{label} is not valid JSON: {error}")))?;
    let schema_version = activation
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64);
    let manifest = activation.get("manifest").filter(|value| value.is_object());
    let paired_format = match schema_version {
        Some(2) => {
            json_string(&activation, "format", label)? == "canvink-automerge-v2"
                && manifest
                    .and_then(|value| value.get("schemaVersion"))
                    .and_then(serde_json::Value::as_u64)
                    == Some(2)
                && manifest
                    .and_then(|value| value.get("format"))
                    .and_then(serde_json::Value::as_str)
                    == Some("canvink-schema-v2")
        }
        Some(3) => {
            json_string(&activation, "format", label)? == "canvink-automerge-v3"
                && manifest
                    .and_then(|value| value.get("schemaVersion"))
                    .and_then(serde_json::Value::as_u64)
                    == Some(3)
                && manifest
                    .and_then(|value| value.get("format"))
                    .and_then(serde_json::Value::as_str)
                    == Some("canvink-schema-v3")
        }
        _ => false,
    };
    if activation
        .get("version")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
        || !paired_format
        || !activation
            .get("documents")
            .is_some_and(serde_json::Value::is_array)
        || !activation
            .get("chunks")
            .is_some_and(serde_json::Value::is_array)
    {
        return Err(StorageError::InvalidV2(format!(
            "{label} has an invalid activation shape"
        )));
    }
    if schema_version == Some(3) {
        let upgrade = manifest
            .and_then(|value| value.get("upgrade"))
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                StorageError::InvalidV2(format!("{label} is missing schema-v3 upgrade provenance"))
            })?;
        if upgrade.get("name").and_then(serde_json::Value::as_str) != Some("workspace-v2-to-v3")
            || upgrade.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        {
            return Err(StorageError::InvalidV2(format!(
                "{label} has invalid schema-v3 upgrade provenance"
            )));
        }
        parse_sha256(
            json_string(upgrade, "sourceArtifactFingerprint", "manifest.upgrade")?,
            "sourceArtifactFingerprint",
        )?;
        validate_timestamp(
            json_string(upgrade, "preparedAt", "manifest.upgrade")?,
            "manifest.upgrade.preparedAt",
        )?;
    }
    validate_id(
        json_string(&activation, "migrationId", label)?,
        "migrationId",
    )?;
    parse_sha256(
        json_string(&activation, "sourceFingerprint", label)?,
        "sourceFingerprint",
    )?;
    parse_sha256(
        json_string(&activation, "artifactFingerprint", label)?,
        "artifactFingerprint",
    )?;
    validate_timestamp(
        json_string(&activation, "activatedAt", label)?,
        "activation.activatedAt",
    )?;
    json_string_array(&activation, "assetIds", label)?;
    Ok(activation)
}

fn string_set_is_subset(before: &[String], after: &[String]) -> bool {
    let after = after.iter().collect::<HashSet<_>>();
    before.iter().all(|item| after.contains(item))
}

fn verify_activation_repo_image(
    activation: &serde_json::Value,
    repo_entries: &[PreparedRepoEntry],
) -> Result<(), StorageError> {
    let chunks = activation
        .get("chunks")
        .and_then(serde_json::Value::as_array)
        .expect("validated chunk array");
    if chunks.len() != repo_entries.len() {
        return Err(StorageError::Integrity(
            "activation chunk index does not match the complete Repo image".to_owned(),
        ));
    }
    for (descriptor, entry) in chunks.iter().zip(repo_entries) {
        let logical_key = descriptor
            .get("key")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| StorageError::InvalidV2("activation chunk key is invalid".to_owned()))?
            .iter()
            .map(|item| {
                item.as_str().map(str::to_owned).ok_or_else(|| {
                    StorageError::InvalidV2("activation chunk key is invalid".to_owned())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut physical_key = vec!["automerge-repo".to_owned()];
        physical_key.extend(logical_key);
        let (_, physical_json) = prepare_repo_key(&physical_key, false)?;
        if entry.key_json != physical_json
            || descriptor.get("size").and_then(serde_json::Value::as_u64)
                != Some(entry.data.len() as u64)
            || json_string(descriptor, "checksum", "activation chunk")?
                != external_hash(&entry.hash)
        {
            return Err(StorageError::Integrity(
                "activation chunk descriptor does not match the complete Repo image".to_owned(),
            ));
        }
    }
    Ok(())
}

fn prepare_additive_import(
    request: WorkspaceAdditiveImportRequest,
) -> Result<PreparedAdditiveImport, StorageError> {
    let expected = validate_activation_json(&request.expected_activation, "expectedActivation")?;
    let activation = validate_activation_json(&request.activation, "activation")?;
    let receipt: serde_json::Value = serde_json::from_slice(&request.receipt).map_err(|error| {
        StorageError::InvalidV2(format!(
            "workspace import receipt is not valid JSON: {error}"
        ))
    })?;
    if request.receipt.is_empty() || request.receipt.len() > MAX_MANIFEST_BYTES {
        return Err(StorageError::LimitExceeded(
            "workspace import receipt exceeds the byte limit".to_owned(),
        ));
    }
    if expected.get("schemaVersion") != activation.get("schemaVersion")
        || expected.get("format") != activation.get("format")
    {
        return Err(StorageError::InvalidV2(
            "additive import cannot change the workspace schema".to_owned(),
        ));
    }
    let import_id = json_string(&receipt, "importId", "receipt")?.to_owned();
    validate_id(&import_id, "importId")?;
    let artifact_fingerprint = json_string(&receipt, "importArtifactFingerprint", "receipt")?;
    parse_sha256(artifact_fingerprint, "importArtifactFingerprint")?;
    let prepared_at = json_string(&receipt, "preparedAt", "receipt")?.to_owned();
    validate_timestamp(&prepared_at, "receipt.preparedAt")?;
    if receipt.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || json_string(&receipt, "status", "receipt")? != "committed"
        || json_string(&receipt, "backupId", "receipt")? != format!("import-backup:{import_id}")
        || json_string(&receipt, "priorActivationArtifactFingerprint", "receipt")?
            != json_string(&expected, "artifactFingerprint", "expectedActivation")?
        || json_string(
            &receipt,
            "committedActivationArtifactFingerprint",
            "receipt",
        )? != json_string(&activation, "artifactFingerprint", "activation")?
        || json_string(&expected, "migrationId", "expectedActivation")?
            != json_string(&activation, "migrationId", "activation")?
        || json_string(&expected, "sourceFingerprint", "expectedActivation")?
            != json_string(&activation, "sourceFingerprint", "activation")?
    {
        return Err(StorageError::InvalidV2(
            "workspace import receipt does not match its activations".to_owned(),
        ));
    }
    let expected_manifest = expected.get("manifest").expect("validated manifest object");
    let activation_manifest = activation
        .get("manifest")
        .expect("validated manifest object");
    for field in ["notebookDocumentIds", "pageDocumentIds"] {
        if !string_set_is_subset(
            &json_string_array(expected_manifest, field, "expectedActivation.manifest")?,
            &json_string_array(activation_manifest, field, "activation.manifest")?,
        ) {
            return Err(StorageError::InvalidV2(
                "additive import removed an existing document root".to_owned(),
            ));
        }
    }
    if expected_manifest.get("active") != activation_manifest.get("active")
        || !string_set_is_subset(
            &json_string_array(&expected, "assetIds", "expectedActivation")?,
            &json_string_array(&activation, "assetIds", "activation")?,
        )
    {
        return Err(StorageError::InvalidV2(
            "additive import changed the prior active context or removed an asset".to_owned(),
        ));
    }
    let expected_documents = expected
        .get("documents")
        .and_then(serde_json::Value::as_array)
        .expect("validated document array");
    let activation_documents = activation
        .get("documents")
        .and_then(serde_json::Value::as_array)
        .expect("validated document array");
    for document in expected_documents {
        let document_id = json_string(document, "documentId", "activation document")?;
        let retained = activation_documents.iter().find(|candidate| {
            candidate
                .get("documentId")
                .and_then(serde_json::Value::as_str)
                == Some(document_id)
        });
        if retained.is_none_or(|candidate| {
            candidate.get("kind") != document.get("kind")
                || candidate.get("url") != document.get("url")
        }) {
            return Err(StorageError::InvalidV2(format!(
                "additive import changed existing document {document_id}"
            )));
        }
    }
    let notebook_document_id = json_string(&receipt, "notebookDocumentId", "receipt")?;
    let page_document_ids = json_string_array(&receipt, "pageDocumentIds", "receipt")?;
    let receipt_asset_ids = json_string_array(&receipt, "assetIds", "receipt")?;
    if !activation_documents.iter().any(|document| {
        document
            .get("documentId")
            .and_then(serde_json::Value::as_str)
            == Some(notebook_document_id)
    }) || page_document_ids.iter().any(|document_id| {
        !activation_documents.iter().any(|document| {
            document
                .get("documentId")
                .and_then(serde_json::Value::as_str)
                == Some(document_id)
        })
    }) || !string_set_is_subset(
        &receipt_asset_ids,
        &json_string_array(&activation, "assetIds", "activation")?,
    ) {
        return Err(StorageError::InvalidV2(
            "workspace import receipt references missing documents or assets".to_owned(),
        ));
    }

    if request.assets.len() > MAX_MIGRATION_ASSETS
        || request.repo_entries.len() > MAX_REPO_ATOMIC_MUTATIONS
    {
        return Err(StorageError::LimitExceeded(
            "workspace import contains too many assets or Repo entries".to_owned(),
        ));
    }
    let mut total =
        request.expected_activation.len() + request.activation.len() + request.receipt.len();
    let mut asset_hashes = HashSet::with_capacity(request.assets.len());
    let mut assets = Vec::with_capacity(request.assets.len());
    for asset in request.assets {
        let prepared = prepare_asset(asset)?;
        if !asset_hashes.insert(prepared.hash.clone()) {
            return Err(StorageError::InvalidV2(
                "workspace import contains a duplicate asset".to_owned(),
            ));
        }
        total = total.checked_add(prepared.bytes.len()).ok_or_else(|| {
            StorageError::LimitExceeded("workspace import byte count overflowed".to_owned())
        })?;
        assets.push(prepared);
    }
    let mut repo_keys = HashSet::with_capacity(request.repo_entries.len());
    let mut repo_entries = Vec::with_capacity(request.repo_entries.len());
    for entry in request.repo_entries {
        let prepared = prepare_repo_entry(entry)?;
        if !repo_keys.insert(prepared.key_encoded.clone()) {
            return Err(StorageError::InvalidV2(
                "workspace import contains a duplicate Repo key".to_owned(),
            ));
        }
        total = total.checked_add(prepared.data.len()).ok_or_else(|| {
            StorageError::LimitExceeded("workspace import byte count overflowed".to_owned())
        })?;
        repo_entries.push(prepared);
    }
    if total > MAX_MIGRATION_BYTES {
        return Err(StorageError::LimitExceeded(
            "workspace import exceeds the byte limit".to_owned(),
        ));
    }
    verify_activation_repo_image(&activation, &repo_entries)?;
    Ok(PreparedAdditiveImport {
        import_id,
        artifact_fingerprint: parse_sha256(artifact_fingerprint, "importArtifactFingerprint")?,
        prepared_at,
        expected_activation: request.expected_activation,
        activation_hash: hash_bytes(&request.activation),
        activated_at: json_string(&activation, "activatedAt", "activation")?.to_owned(),
        activation: request.activation,
        receipt_hash: hash_bytes(&request.receipt),
        receipt: request.receipt,
        assets,
        repo_entries,
    })
}

fn prepare_workspace_revision(
    request: WorkspaceRevisionCommitRequest,
) -> Result<PreparedWorkspaceRevision, StorageError> {
    let expected = validate_activation_json(&request.expected_activation, "expectedActivation")?;
    let activation = validate_activation_json(&request.activation, "activation")?;
    if json_string(&expected, "migrationId", "expectedActivation")?
        != json_string(&activation, "migrationId", "activation")?
        || json_string(&expected, "sourceFingerprint", "expectedActivation")?
            != json_string(&activation, "sourceFingerprint", "activation")?
    {
        return Err(StorageError::InvalidV2(
            "workspace revision changed migration or source identity".to_owned(),
        ));
    }
    let before_schema = expected
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64);
    let after_schema = activation
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64);
    if before_schema != after_schema && (before_schema, after_schema) != (Some(2), Some(3)) {
        return Err(StorageError::InvalidV2(
            "workspace revision attempted an unsupported schema transition".to_owned(),
        ));
    }
    if request.assets.len() > MAX_MIGRATION_ASSETS
        || request.repo_entries.len() > MAX_REPO_ATOMIC_MUTATIONS
    {
        return Err(StorageError::LimitExceeded(
            "workspace revision contains too many assets or Repo entries".to_owned(),
        ));
    }
    let mut total = request.expected_activation.len() + request.activation.len();
    let mut asset_hashes = HashSet::with_capacity(request.assets.len());
    let mut assets = Vec::with_capacity(request.assets.len());
    for asset in request.assets {
        let prepared = prepare_asset(asset)?;
        if !asset_hashes.insert(prepared.hash.clone()) {
            return Err(StorageError::InvalidV2(
                "workspace revision contains a duplicate asset".to_owned(),
            ));
        }
        total = total.checked_add(prepared.bytes.len()).ok_or_else(|| {
            StorageError::LimitExceeded("workspace revision byte count overflowed".to_owned())
        })?;
        assets.push(prepared);
    }
    let mut repo_keys = HashSet::with_capacity(request.repo_entries.len());
    let mut repo_entries = Vec::with_capacity(request.repo_entries.len());
    for entry in request.repo_entries {
        let prepared = prepare_repo_entry(entry)?;
        if !repo_keys.insert(prepared.key_encoded.clone()) {
            return Err(StorageError::InvalidV2(
                "workspace revision contains a duplicate Repo key".to_owned(),
            ));
        }
        total = total.checked_add(prepared.data.len()).ok_or_else(|| {
            StorageError::LimitExceeded("workspace revision byte count overflowed".to_owned())
        })?;
        repo_entries.push(prepared);
    }
    if total > MAX_MIGRATION_BYTES {
        return Err(StorageError::LimitExceeded(
            "workspace revision exceeds the byte limit".to_owned(),
        ));
    }
    verify_activation_repo_image(&activation, &repo_entries)?;
    Ok(PreparedWorkspaceRevision {
        expected_activation: request.expected_activation,
        activation_hash: hash_bytes(&request.activation),
        activated_at: json_string(&activation, "activatedAt", "activation")?.to_owned(),
        activation: request.activation,
        assets,
        repo_entries,
    })
}

/// Namespaces a delta commit may write or remove: Automerge Repo chunks and
/// the derived page index and dirty markers that live next to them.
const DELTA_NAMESPACES: [&str; 3] = ["automerge-repo", "canvink-page-index", "canvink-dirty"];

fn prepare_delta_prefix(prefix: &[String]) -> Result<String, StorageError> {
    if prefix.len() < 2 || !DELTA_NAMESPACES.contains(&prefix[0].as_str()) {
        return Err(StorageError::InvalidV2(
            "a delta prefix must name one document inside a delta namespace".to_owned(),
        ));
    }
    Ok(prepare_repo_key(prefix, false)?.0)
}

fn delta_rollback_prefixes(
    receipt: &serde_json::Value,
) -> Result<Option<Vec<Vec<String>>>, StorageError> {
    let Some(rollback) = receipt.get("rollback") else {
        return Ok(None);
    };
    if json_string(rollback, "mode", "receipt.rollback")? != "remove-prefixes" {
        return Err(StorageError::InvalidV2(
            "workspace import receipt has an unknown rollback mode".to_owned(),
        ));
    }
    let prefixes = rollback
        .get("prefixes")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            StorageError::InvalidV2("receipt.rollback.prefixes must be an array".to_owned())
        })?
        .iter()
        .map(|prefix| {
            let parts = prefix
                .as_array()
                .ok_or_else(|| {
                    StorageError::InvalidV2("a rollback prefix must be an array".to_owned())
                })?
                .iter()
                .map(|part| {
                    part.as_str().map(str::to_owned).ok_or_else(|| {
                        StorageError::InvalidV2("a rollback prefix must hold strings".to_owned())
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            prepare_delta_prefix(&parts)?;
            Ok(parts)
        })
        .collect::<Result<Vec<_>, StorageError>>()?;
    Ok(Some(prefixes))
}

fn prepare_workspace_delta(
    request: WorkspaceDeltaCommitRequest,
) -> Result<PreparedWorkspaceDelta, StorageError> {
    let expected = validate_activation_json(&request.expected_activation, "expectedActivation")?;
    let activation = validate_activation_json(&request.activation, "activation")?;
    for field in ["migrationId", "sourceFingerprint", "format"] {
        if json_string(&expected, field, "expectedActivation")?
            != json_string(&activation, field, "activation")?
        {
            return Err(StorageError::InvalidV2(format!(
                "a delta commit cannot change activation.{field}"
            )));
        }
    }
    if expected.get("schemaVersion") != activation.get("schemaVersion")
        || json_string(&activation, "layout", "activation")? != "repo-live"
    {
        return Err(StorageError::InvalidV2(
            "a delta commit must keep the schema and use the repo-live layout".to_owned(),
        ));
    }
    let expected_assets = json_string_array(&expected, "assetIds", "expectedActivation")?;
    let new_asset_ids = json_string_array(&activation, "assetIds", "activation")?
        .into_iter()
        .filter(|asset_id| !expected_assets.contains(asset_id))
        .map(|asset_id| parse_sha256(&asset_id, "activation.assetId"))
        .collect::<Result<Vec<_>, _>>()?;
    let receipt = match request.receipt {
        None => None,
        Some(receipt_bytes) => {
            if receipt_bytes.is_empty() || receipt_bytes.len() > MAX_MANIFEST_BYTES {
                return Err(StorageError::LimitExceeded(
                    "workspace import receipt exceeds the byte limit".to_owned(),
                ));
            }
            let receipt: serde_json::Value =
                serde_json::from_slice(&receipt_bytes).map_err(|error| {
                    StorageError::InvalidV2(format!(
                        "workspace import receipt is not valid JSON: {error}"
                    ))
                })?;
            let import_id = json_string(&receipt, "importId", "receipt")?.to_owned();
            validate_id(&import_id, "importId")?;
            let artifact = parse_sha256(
                json_string(&receipt, "importArtifactFingerprint", "receipt")?,
                "importArtifactFingerprint",
            )?;
            let prepared_at = json_string(&receipt, "preparedAt", "receipt")?.to_owned();
            validate_timestamp(&prepared_at, "receipt.preparedAt")?;
            if receipt.get("version").and_then(serde_json::Value::as_u64) != Some(1)
                || json_string(&receipt, "status", "receipt")? != "committed"
                || json_string(&receipt, "backupId", "receipt")?
                    != format!("import-backup:{import_id}")
                || json_string(&receipt, "priorActivationArtifactFingerprint", "receipt")?
                    != json_string(&expected, "artifactFingerprint", "expectedActivation")?
                || json_string(
                    &receipt,
                    "committedActivationArtifactFingerprint",
                    "receipt",
                )? != json_string(&activation, "artifactFingerprint", "activation")?
                || delta_rollback_prefixes(&receipt)?.is_none()
            {
                return Err(StorageError::InvalidV2(
                    "delta import receipt does not match its activations".to_owned(),
                ));
            }
            let expected_manifest = expected.get("manifest").expect("validated manifest object");
            let manifest = activation
                .get("manifest")
                .expect("validated manifest object");
            for field in ["notebookDocumentIds", "pageDocumentIds"] {
                if !string_set_is_subset(
                    &json_string_array(expected_manifest, field, "expectedActivation.manifest")?,
                    &json_string_array(manifest, field, "activation.manifest")?,
                ) {
                    return Err(StorageError::InvalidV2(
                        "additive import removed an existing document root".to_owned(),
                    ));
                }
            }
            if expected_manifest.get("active") != manifest.get("active") {
                return Err(StorageError::InvalidV2(
                    "additive import changed the prior active context".to_owned(),
                ));
            }
            Some(PreparedDeltaReceipt {
                import_id,
                artifact_fingerprint: artifact,
                prepared_at,
                receipt_hash: hash_bytes(&receipt_bytes),
                receipt: receipt_bytes,
            })
        }
    };
    if request.assets.len() > MAX_MIGRATION_ASSETS
        || request.repo_entries.len() > MAX_REPO_ATOMIC_MUTATIONS
        || request.removed_prefixes.len() > MAX_REPO_ATOMIC_MUTATIONS
    {
        return Err(StorageError::LimitExceeded(
            "delta commit contains too many assets, entries, or prefixes".to_owned(),
        ));
    }
    let mut total = request.expected_activation.len() + request.activation.len();
    let mut assets = Vec::with_capacity(request.assets.len());
    for asset in request.assets {
        let prepared = prepare_asset(asset)?;
        total = total.checked_add(prepared.bytes.len()).ok_or_else(|| {
            StorageError::LimitExceeded("delta commit byte count overflowed".to_owned())
        })?;
        assets.push(prepared);
    }
    let mut repo_keys = HashSet::with_capacity(request.repo_entries.len());
    let mut repo_entries = Vec::with_capacity(request.repo_entries.len());
    for entry in request.repo_entries {
        if entry.key.len() < 2 || !DELTA_NAMESPACES.contains(&entry.key[0].as_str()) {
            return Err(StorageError::InvalidV2(
                "a delta entry must live inside a delta namespace".to_owned(),
            ));
        }
        let prepared = prepare_repo_entry(entry)?;
        if !repo_keys.insert(prepared.key_encoded.clone()) {
            return Err(StorageError::InvalidV2(
                "delta commit contains a duplicate Repo key".to_owned(),
            ));
        }
        total = total.checked_add(prepared.data.len()).ok_or_else(|| {
            StorageError::LimitExceeded("delta commit byte count overflowed".to_owned())
        })?;
        repo_entries.push(prepared);
    }
    if total > MAX_MIGRATION_BYTES {
        return Err(StorageError::LimitExceeded(
            "delta commit exceeds the byte limit".to_owned(),
        ));
    }
    let removed_prefixes = request
        .removed_prefixes
        .iter()
        .map(|prefix| prepare_delta_prefix(prefix))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PreparedWorkspaceDelta {
        expected_activation: request.expected_activation,
        activation_hash: hash_bytes(&request.activation),
        activated_at: json_string(&activation, "activatedAt", "activation")?.to_owned(),
        activation: request.activation,
        new_asset_ids,
        receipt,
        assets,
        repo_entries,
        removed_prefixes,
    })
}

fn remove_repo_prefix(
    transaction: &Transaction<'_>,
    encoded_prefix: &str,
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM repo_storage WHERE substr(key_encoded, 1, length(?1)) = ?1",
        [encoded_prefix],
    )?;
    Ok(())
}

fn publish_activation_only(
    transaction: &Transaction<'_>,
    activation: &[u8],
    activation_hash: &str,
    activated_at: &str,
) -> Result<(), StorageError> {
    transaction.execute(
        "UPDATE workspace_v2_authority
         SET activation_hash = ?1, activation = ?2, activated_at = ?3
         WHERE selector = 'activation:v2'",
        params![activation_hash, activation, activated_at],
    )?;
    if transaction.changes() != 1 {
        return Err(StorageError::CorruptData(
            "activation:v2 authority row is missing".to_owned(),
        ));
    }
    Ok(())
}

fn prepare_migration(request: StageMigrationRequest) -> Result<PreparedMigration, StorageError> {
    validate_migration_identity(&request.identity)?;
    validate_timestamp(&request.prepared_at, "preparedAt")?;
    if request.manifest.is_empty() || request.manifest.len() > MAX_MANIFEST_BYTES {
        return Err(StorageError::LimitExceeded(format!(
            "a migration manifest must contain 1 to {MAX_MANIFEST_BYTES} bytes"
        )));
    }
    let manifest_json =
        serde_json::from_slice::<serde_json::Value>(&request.manifest).map_err(|error| {
            StorageError::InvalidV2(format!("migration manifest is not valid JSON: {error}"))
        })?;
    if manifest_json
        .as_object()
        .and_then(|manifest| manifest.get("schemaVersion"))
        .and_then(serde_json::Value::as_u64)
        != Some(2)
    {
        return Err(StorageError::InvalidV2(
            "migration manifest must declare schemaVersion 2".to_owned(),
        ));
    }
    if request.documents.len() > MAX_MIGRATION_DOCUMENTS {
        return Err(StorageError::LimitExceeded(format!(
            "a migration may contain at most {MAX_MIGRATION_DOCUMENTS} documents"
        )));
    }
    if request.documents.is_empty() && request.repo_entries.is_empty() {
        return Err(StorageError::InvalidV2(
            "a migration must stage at least one document or repo storage entry".to_owned(),
        ));
    }
    if request.assets.len() > MAX_MIGRATION_ASSETS {
        return Err(StorageError::LimitExceeded(format!(
            "a migration may contain at most {MAX_MIGRATION_ASSETS} assets"
        )));
    }
    let mut document_ids = HashSet::with_capacity(request.documents.len());
    let mut documents = Vec::with_capacity(request.documents.len());
    let mut total = request.manifest.len();
    for document in request.documents {
        let prepared = prepare_document(document)?;
        if !document_ids.insert(prepared.metadata.document_id.clone()) {
            return Err(StorageError::InvalidV2(format!(
                "duplicate migration documentId {}",
                prepared.metadata.document_id
            )));
        }
        total = total
            .checked_add(prepared.metadata.byte_size as usize)
            .ok_or_else(|| {
                StorageError::LimitExceeded("migration byte count overflowed".to_owned())
            })?;
        if total > MAX_MIGRATION_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "a staged migration may contain at most {MAX_MIGRATION_BYTES} bytes"
            )));
        }
        documents.push(prepared);
    }
    let mut asset_hashes = HashSet::with_capacity(request.assets.len());
    let mut assets = Vec::with_capacity(request.assets.len());
    for asset in request.assets {
        let prepared = prepare_asset(asset)?;
        if !asset_hashes.insert(prepared.hash.clone()) {
            return Err(StorageError::InvalidV2(format!(
                "duplicate migration assetId {}",
                prepared.metadata.asset_id
            )));
        }
        total = total.checked_add(prepared.bytes.len()).ok_or_else(|| {
            StorageError::LimitExceeded("migration byte count overflowed".to_owned())
        })?;
        if total > MAX_MIGRATION_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "a staged migration may contain at most {MAX_MIGRATION_BYTES} bytes"
            )));
        }
        assets.push(prepared);
    }
    if request.repo_entries.len() > MAX_REPO_ATOMIC_MUTATIONS {
        return Err(StorageError::LimitExceeded(format!(
            "a migration may contain at most {MAX_REPO_ATOMIC_MUTATIONS} repo storage entries"
        )));
    }
    let mut repo_keys = HashSet::with_capacity(request.repo_entries.len());
    let mut repo_entries = Vec::with_capacity(request.repo_entries.len());
    for entry in request.repo_entries {
        let prepared = prepare_repo_entry(entry)?;
        if !repo_keys.insert(prepared.key_encoded.clone()) {
            return Err(StorageError::InvalidV2(
                "migration contains a duplicate repo storage key".to_owned(),
            ));
        }
        total = total.checked_add(prepared.data.len()).ok_or_else(|| {
            StorageError::LimitExceeded("migration byte count overflowed".to_owned())
        })?;
        if total > MAX_MIGRATION_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "a staged migration may contain at most {MAX_MIGRATION_BYTES} bytes"
            )));
        }
        repo_entries.push(prepared);
    }
    let mutation_count = documents
        .iter()
        .try_fold(assets.len() + repo_entries.len(), |total, document| {
            total.checked_add(document.chunks.len() + 1)
        })
        .ok_or_else(|| {
            StorageError::LimitExceeded("migration mutation count overflowed".to_owned())
        })?;
    if mutation_count > MAX_REPO_ATOMIC_MUTATIONS {
        return Err(StorageError::LimitExceeded(format!(
            "a staged migration may contain at most {MAX_REPO_ATOMIC_MUTATIONS} storage mutations"
        )));
    }
    let workspace_authority = request
        .workspace_authority
        .map(|authority| prepare_workspace_authority(authority, &request.identity, &manifest_json))
        .transpose()?;
    if let Some(authority) = &workspace_authority {
        total = total
            .checked_add(authority.activation.len())
            .and_then(|bytes| bytes.checked_add(authority.backup.len()))
            .ok_or_else(|| {
                StorageError::LimitExceeded("migration byte count overflowed".to_owned())
            })?;
        if total > MAX_MIGRATION_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "a staged migration may contain at most {MAX_MIGRATION_BYTES} bytes"
            )));
        }
    }
    Ok(PreparedMigration {
        identity: request.identity,
        prepared_at: request.prepared_at,
        manifest_hash: hash_bytes(&request.manifest),
        manifest: request.manifest,
        documents,
        assets,
        repo_entries,
        workspace_authority,
    })
}

impl Database {
    pub fn v2_stage_migration(
        &self,
        request: StageMigrationRequest,
    ) -> Result<MigrationMarker, StorageError> {
        let prepared = prepare_migration(request)?;
        let (source, artifact) = validate_migration_identity(&prepared.identity)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(mut marker) =
            read_migration_marker(&transaction, &prepared.identity.migration_id)?
        {
            ensure_same_migration(&marker, &prepared.identity)?;
            if marker.manifest_sha256 != external_hash(&prepared.manifest_hash) {
                return Err(StorageError::Conflict(
                    "migrationId already exists with a different manifest".to_owned(),
                ));
            }
            if let Some(authority) = &prepared.workspace_authority {
                let table = if marker.status == MigrationStatus::Committed {
                    "workspace_v2_authority"
                } else {
                    "migration_stage_workspace_authority"
                };
                let stored = transaction
                    .query_row(
                        &format!(
                            "SELECT activation_hash, activation, backup_hash, backup FROM {table} WHERE migration_id = ?1"
                        ),
                        [&prepared.identity.migration_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, Vec<u8>>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, Vec<u8>>(3)?,
                            ))
                        },
                    )
                    .optional()?;
                if stored
                    != Some((
                        authority.activation_hash.clone(),
                        authority.activation.clone(),
                        authority.backup_hash.clone(),
                        authority.backup.clone(),
                    ))
                {
                    return Err(StorageError::Conflict(
                        "migrationId already exists with different workspace authority".to_owned(),
                    ));
                }
            }
            marker.status = match marker.status {
                MigrationStatus::Prepared => MigrationStatus::AlreadyPrepared,
                MigrationStatus::Committed => MigrationStatus::AlreadyCommitted,
                MigrationStatus::RolledBack => MigrationStatus::AlreadyRolledBack,
                status => status,
            };
            return Ok(marker);
        }
        let active_version: String = transaction.query_row(
            "SELECT value FROM meta WHERE key = 'documents.activeVersion'",
            [],
            |row| row.get(0),
        )?;
        if active_version != "1" {
            return Err(StorageError::Conflict(
                "a v1-to-v2 migration cannot be staged after schema v2 is active".to_owned(),
            ));
        }

        transaction.execute(
            "INSERT INTO migration_runs(
                 id, source_schema, target_schema, status, source_fingerprint,
                 artifact_fingerprint, manifest_hash, manifest, started_at
             ) VALUES (?1, 1, 2, 'prepared', ?2, ?3, ?4, ?5, ?6)",
            params![
                prepared.identity.migration_id,
                source,
                artifact,
                prepared.manifest_hash,
                prepared.manifest,
                prepared.prepared_at,
            ],
        )?;
        for document in &prepared.documents {
            stage_document(&transaction, &prepared.identity.migration_id, document)?;
        }
        for asset in &prepared.assets {
            transaction.execute(
                "INSERT INTO migration_stage_assets(
                     migration_id, hash, mime_type, byte_size, payload, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    prepared.identity.migration_id,
                    asset.hash,
                    asset.metadata.mime_type,
                    asset.bytes.len() as i64,
                    asset.bytes,
                    asset.metadata.created_at,
                ],
            )?;
        }
        for entry in &prepared.repo_entries {
            transaction.execute(
                "INSERT INTO migration_stage_repo_storage(
                     migration_id, key_encoded, key_json, value_hash, byte_size, payload
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    prepared.identity.migration_id,
                    entry.key_encoded,
                    entry.key_json,
                    entry.hash,
                    entry.data.len() as i64,
                    entry.data,
                ],
            )?;
        }
        if let Some(authority) = &prepared.workspace_authority {
            transaction.execute(
                "INSERT INTO migration_stage_workspace_authority(
                     migration_id, activation_hash, activation, backup_hash, backup
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    prepared.identity.migration_id,
                    authority.activation_hash,
                    authority.activation,
                    authority.backup_hash,
                    authority.backup,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(MigrationMarker {
            migration_id: prepared.identity.migration_id,
            source_fingerprint: prepared.identity.source_fingerprint,
            artifact_fingerprint: prepared.identity.artifact_fingerprint,
            manifest_sha256: external_hash(&prepared.manifest_hash),
            status: MigrationStatus::Prepared,
            started_at: prepared.prepared_at,
            completed_at: None,
            error: None,
        })
    }

    pub fn v2_commit_migration(
        &self,
        request: CommitMigrationRequest,
    ) -> Result<MigrationMarker, StorageError> {
        validate_migration_identity(&request.identity)?;
        validate_timestamp(&request.committed_at, "committedAt")?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut marker = read_migration_marker(&transaction, &request.identity.migration_id)?
            .ok_or_else(|| StorageError::NotFound("migration marker".to_owned()))?;
        ensure_same_migration(&marker, &request.identity)?;
        match marker.status {
            MigrationStatus::Committed => {
                marker.status = MigrationStatus::AlreadyCommitted;
                return Ok(marker);
            }
            MigrationStatus::RolledBack => {
                return Err(StorageError::Conflict(
                    "a rolled-back migration cannot be committed".to_owned(),
                ))
            }
            MigrationStatus::Prepared => {}
            _ => unreachable!("database markers use only durable status variants"),
        }
        let active_version: String = transaction.query_row(
            "SELECT value FROM meta WHERE key = 'documents.activeVersion'",
            [],
            |row| row.get(0),
        )?;
        if active_version != "1" {
            return Err(StorageError::Conflict(
                "schema-v2 activation is already owned by another migration".to_owned(),
            ));
        }

        let documents = load_staged_documents(&transaction, &marker.migration_id)?;
        let repo_entries = load_staged_repo_entries(&transaction, &marker.migration_id)?;
        if documents.is_empty() && repo_entries.is_empty() {
            return Err(StorageError::Integrity(
                "staged migration contains no documents or repo storage entries".to_owned(),
            ));
        }
        for document in &documents {
            if let Some(existing) =
                read_document_metadata(&transaction, &document.metadata.document_id)?
            {
                if existing != document.metadata {
                    return Err(StorageError::Conflict(format!(
                        "migration document {} conflicts with an existing v2 document",
                        document.metadata.document_id
                    )));
                }
            }
            store_document(&transaction, document)?;
        }
        let assets = load_staged_assets(&transaction, &marker.migration_id)?;
        for asset in &assets {
            let _ = store_asset(&transaction, asset)?;
        }
        for entry in &repo_entries {
            let existing = transaction
                .query_row(
                    "SELECT key_json, value_hash, byte_size, payload
                     FROM repo_storage WHERE key_encoded = ?1",
                    [&entry.key_encoded],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, Vec<u8>>(3)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((key_json, hash, byte_size, data)) = existing {
                if key_json != entry.key_json
                    || hash != entry.hash
                    || byte_size != entry.data.len() as i64
                    || data != entry.data
                {
                    return Err(StorageError::Conflict(
                        "migration repo entry conflicts with an existing value".to_owned(),
                    ));
                }
            }
            store_repo_entry(&transaction, entry)?;
        }
        let stored_manifest: Vec<u8> = transaction.query_row(
            "SELECT manifest FROM migration_runs WHERE id = ?1",
            [&marker.migration_id],
            |row| row.get(0),
        )?;
        if external_hash(&hash_bytes(&stored_manifest)) != marker.manifest_sha256 {
            return Err(StorageError::Integrity(
                "staged migration manifest failed verification".to_owned(),
            ));
        }
        serde_json::from_slice::<serde_json::Value>(&stored_manifest).map_err(|error| {
            StorageError::Integrity(format!(
                "staged migration manifest is invalid JSON: {error}"
            ))
        })?;
        let staged_authority = transaction
            .query_row(
                "SELECT activation_hash, activation, backup_hash, backup
                 FROM migration_stage_workspace_authority WHERE migration_id = ?1",
                [&marker.migration_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((activation_hash, activation, backup_hash, backup)) = staged_authority {
            if hash_bytes(&activation) != activation_hash || hash_bytes(&backup) != backup_hash {
                return Err(StorageError::Integrity(
                    "staged workspace authority failed verification".to_owned(),
                ));
            }
            transaction.execute(
                "INSERT INTO workspace_v2_authority(
                     selector, migration_id, activation_hash, activation,
                     backup_hash, backup, activated_at
                 ) VALUES ('activation:v2', ?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    marker.migration_id,
                    activation_hash,
                    activation,
                    backup_hash,
                    backup,
                    request.committed_at,
                ],
            )?;
            transaction.execute(
                "INSERT INTO meta(key, value) VALUES ('documents.activeVersion', '2')
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [],
            )?;
            transaction.execute(
                "INSERT INTO meta(key, value) VALUES ('documents.activeMigrationId', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [&marker.migration_id],
            )?;
        }
        transaction.execute(
            "UPDATE migration_runs
             SET status = 'committed', completed_at = ?2, error = NULL
             WHERE id = ?1 AND status = 'prepared'",
            params![marker.migration_id, request.committed_at],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_document_chunks WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_documents WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_assets WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_repo_storage WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_workspace_authority WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.commit()?;
        marker.status = MigrationStatus::Committed;
        marker.completed_at = Some(request.committed_at);
        Ok(marker)
    }

    pub fn v2_rollback_migration(
        &self,
        request: RollbackMigrationRequest,
    ) -> Result<MigrationMarker, StorageError> {
        validate_migration_identity(&request.identity)?;
        validate_timestamp(&request.rolled_back_at, "rolledBackAt")?;
        if let Some(reason) = &request.reason {
            if reason.len() > 4_096 || reason.bytes().any(|byte| byte == 0) {
                return Err(StorageError::InvalidV2(
                    "rollback reason is invalid or too long".to_owned(),
                ));
            }
        }
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut marker = read_migration_marker(&transaction, &request.identity.migration_id)?
            .ok_or_else(|| StorageError::NotFound("migration marker".to_owned()))?;
        ensure_same_migration(&marker, &request.identity)?;
        match marker.status {
            MigrationStatus::RolledBack => {
                marker.status = MigrationStatus::AlreadyRolledBack;
                return Ok(marker);
            }
            MigrationStatus::Committed => {
                return Err(StorageError::Conflict(
                    "an active committed migration cannot be rolled back by the staging API"
                        .to_owned(),
                ))
            }
            MigrationStatus::Prepared => {}
            _ => unreachable!("database markers use only durable status variants"),
        }
        transaction.execute(
            "DELETE FROM migration_stage_document_chunks WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_documents WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_assets WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_repo_storage WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "DELETE FROM migration_stage_workspace_authority WHERE migration_id = ?1",
            [&marker.migration_id],
        )?;
        transaction.execute(
            "UPDATE migration_runs
             SET status = 'rolled_back', completed_at = ?2, error = ?3
             WHERE id = ?1 AND status = 'prepared'",
            params![marker.migration_id, request.rolled_back_at, request.reason],
        )?;
        transaction.commit()?;
        marker.status = MigrationStatus::RolledBack;
        marker.completed_at = Some(request.rolled_back_at);
        marker.error = request.reason;
        Ok(marker)
    }

    pub fn v2_get_migration_marker(
        &self,
        migration_id: &str,
    ) -> Result<Option<MigrationMarker>, StorageError> {
        validate_id(migration_id, "migrationId")?;
        let connection = self.connect()?;
        read_migration_marker(&connection, migration_id)
    }

    pub fn v2_get_workspace_authority(&self) -> Result<Option<WorkspaceV2Authority>, StorageError> {
        let connection = self.connect()?;
        let active_version: String = connection.query_row(
            "SELECT value FROM meta WHERE key = 'documents.activeVersion'",
            [],
            |row| row.get(0),
        )?;
        let row = connection
            .query_row(
                "SELECT migration_id, activation_hash, activation, backup_hash,
                        backup, activated_at
                 FROM workspace_v2_authority WHERE selector = 'activation:v2'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()?;
        if (active_version == "2") != row.is_some() {
            return Err(StorageError::CorruptData(
                "documents.activeVersion and activation:v2 disagree".to_owned(),
            ));
        }
        if active_version != "1" && active_version != "2" {
            return Err(StorageError::CorruptData(
                "documents.activeVersion is neither 1 nor 2".to_owned(),
            ));
        }
        row.map(
            |(migration_id, activation_hash, activation, backup_hash, backup, activated_at)| {
                validate_id(&migration_id, "stored migrationId").map_err(|error| {
                    StorageError::CorruptData(format!("workspace authority is invalid: {error}"))
                })?;
                validate_timestamp(&activated_at, "stored activatedAt").map_err(|error| {
                    StorageError::CorruptData(format!("workspace authority is invalid: {error}"))
                })?;
                if activation.len() > MAX_ACTIVATION_BYTES
                    || backup.len() > MAX_V1_BACKUP_BYTES
                    || hash_bytes(&activation) != activation_hash
                    || hash_bytes(&backup) != backup_hash
                    || serde_json::from_slice::<serde_json::Value>(&activation).is_err()
                    || serde_json::from_slice::<serde_json::Value>(&backup).is_err()
                {
                    return Err(StorageError::Integrity(
                        "committed workspace authority failed verification".to_owned(),
                    ));
                }
                Ok(WorkspaceV2Authority {
                    migration_id,
                    activation,
                    backup,
                    activated_at,
                })
            },
        )
        .transpose()
    }

    pub fn v2_additive_import(
        &self,
        request: WorkspaceAdditiveImportRequest,
    ) -> Result<WorkspaceImportOperationResult, StorageError> {
        let prepared = prepare_additive_import(request)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT artifact_fingerprint, status, receipt_hash, receipt
                 FROM workspace_v2_imports WHERE id = ?1",
                [&prepared.import_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some((artifact, status, receipt_hash, receipt)) = existing {
            if artifact != prepared.artifact_fingerprint {
                return Err(StorageError::Conflict(format!(
                    "import ID {} was already used for another artifact",
                    prepared.import_id
                )));
            }
            if hash_bytes(&receipt) != receipt_hash
                || serde_json::from_slice::<serde_json::Value>(&receipt).is_err()
            {
                return Err(StorageError::Integrity(
                    "stored workspace import receipt failed verification".to_owned(),
                ));
            }
            if status == "rolled-back" {
                return Err(StorageError::Conflict(format!(
                    "import {} was rolled back and cannot be replayed",
                    prepared.import_id
                )));
            }
            if status != "committed" {
                return Err(StorageError::CorruptData(
                    "workspace import has an invalid status".to_owned(),
                ));
            }
            return Ok(WorkspaceImportOperationResult {
                import_id: prepared.import_id,
                status: WorkspaceImportOperationStatus::AlreadyCommitted,
                receipt,
            });
        }

        let (current_hash, current_activation): (String, Vec<u8>) = transaction.query_row(
            "SELECT activation_hash, activation FROM workspace_v2_authority
             WHERE selector = 'activation:v2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if hash_bytes(&current_activation) != current_hash {
            return Err(StorageError::Integrity(
                "current activation failed verification".to_owned(),
            ));
        }
        if current_activation != prepared.expected_activation {
            return Err(StorageError::Conflict(
                "active workspace changed before additive import".to_owned(),
            ));
        }
        let prior_repo = load_active_repo_image(&transaction)?;
        transaction.execute(
            "INSERT INTO workspace_v2_imports(
                 id, artifact_fingerprint, status, receipt_hash, receipt,
                 prior_activation_hash, prior_activation,
                 committed_activation_hash, committed_activation,
                 prepared_at, completed_at
             ) VALUES (?1, ?2, 'committed', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                prepared.import_id,
                prepared.artifact_fingerprint,
                prepared.receipt_hash,
                prepared.receipt,
                current_hash,
                current_activation,
                prepared.activation_hash,
                prepared.activation,
                prepared.prepared_at,
            ],
        )?;
        for entry in &prior_repo {
            transaction.execute(
                "INSERT INTO workspace_v2_import_backup_repo(
                     import_id, key_encoded, key_json, value_hash, byte_size, payload
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    prepared.import_id,
                    entry.key_encoded,
                    entry.key_json,
                    entry.hash,
                    entry.data.len() as i64,
                    entry.data,
                ],
            )?;
        }
        publish_workspace_image(
            &transaction,
            &prepared.activation,
            &prepared.activation_hash,
            &prepared.activated_at,
            &prepared.assets,
            &prepared.repo_entries,
        )?;
        let receipt = prepared.receipt;
        let import_id = prepared.import_id;
        transaction.commit()?;
        Ok(WorkspaceImportOperationResult {
            import_id,
            status: WorkspaceImportOperationStatus::Committed,
            receipt,
        })
    }

    pub fn v2_get_workspace_import_receipt(
        &self,
        import_id: &str,
    ) -> Result<Option<Vec<u8>>, StorageError> {
        validate_id(import_id, "importId")?;
        let connection = self.connect()?;
        let row = connection
            .query_row(
                "SELECT receipt_hash, receipt FROM workspace_v2_imports WHERE id = ?1",
                [import_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()?;
        row.map(|(hash, receipt)| {
            if receipt.len() > MAX_MANIFEST_BYTES
                || hash_bytes(&receipt) != hash
                || serde_json::from_slice::<serde_json::Value>(&receipt).is_err()
            {
                return Err(StorageError::Integrity(
                    "stored workspace import receipt failed verification".to_owned(),
                ));
            }
            Ok(receipt)
        })
        .transpose()
    }

    pub fn v2_rollback_workspace_import(
        &self,
        request: RollbackWorkspaceImportRequest,
    ) -> Result<WorkspaceImportOperationResult, StorageError> {
        validate_id(&request.import_id, "importId")?;
        validate_timestamp(&request.rolled_back_at, "rolledBackAt")?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (
            status,
            receipt_hash,
            receipt,
            prior_hash,
            prior_activation,
            committed_hash,
            committed_activation,
        ): (String, String, Vec<u8>, String, Vec<u8>, String, Vec<u8>) = transaction
            .query_row(
                "SELECT status, receipt_hash, receipt, prior_activation_hash,
                        prior_activation, committed_activation_hash, committed_activation
                 FROM workspace_v2_imports WHERE id = ?1",
                [&request.import_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound("workspace import receipt".to_owned()))?;
        if hash_bytes(&receipt) != receipt_hash
            || hash_bytes(&prior_activation) != prior_hash
            || hash_bytes(&committed_activation) != committed_hash
        {
            return Err(StorageError::Integrity(
                "workspace import rollback record failed verification".to_owned(),
            ));
        }
        if status == "rolled-back" {
            return Ok(WorkspaceImportOperationResult {
                import_id: request.import_id,
                status: WorkspaceImportOperationStatus::AlreadyRolledBack,
                receipt,
            });
        }
        if status != "committed" {
            return Err(StorageError::CorruptData(
                "workspace import has an invalid status".to_owned(),
            ));
        }
        let (current_hash, current_activation): (String, Vec<u8>) = transaction.query_row(
            "SELECT activation_hash, activation FROM workspace_v2_authority
             WHERE selector = 'activation:v2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if current_hash != committed_hash || current_activation != committed_activation {
            return Err(StorageError::Conflict(
                "a later workspace revision depends on this import".to_owned(),
            ));
        }
        let prior_json = validate_activation_json(&prior_activation, "priorActivation")?;
        let activated_at = json_string(&prior_json, "activatedAt", "priorActivation")?;
        let stored_receipt: serde_json::Value =
            serde_json::from_slice(&receipt).map_err(|error| {
                StorageError::Integrity(format!(
                    "workspace import receipt is invalid JSON: {error}"
                ))
            })?;
        if let Some(prefixes) = delta_rollback_prefixes(&stored_receipt)? {
            // A delta import stored no copy of the prior Repo image. Its
            // documents are exactly the receipt's prefixes; removing them
            // and restoring the prior activation leaves every document that
            // existed before the import, with any later edits, untouched.
            for prefix in &prefixes {
                remove_repo_prefix(&transaction, &prepare_delta_prefix(prefix)?)?;
            }
            publish_activation_only(&transaction, &prior_activation, &prior_hash, activated_at)?;
        } else {
            let prior_repo = load_import_backup_repo_image(&transaction, &request.import_id)?;
            verify_activation_repo_image(&prior_json, &prior_repo)?;
            publish_workspace_image(
                &transaction,
                &prior_activation,
                &prior_hash,
                activated_at,
                &[],
                &prior_repo,
            )?;
        }
        let mut receipt_json: serde_json::Value =
            serde_json::from_slice(&receipt).map_err(|error| {
                StorageError::Integrity(format!(
                    "workspace import receipt is invalid JSON: {error}"
                ))
            })?;
        receipt_json
            .as_object_mut()
            .ok_or_else(|| {
                StorageError::Integrity("workspace import receipt is not an object".to_owned())
            })?
            .insert(
                "status".to_owned(),
                serde_json::Value::String("rolled-back".to_owned()),
            );
        let rolled_back_receipt = serde_json::to_vec(&receipt_json)?;
        let rolled_back_hash = hash_bytes(&rolled_back_receipt);
        transaction.execute(
            "UPDATE workspace_v2_imports
             SET status = 'rolled-back', receipt_hash = ?2, receipt = ?3, completed_at = ?4
             WHERE id = ?1 AND status = 'committed'",
            params![
                request.import_id,
                rolled_back_hash,
                rolled_back_receipt,
                request.rolled_back_at,
            ],
        )?;
        let import_id = request.import_id;
        transaction.commit()?;
        Ok(WorkspaceImportOperationResult {
            import_id,
            status: WorkspaceImportOperationStatus::RolledBack,
            receipt: rolled_back_receipt,
        })
    }

    pub fn v2_commit_workspace_revision(
        &self,
        request: WorkspaceRevisionCommitRequest,
    ) -> Result<WorkspaceRevisionCommitStatus, StorageError> {
        let prepared = prepare_workspace_revision(request)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (current_hash, current_activation): (String, Vec<u8>) = transaction.query_row(
            "SELECT activation_hash, activation FROM workspace_v2_authority
             WHERE selector = 'activation:v2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if hash_bytes(&current_activation) != current_hash {
            return Err(StorageError::Integrity(
                "current activation failed verification".to_owned(),
            ));
        }
        if current_activation == prepared.activation {
            return Ok(WorkspaceRevisionCommitStatus::AlreadyCommitted);
        }
        if current_activation != prepared.expected_activation {
            return Err(StorageError::Conflict(
                "active workspace changed before revision commit".to_owned(),
            ));
        }
        publish_workspace_image(
            &transaction,
            &prepared.activation,
            &prepared.activation_hash,
            &prepared.activated_at,
            &prepared.assets,
            &prepared.repo_entries,
        )?;
        transaction.commit()?;
        Ok(WorkspaceRevisionCommitStatus::Committed)
    }

    pub fn v2_commit_workspace_delta(
        &self,
        request: WorkspaceDeltaCommitRequest,
    ) -> Result<WorkspaceRevisionCommitStatus, StorageError> {
        let prepared = prepare_workspace_delta(request)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(receipt) = &prepared.receipt {
            let existing = transaction
                .query_row(
                    "SELECT artifact_fingerprint, status FROM workspace_v2_imports WHERE id = ?1",
                    [&receipt.import_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?;
            if let Some((artifact, status)) = existing {
                if artifact != receipt.artifact_fingerprint {
                    return Err(StorageError::Conflict(format!(
                        "import ID {} was already used for another artifact",
                        receipt.import_id
                    )));
                }
                if status == "rolled-back" {
                    return Err(StorageError::Conflict(format!(
                        "import {} was rolled back and cannot be replayed",
                        receipt.import_id
                    )));
                }
                return Ok(WorkspaceRevisionCommitStatus::AlreadyCommitted);
            }
        }
        let (current_hash, current_activation): (String, Vec<u8>) = transaction.query_row(
            "SELECT activation_hash, activation FROM workspace_v2_authority
             WHERE selector = 'activation:v2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if hash_bytes(&current_activation) != current_hash {
            return Err(StorageError::Integrity(
                "current activation failed verification".to_owned(),
            ));
        }
        if current_activation == prepared.activation {
            return Ok(WorkspaceRevisionCommitStatus::AlreadyCommitted);
        }
        if current_activation != prepared.expected_activation {
            return Err(StorageError::Conflict(
                "active workspace changed before the delta commit".to_owned(),
            ));
        }
        for asset in &prepared.assets {
            let _ = store_asset(&transaction, asset)?;
        }
        for hash in &prepared.new_asset_ids {
            let exists = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE hash = ?1)",
                [hash],
                |row| row.get::<_, bool>(0),
            )?;
            if !exists {
                return Err(StorageError::Integrity(format!(
                    "delta commit references missing asset {}",
                    external_hash(hash)
                )));
            }
        }
        for prefix in &prepared.removed_prefixes {
            remove_repo_prefix(&transaction, prefix)?;
        }
        for entry in &prepared.repo_entries {
            store_repo_entry(&transaction, entry)?;
        }
        if let Some(receipt) = &prepared.receipt {
            transaction.execute(
                "INSERT INTO workspace_v2_imports(
                     id, artifact_fingerprint, status, receipt_hash, receipt,
                     prior_activation_hash, prior_activation,
                     committed_activation_hash, committed_activation,
                     prepared_at, completed_at
                 ) VALUES (?1, ?2, 'committed', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    receipt.import_id,
                    receipt.artifact_fingerprint,
                    receipt.receipt_hash,
                    receipt.receipt,
                    current_hash,
                    current_activation,
                    prepared.activation_hash,
                    prepared.activation,
                    receipt.prepared_at,
                ],
            )?;
        }
        publish_activation_only(
            &transaction,
            &prepared.activation,
            &prepared.activation_hash,
            &prepared.activated_at,
        )?;
        transaction.commit()?;
        Ok(WorkspaceRevisionCommitStatus::Committed)
    }

    /// Writes unreferenced Repo chunks and assets for a later delta commit.
    /// No activation references them until that commit publishes them, so a
    /// crash in between leaves only unreachable bytes behind.
    pub fn v2_stage_workspace_entries(
        &self,
        request: WorkspaceStageEntriesRequest,
    ) -> Result<(), StorageError> {
        if request.assets.len() > MAX_MIGRATION_ASSETS
            || request.repo_entries.len() > MAX_REPO_ATOMIC_MUTATIONS
        {
            return Err(StorageError::LimitExceeded(
                "staged entries contain too many assets or Repo entries".to_owned(),
            ));
        }
        let mut total = 0usize;
        let mut assets = Vec::with_capacity(request.assets.len());
        for asset in request.assets {
            let prepared = prepare_asset(asset)?;
            total = total.saturating_add(prepared.bytes.len());
            assets.push(prepared);
        }
        let mut entries = Vec::with_capacity(request.repo_entries.len());
        for entry in request.repo_entries {
            if entry.key.len() < 2 || !DELTA_NAMESPACES.contains(&entry.key[0].as_str()) {
                return Err(StorageError::InvalidV2(
                    "a staged entry must live inside a delta namespace".to_owned(),
                ));
            }
            let prepared = prepare_repo_entry(entry)?;
            total = total.saturating_add(prepared.data.len());
            entries.push(prepared);
        }
        if total > MAX_MIGRATION_BYTES {
            return Err(StorageError::LimitExceeded(
                "staged entries exceed the byte limit".to_owned(),
            ));
        }
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for asset in &assets {
            let _ = store_asset(&transaction, asset)?;
        }
        for entry in &entries {
            store_repo_entry(&transaction, entry)?;
        }
        transaction.commit()?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutOutboxRequest {
    pub operation_id: String,
    pub notebook_id: String,
    pub document_id: String,
    pub local_order: u64,
    pub envelope: Vec<u8>,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRecord {
    pub operation_id: String,
    pub notebook_id: String,
    pub document_id: String,
    pub local_order: u64,
    pub envelope_sha256: String,
    pub envelope: Vec<u8>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteOutboxRequest {
    pub operation_id: String,
    pub envelope_sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncCursor {
    pub notebook_id: String,
    pub contiguous_sequence: u64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetSyncCursorRequest {
    pub notebook_id: String,
    pub expected_contiguous_sequence: u64,
    pub reset_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PutSnapshotRequest {
    pub snapshot_id: String,
    pub document_id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub heads: Vec<String>,
    pub expected_sha256: String,
    pub bytes: Vec<u8>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteSnapshotGuardedRequest {
    pub snapshot_id: String,
    pub expected_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMetadata {
    pub snapshot_id: String,
    pub document_id: String,
    pub name: Option<String>,
    pub heads: Vec<String>,
    pub sha256: String,
    pub byte_size: u64,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotBlob {
    pub metadata: SnapshotMetadata,
    pub bytes: Vec<u8>,
}

impl Database {
    pub fn v2_put_outbox(&self, request: PutOutboxRequest) -> Result<OutboxRecord, StorageError> {
        validate_id(&request.operation_id, "operationId")?;
        validate_id(&request.notebook_id, "notebookId")?;
        validate_id(&request.document_id, "documentId")?;
        validate_timestamp(&request.created_at, "createdAt")?;
        validate_sequence(request.local_order, "localOrder")?;
        if request.envelope.is_empty() || request.envelope.len() > MAX_OUTBOX_BYTES {
            return Err(StorageError::LimitExceeded(format!(
                "an outbox envelope must contain 1 to {MAX_OUTBOX_BYTES} bytes"
            )));
        }
        let record = OutboxRecord {
            operation_id: request.operation_id,
            notebook_id: request.notebook_id,
            document_id: request.document_id,
            local_order: request.local_order,
            envelope_sha256: external_hash(&hash_bytes(&request.envelope)),
            envelope: request.envelope,
            created_at: request.created_at,
        };
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT notebook_id, document_id, local_order, envelope, created_at
                 FROM sync_outbox WHERE id = ?1",
                [&record.operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        if let Some((notebook_id, document_id, local_order, envelope, created_at)) = existing {
            if notebook_id != record.notebook_id
                || document_id != record.document_id
                || local_order != record.local_order as i64
                || envelope != record.envelope
                || created_at != record.created_at
            {
                return Err(StorageError::Conflict(
                    "operationId already exists with different outbox content".to_owned(),
                ));
            }
            return Ok(record);
        }
        transaction.execute(
            "INSERT INTO sync_outbox(
                 id, notebook_id, document_id, local_order, envelope, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                record.operation_id,
                record.notebook_id,
                record.document_id,
                record.local_order as i64,
                record.envelope,
                record.created_at,
            ],
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn v2_list_outbox(
        &self,
        notebook_id: &str,
        after_local_order: Option<u64>,
        limit: Option<u32>,
    ) -> Result<Vec<OutboxRecord>, StorageError> {
        validate_id(notebook_id, "notebookId")?;
        if let Some(value) = after_local_order {
            validate_sequence(value, "afterLocalOrder")?;
        }
        let limit = checked_limit(limit)?;
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT id, notebook_id, document_id, local_order, envelope, created_at
             FROM sync_outbox
             WHERE notebook_id = ?1 AND (?2 IS NULL OR local_order > ?2)
             ORDER BY local_order, id LIMIT ?3",
        )?;
        let rows = statement
            .query_map(
                params![
                    notebook_id,
                    after_local_order.map(|value| value as i64),
                    limit
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Vec<u8>>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(
                |(operation_id, notebook_id, document_id, local_order, envelope, created_at)| {
                    if local_order < 0
                        || local_order as u64 > MAX_SAFE_INTEGER
                        || envelope.is_empty()
                        || envelope.len() > MAX_OUTBOX_BYTES
                    {
                        return Err(StorageError::CorruptData(format!(
                            "outbox operation {operation_id} has invalid stored limits"
                        )));
                    }
                    Ok(OutboxRecord {
                        operation_id,
                        notebook_id,
                        document_id,
                        local_order: local_order as u64,
                        envelope_sha256: external_hash(&hash_bytes(&envelope)),
                        envelope,
                        created_at,
                    })
                },
            )
            .collect()
    }

    pub fn v2_delete_outbox(&self, request: DeleteOutboxRequest) -> Result<bool, StorageError> {
        validate_id(&request.operation_id, "operationId")?;
        let expected = parse_sha256(&request.envelope_sha256, "envelopeSha256")?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let envelope = transaction
            .query_row(
                "SELECT envelope FROM sync_outbox WHERE id = ?1",
                [&request.operation_id],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()?;
        let Some(envelope) = envelope else {
            return Ok(false);
        };
        if hash_bytes(&envelope) != expected {
            return Err(StorageError::Conflict(
                "outbox acknowledgement does not match the durable envelope".to_owned(),
            ));
        }
        transaction.execute(
            "DELETE FROM sync_outbox WHERE id = ?1",
            [&request.operation_id],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn v2_put_sync_cursor(&self, cursor: SyncCursor) -> Result<SyncCursor, StorageError> {
        validate_id(&cursor.notebook_id, "notebookId")?;
        validate_sequence(cursor.contiguous_sequence, "contiguousSequence")?;
        validate_timestamp(&cursor.updated_at, "updatedAt")?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT sequence FROM sync_cursors WHERE notebook_id = ?1",
                [&cursor.notebook_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        if existing.is_some_and(|sequence| sequence > cursor.contiguous_sequence as i64) {
            return Err(StorageError::Conflict(
                "sync cursor cannot move backwards".to_owned(),
            ));
        }
        transaction.execute(
            "INSERT INTO sync_cursors(notebook_id, sequence, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(notebook_id) DO UPDATE SET
                 sequence = excluded.sequence,
                 updated_at = excluded.updated_at",
            params![
                cursor.notebook_id,
                cursor.contiguous_sequence as i64,
                cursor.updated_at,
            ],
        )?;
        transaction.commit()?;
        Ok(cursor)
    }

    pub fn v2_reset_sync_cursor(
        &self,
        request: ResetSyncCursorRequest,
    ) -> Result<SyncCursor, StorageError> {
        validate_id(&request.notebook_id, "notebookId")?;
        validate_sequence(
            request.expected_contiguous_sequence,
            "expectedContiguousSequence",
        )?;
        validate_timestamp(&request.reset_at, "resetAt")?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT sequence, updated_at FROM sync_cursors WHERE notebook_id = ?1",
                [&request.notebook_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((sequence, updated_at)) = existing.as_ref() {
            if *sequence == 0 {
                return Ok(SyncCursor {
                    notebook_id: request.notebook_id,
                    contiguous_sequence: 0,
                    updated_at: updated_at.clone(),
                });
            }
            if *sequence < 0
                || *sequence as u64 > MAX_SAFE_INTEGER
                || *sequence as u64 != request.expected_contiguous_sequence
            {
                return Err(StorageError::Conflict(
                    "sync cursor changed before authenticated reset".to_owned(),
                ));
            }
        } else if request.expected_contiguous_sequence != 0 {
            return Err(StorageError::Conflict(
                "sync cursor changed before authenticated reset".to_owned(),
            ));
        }
        transaction.execute(
            "INSERT INTO sync_cursors(notebook_id, sequence, updated_at)
             VALUES (?1, 0, ?2)
             ON CONFLICT(notebook_id) DO UPDATE SET
                 sequence = 0,
                 updated_at = excluded.updated_at",
            params![request.notebook_id, request.reset_at],
        )?;
        transaction.commit()?;
        Ok(SyncCursor {
            notebook_id: request.notebook_id,
            contiguous_sequence: 0,
            updated_at: request.reset_at,
        })
    }

    pub fn v2_get_sync_cursor(
        &self,
        notebook_id: &str,
    ) -> Result<Option<SyncCursor>, StorageError> {
        validate_id(notebook_id, "notebookId")?;
        let connection = self.connect()?;
        let row = connection
            .query_row(
                "SELECT sequence, updated_at FROM sync_cursors WHERE notebook_id = ?1",
                [notebook_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        row.map(|(sequence, updated_at)| {
            if sequence < 0 || sequence as u64 > MAX_SAFE_INTEGER {
                return Err(StorageError::CorruptData(
                    "sync cursor exceeds the supported range".to_owned(),
                ));
            }
            Ok(SyncCursor {
                notebook_id: notebook_id.to_owned(),
                contiguous_sequence: sequence as u64,
                updated_at,
            })
        })
        .transpose()
    }

    pub fn v2_put_snapshot(
        &self,
        request: PutSnapshotRequest,
    ) -> Result<SnapshotMetadata, StorageError> {
        let prepared = prepare_snapshot(request)?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT document_id, name, heads_json, content_hash, byte_size, payload, created_at
                 FROM document_snapshots WHERE id = ?1",
                [&prepared.metadata.snapshot_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?;
        let heads_json = serde_json::to_string(&prepared.metadata.heads)?;
        if let Some((document_id, name, heads, hash, byte_size, bytes, created_at)) = existing {
            if document_id != prepared.metadata.document_id
                || name != prepared.metadata.name
                || heads != heads_json
                || hash != prepared.hash
                || byte_size != prepared.bytes.len() as i64
                || bytes != prepared.bytes
                || created_at != prepared.metadata.created_at
            {
                return Err(StorageError::Conflict(
                    "snapshotId already exists with different content".to_owned(),
                ));
            }
            return Ok(prepared.metadata);
        }
        transaction.execute(
            "INSERT INTO document_snapshots(
                 id, document_id, name, heads_json, content_hash, byte_size, payload, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                prepared.metadata.snapshot_id,
                prepared.metadata.document_id,
                prepared.metadata.name,
                heads_json,
                prepared.hash,
                prepared.bytes.len() as i64,
                prepared.bytes,
                prepared.metadata.created_at,
            ],
        )?;
        transaction.commit()?;
        Ok(prepared.metadata)
    }

    pub fn v2_get_snapshot(&self, snapshot_id: &str) -> Result<Option<SnapshotBlob>, StorageError> {
        validate_id(snapshot_id, "snapshotId")?;
        let connection = self.connect()?;
        let row = connection
            .query_row(
                "SELECT document_id, name, heads_json, content_hash, byte_size, payload, created_at
                 FROM document_snapshots WHERE id = ?1",
                [snapshot_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Vec<u8>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(document_id, name, heads, hash, byte_size, bytes, created_at)| {
                snapshot_blob(
                    snapshot_id,
                    document_id,
                    name,
                    heads,
                    hash,
                    byte_size,
                    bytes,
                    created_at,
                )
            },
        )
        .transpose()
    }

    pub fn v2_list_snapshots(
        &self,
        document_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<SnapshotMetadata>, StorageError> {
        validate_id(document_id, "documentId")?;
        let limit = checked_limit(limit)?;
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT id, name, heads_json, content_hash, byte_size, created_at
             FROM document_snapshots WHERE document_id = ?1
             ORDER BY created_at DESC, id DESC LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![document_id, limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(snapshot_id, name, heads, hash, byte_size, created_at)| {
                snapshot_metadata(
                    snapshot_id,
                    document_id.to_owned(),
                    name,
                    heads,
                    hash,
                    byte_size,
                    created_at,
                )
            })
            .collect()
    }

    pub fn v2_delete_snapshot(&self, snapshot_id: &str) -> Result<bool, StorageError> {
        validate_id(snapshot_id, "snapshotId")?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "DELETE FROM document_snapshots WHERE id = ?1",
            [snapshot_id],
        )?;
        transaction.commit()?;
        Ok(changed == 1)
    }

    pub fn v2_delete_snapshot_guarded(
        &self,
        request: DeleteSnapshotGuardedRequest,
    ) -> Result<bool, StorageError> {
        validate_id(&request.snapshot_id, "snapshotId")?;
        let expected = parse_sha256(&request.expected_sha256, "expectedSha256")?;
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| StorageError::WriteLockUnavailable)?;
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let stored = transaction
            .query_row(
                "SELECT content_hash, payload FROM document_snapshots WHERE id = ?1",
                [&request.snapshot_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
            )
            .optional()?;
        let Some((stored_hash, bytes)) = stored else {
            return Ok(false);
        };
        if hash_bytes(&bytes) != stored_hash {
            return Err(StorageError::Integrity(format!(
                "snapshot {} failed verification before deletion",
                request.snapshot_id
            )));
        }
        if stored_hash != expected {
            return Err(StorageError::Conflict(
                "snapshot changed before guarded deletion".to_owned(),
            ));
        }
        transaction.execute(
            "DELETE FROM document_snapshots WHERE id = ?1 AND content_hash = ?2",
            params![request.snapshot_id, expected],
        )?;
        transaction.commit()?;
        Ok(true)
    }
}

struct PreparedSnapshot {
    metadata: SnapshotMetadata,
    hash: String,
    bytes: Vec<u8>,
}

fn validate_sequence(value: u64, label: &str) -> Result<(), StorageError> {
    if value > MAX_SAFE_INTEGER {
        return Err(StorageError::InvalidV2(format!(
            "{label} exceeds JavaScript's safe integer range"
        )));
    }
    Ok(())
}

fn prepare_snapshot(request: PutSnapshotRequest) -> Result<PreparedSnapshot, StorageError> {
    validate_id(&request.snapshot_id, "snapshotId")?;
    validate_id(&request.document_id, "documentId")?;
    validate_timestamp(&request.created_at, "createdAt")?;
    validate_heads(&request.heads)?;
    if let Some(name) = &request.name {
        if name.len() > MAX_NAME_BYTES || name.bytes().any(|byte| byte == 0) {
            return Err(StorageError::InvalidV2(
                "snapshot name is invalid or too long".to_owned(),
            ));
        }
    }
    if request.bytes.is_empty() || request.bytes.len() > MAX_DOCUMENT_BYTES {
        return Err(StorageError::LimitExceeded(format!(
            "a snapshot must contain 1 to {MAX_DOCUMENT_BYTES} bytes"
        )));
    }
    let expected = parse_sha256(&request.expected_sha256, "expectedSha256")?;
    let actual = hash_bytes(&request.bytes);
    if expected != actual {
        return Err(StorageError::Integrity(
            "snapshot bytes do not match expectedSha256".to_owned(),
        ));
    }
    Ok(PreparedSnapshot {
        metadata: SnapshotMetadata {
            snapshot_id: request.snapshot_id,
            document_id: request.document_id,
            name: request.name,
            heads: request.heads,
            sha256: external_hash(&actual),
            byte_size: request.bytes.len() as u64,
            created_at: request.created_at,
        },
        hash: actual,
        bytes: request.bytes,
    })
}

#[allow(clippy::too_many_arguments)]
fn snapshot_metadata(
    snapshot_id: String,
    document_id: String,
    name: Option<String>,
    heads_json: String,
    hash: String,
    byte_size: i64,
    created_at: String,
) -> Result<SnapshotMetadata, StorageError> {
    if byte_size <= 0 || byte_size as usize > MAX_DOCUMENT_BYTES || hash.len() != 64 {
        return Err(StorageError::CorruptData(format!(
            "snapshot {snapshot_id} has invalid stored limits"
        )));
    }
    let heads = serde_json::from_str::<Vec<String>>(&heads_json).map_err(|error| {
        StorageError::CorruptData(format!("snapshot {snapshot_id} has invalid heads: {error}"))
    })?;
    validate_heads(&heads).map_err(|error| {
        StorageError::CorruptData(format!("snapshot {snapshot_id} has invalid heads: {error}"))
    })?;
    Ok(SnapshotMetadata {
        snapshot_id,
        document_id,
        name,
        heads,
        sha256: external_hash(&hash),
        byte_size: byte_size as u64,
        created_at,
    })
}

#[allow(clippy::too_many_arguments)]
fn snapshot_blob(
    snapshot_id: &str,
    document_id: String,
    name: Option<String>,
    heads: String,
    hash: String,
    byte_size: i64,
    bytes: Vec<u8>,
    created_at: String,
) -> Result<SnapshotBlob, StorageError> {
    let metadata = snapshot_metadata(
        snapshot_id.to_owned(),
        document_id,
        name,
        heads,
        hash.clone(),
        byte_size,
        created_at,
    )?;
    if bytes.len() != metadata.byte_size as usize || hash_bytes(&bytes) != hash {
        return Err(StorageError::Integrity(format!(
            "snapshot {snapshot_id} failed verification"
        )));
    }
    Ok(SnapshotBlob { metadata, bytes })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

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
                .expect("clock is after Unix epoch")
                .as_nanos();
            let id = TEST_ID.fetch_add(1, Ordering::Relaxed);
            let directory = std::env::temp_dir().join(format!(
                "canvink-v2-storage-test-{}-{nonce}-{id}",
                std::process::id()
            ));
            let database = Database::new(directory.join("notebook.sqlite"));
            database.initialize().expect("database initializes");
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

    fn timestamp() -> String {
        "2026-08-03T12:00:00.000Z".to_owned()
    }

    fn checksum(bytes: &[u8]) -> String {
        external_hash(&hash_bytes(bytes))
    }

    fn document(id: &str, bytes: Vec<u8>) -> PutDocumentRequest {
        PutDocumentRequest {
            document_id: id.to_owned(),
            notebook_id: "notebook-1".to_owned(),
            kind: DocumentKind::Page,
            document_format: DocumentFormat::Automerge,
            encoding: DocumentEncoding::Binary,
            heads: vec!["head-1".to_owned()],
            updated_at: timestamp(),
            expected_sha256: checksum(&bytes),
            bytes: Some(bytes),
            chunks: None,
        }
    }

    fn asset(bytes: Vec<u8>) -> PutAssetRequest {
        PutAssetRequest {
            asset_id: checksum(&bytes),
            mime_type: "image/png".to_owned(),
            bytes,
            created_at: timestamp(),
        }
    }

    fn identity() -> MigrationIdentity {
        MigrationIdentity {
            migration_id: "migration-v1-v2".to_owned(),
            source_fingerprint: format!("sha256:{}", "a".repeat(64)),
            artifact_fingerprint: format!("sha256:{}", "b".repeat(64)),
        }
    }

    fn activation_bytes(
        artifact_fingerprint: &str,
        repo_entries: &[RepoStorageEntry],
    ) -> (Vec<u8>, Vec<u8>) {
        let manifest = serde_json::json!({
            "schemaVersion": 2,
            "format": "canvink-schema-v2",
            "notebookDocumentIds": ["notebook:notebook-1"],
            "pageDocumentIds": ["page:page-1"],
            "active": {
                "notebookId": "notebook-1",
                "sectionId": "section-1",
                "pageId": "page-1"
            }
        });
        let chunks = repo_entries
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "key": entry.key[1..],
                    "checksum": checksum(&entry.data),
                    "size": entry.data.len()
                })
            })
            .collect::<Vec<_>>();
        let activation = serde_json::json!({
            "version": 1,
            "schemaVersion": 2,
            "format": "canvink-automerge-v2",
            "migrationId": identity().migration_id,
            "sourceFingerprint": identity().source_fingerprint,
            "artifactFingerprint": artifact_fingerprint,
            "activatedAt": timestamp(),
            "manifest": manifest,
            "documents": [
                { "documentId": "notebook:notebook-1", "kind": "notebook", "url": "automerge:old-notebook", "heads": ["head-1"] },
                { "documentId": "page:page-1", "kind": "page", "url": "automerge:old-page", "heads": ["head-1"] }
            ],
            "chunks": chunks,
            "assetIds": []
        });
        (
            serde_json::to_vec(&manifest).expect("manifest serializes"),
            serde_json::to_vec(&activation).expect("activation serializes"),
        )
    }

    #[test]
    fn activation_reader_accepts_paired_v2_v3_and_rejects_mixed_versions() {
        let entries = vec![RepoStorageEntry {
            key: vec!["automerge-repo".to_owned(), "doc".to_owned()],
            data: b"repo".to_vec(),
        }];
        let (_, v2_bytes) = activation_bytes(&identity().artifact_fingerprint, &entries);
        validate_activation_json(&v2_bytes, "v2").expect("paired v2 activation reads");

        let mut v3: serde_json::Value = serde_json::from_slice(&v2_bytes).expect("fixture parses");
        v3["schemaVersion"] = serde_json::json!(3);
        v3["format"] = serde_json::json!("canvink-automerge-v3");
        v3["manifest"]["schemaVersion"] = serde_json::json!(3);
        v3["manifest"]["format"] = serde_json::json!("canvink-schema-v3");
        v3["manifest"]["upgrade"] = serde_json::json!({
            "name": "workspace-v2-to-v3",
            "version": 1,
            "upgradeId": format!("workspace-v2-to-v3:{}", "b".repeat(64)),
            "sourceArtifactFingerprint": identity().artifact_fingerprint,
            "preparedAt": timestamp()
        });
        validate_activation_json(&serde_json::to_vec(&v3).expect("v3 serializes"), "v3")
            .expect("paired v3 activation reads");

        v3["format"] = serde_json::json!("canvink-automerge-v2");
        assert!(validate_activation_json(
            &serde_json::to_vec(&v3).expect("mixed serializes"),
            "mixed",
        )
        .is_err());
    }

    fn activate_workspace(test: &TestDatabase, entries: Vec<RepoStorageEntry>) -> Vec<u8> {
        let (manifest, activation) = activation_bytes(&identity().artifact_fingerprint, &entries);
        let backup = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "migrationId": identity().migration_id,
            "sourceFingerprint": identity().source_fingerprint,
            "createdAt": timestamp(),
            "workspace": {}
        }))
        .expect("backup serializes");
        test.database
            .v2_stage_migration(StageMigrationRequest {
                identity: identity(),
                prepared_at: timestamp(),
                manifest,
                documents: vec![],
                assets: vec![],
                repo_entries: entries,
                workspace_authority: Some(MigrationWorkspaceAuthority {
                    activation: activation.clone(),
                    backup,
                }),
            })
            .expect("workspace migration stages");
        test.database
            .v2_commit_migration(CommitMigrationRequest {
                identity: identity(),
                committed_at: timestamp(),
            })
            .expect("workspace migration commits");
        activation
    }

    #[test]
    fn complete_and_chunked_documents_round_trip_with_verified_hashes() {
        let test = TestDatabase::new();
        let bytes = vec![7; MAX_DOCUMENT_CHUNK_BYTES + 3];
        let metadata = test
            .database
            .v2_put_document(document("page:one", bytes.clone()))
            .expect("document stores");
        assert_eq!(metadata.chunk_count, 2);
        assert_eq!(
            test.database
                .v2_get_document_chunk("page:one", 1)
                .expect("chunk reads")
                .expect("chunk exists")
                .bytes,
            vec![7; 3]
        );
        assert_eq!(
            test.database
                .v2_get_document("page:one")
                .expect("document reads")
                .expect("document exists")
                .bytes,
            bytes
        );
    }

    #[test]
    fn document_replacement_rolls_back_when_a_chunk_insert_fails() {
        let test = TestDatabase::new();
        let original = b"original".to_vec();
        test.database
            .v2_put_document(document("page:rollback", original.clone()))
            .expect("baseline stores");
        let connection = test.database.connect().expect("database opens");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_v2_chunk
                 BEFORE INSERT ON crdt_document_chunks
                 WHEN NEW.document_id = 'page:rollback'
                 BEGIN SELECT RAISE(ABORT, 'forced v2 chunk failure'); END;",
            )
            .expect("failure trigger installs");
        drop(connection);

        let replacement = b"replacement".to_vec();
        assert!(matches!(
            test.database
                .v2_put_document(document("page:rollback", replacement)),
            Err(StorageError::Sqlite(_))
        ));
        assert_eq!(
            test.database
                .v2_get_document("page:rollback")
                .expect("baseline reads")
                .expect("baseline exists")
                .bytes,
            original
        );
    }

    #[test]
    fn repo_storage_keys_are_unambiguous_and_ranges_are_deterministic() {
        let test = TestDatabase::new();
        let entries = [
            (vec!["doc".to_owned(), "10".to_owned()], vec![10]),
            (vec!["doc".to_owned(), "2".to_owned()], vec![2]),
            (vec!["doc2".to_owned()], vec![20]),
            (vec!["do".to_owned(), "c".to_owned()], vec![30]),
            (vec!["doc".to_owned()], vec![1]),
        ];
        for (key, data) in entries {
            test.database
                .v2_repo_save(RepoStorageEntry { key, data })
                .expect("repo value stores");
        }

        let range = test
            .database
            .v2_repo_load_range(&["doc".to_owned()])
            .expect("prefix range loads");
        assert_eq!(
            range
                .iter()
                .map(|entry| entry.key.clone())
                .collect::<Vec<_>>(),
            vec![
                vec!["doc".to_owned()],
                vec!["doc".to_owned(), "10".to_owned()],
                vec!["doc".to_owned(), "2".to_owned()],
            ]
        );
        assert_eq!(
            test.database
                .v2_repo_load(&["do".to_owned(), "c".to_owned()])
                .expect("exact key loads"),
            Some(vec![30])
        );
        let mut caller_copy = test
            .database
            .v2_repo_load(&["do".to_owned(), "c".to_owned()])
            .expect("exact key reloads")
            .expect("exact key exists");
        caller_copy[0] = 99;
        assert_eq!(
            test.database
                .v2_repo_load(&["do".to_owned(), "c".to_owned()])
                .expect("stored bytes remain isolated"),
            Some(vec![30])
        );
        assert!(matches!(
            test.database.v2_repo_save(RepoStorageEntry {
                key: vec![String::new()],
                data: vec![],
            }),
            Err(StorageError::InvalidV2(_))
        ));
        assert_eq!(
            test.database
                .v2_repo_remove_range(&["doc".to_owned()])
                .expect("prefix range removes"),
            3
        );
        assert_eq!(
            test.database
                .v2_repo_load_range(&[])
                .expect("root range loads")
                .len(),
            2
        );
    }

    #[test]
    fn assets_are_verified_on_write_and_read() {
        let test = TestDatabase::new();
        let bytes = b"png bytes".to_vec();
        let metadata = test
            .database
            .v2_put_asset(asset(bytes.clone()))
            .expect("asset stores");
        assert_eq!(
            test.database
                .v2_get_asset(&metadata.asset_id)
                .expect("asset reads")
                .expect("asset exists")
                .bytes,
            bytes
        );
        let invalid = PutAssetRequest {
            asset_id: format!("sha256:{}", "0".repeat(64)),
            mime_type: "image/png".to_owned(),
            bytes: b"different".to_vec(),
            created_at: timestamp(),
        };
        assert!(matches!(
            test.database.v2_put_asset(invalid),
            Err(StorageError::Integrity(_))
        ));
    }

    #[test]
    fn staged_migration_commit_is_atomic_across_documents_assets_repo_and_marker() {
        let test = TestDatabase::new();
        let stage = StageMigrationRequest {
            identity: identity(),
            prepared_at: timestamp(),
            manifest: br#"{"schemaVersion":2}"#.to_vec(),
            documents: vec![document("page:migrated", b"crdt".to_vec())],
            assets: vec![asset(b"asset".to_vec())],
            repo_entries: vec![RepoStorageEntry {
                key: vec![
                    "docs".to_owned(),
                    "page:migrated".to_owned(),
                    "incremental".to_owned(),
                ],
                data: b"repo chunk".to_vec(),
            }],
            workspace_authority: None,
        };
        test.database
            .v2_stage_migration(stage)
            .expect("migration stages");
        let connection = test.database.connect().expect("database opens");
        connection
            .execute_batch(
                "CREATE TRIGGER reject_migration_repo
                 BEFORE INSERT ON repo_storage
                 BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;",
            )
            .expect("failure trigger installs");
        drop(connection);

        let request = CommitMigrationRequest {
            identity: identity(),
            committed_at: timestamp(),
        };
        assert!(matches!(
            test.database.v2_commit_migration(request.clone()),
            Err(StorageError::Sqlite(_))
        ));
        let connection = test.database.connect().expect("database reopens");
        let active: String = connection
            .query_row(
                "SELECT value FROM meta WHERE key = 'documents.activeVersion'",
                [],
                |row| row.get(0),
            )
            .expect("activation marker reads");
        let durable_rows: i64 = connection
            .query_row(
                "SELECT
                    (SELECT count(*) FROM crdt_documents) +
                    (SELECT count(*) FROM assets) +
                    (SELECT count(*) FROM repo_storage)",
                [],
                |row| row.get(0),
            )
            .expect("durable rows count");
        let staged_rows: i64 = connection
            .query_row(
                "SELECT count(*) FROM migration_stage_documents",
                [],
                |row| row.get(0),
            )
            .expect("staged rows count");
        assert_eq!(active, "1");
        assert_eq!(durable_rows, 0);
        assert_eq!(staged_rows, 1);
        connection
            .execute_batch("DROP TRIGGER reject_migration_repo")
            .expect("failure trigger drops");
        drop(connection);

        let marker = test
            .database
            .v2_commit_migration(request)
            .expect("migration commits after blocker clears");
        assert_eq!(marker.status, MigrationStatus::Committed);
        assert!(test
            .database
            .v2_repo_load(&[
                "docs".to_owned(),
                "page:migrated".to_owned(),
                "incremental".to_owned(),
            ])
            .expect("repo chunk reads")
            .is_some());
    }

    #[test]
    fn workspace_authority_and_backup_publish_atomically_and_commit_retry_is_idempotent() {
        let test = TestDatabase::new();
        let identity = identity();
        let manifest = serde_json::json!({ "schemaVersion": 2 });
        let activation = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "schemaVersion": 2,
            "format": "canvink-automerge-v2",
            "migrationId": identity.migration_id.clone(),
            "sourceFingerprint": identity.source_fingerprint.clone(),
            "artifactFingerprint": identity.artifact_fingerprint.clone(),
            "activatedAt": timestamp(),
            "manifest": manifest,
            "documents": [],
            "chunks": [],
            "assetIds": []
        }))
        .expect("activation serializes");
        let backup = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "migrationId": identity.migration_id.clone(),
            "sourceFingerprint": identity.source_fingerprint.clone(),
            "createdAt": timestamp(),
            "workspace": {}
        }))
        .expect("backup serializes");
        test.database
            .v2_stage_migration(StageMigrationRequest {
                identity: identity.clone(),
                prepared_at: timestamp(),
                manifest: serde_json::to_vec(&manifest).expect("manifest serializes"),
                documents: vec![],
                assets: vec![],
                repo_entries: vec![RepoStorageEntry {
                    key: vec!["automerge-repo".to_owned(), "migration".to_owned()],
                    data: vec![1],
                }],
                workspace_authority: Some(MigrationWorkspaceAuthority {
                    activation: activation.clone(),
                    backup: backup.clone(),
                }),
            })
            .expect("migration stages");
        assert!(test
            .database
            .v2_get_workspace_authority()
            .expect("authority query succeeds")
            .is_none());

        let request = CommitMigrationRequest {
            identity,
            committed_at: timestamp(),
        };
        assert_eq!(
            test.database
                .v2_commit_migration(request.clone())
                .expect("migration commits")
                .status,
            MigrationStatus::Committed
        );
        assert_eq!(
            test.database
                .v2_commit_migration(request)
                .expect("lost acknowledgement retry succeeds")
                .status,
            MigrationStatus::AlreadyCommitted
        );
        let authority = test
            .database
            .v2_get_workspace_authority()
            .expect("authority reads")
            .expect("authority is active");
        assert_eq!(authority.activation, activation);
        assert_eq!(authority.backup, backup);

        let connection = test.database.connect().expect("database reopens");
        connection
            .execute("DELETE FROM workspace_v2_authority", [])
            .expect("test removes authority selector");
        drop(connection);
        assert!(matches!(
            test.database.v2_get_workspace_authority(),
            Err(StorageError::CorruptData(_))
        ));
    }

    #[test]
    fn additive_import_is_atomic_idempotent_and_guardedly_rollbackable() {
        let test = TestDatabase::new();
        let old_entry = RepoStorageEntry {
            key: vec!["automerge-repo".to_owned(), "old".to_owned()],
            data: b"old repo image".to_vec(),
        };
        let old_activation = activate_workspace(&test, vec![old_entry.clone()]);
        let new_entries = vec![
            old_entry.clone(),
            RepoStorageEntry {
                key: vec!["automerge-repo".to_owned(), "imported".to_owned()],
                data: b"imported repo data".to_vec(),
            },
        ];
        let new_artifact = format!("sha256:{}", "c".repeat(64));
        let (_, new_activation) = activation_bytes(&new_artifact, &new_entries);
        let import_artifact = format!("sha256:{}", "d".repeat(64));
        let receipt = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "importId": "import-1",
            "importArtifactFingerprint": import_artifact,
            "priorActivationArtifactFingerprint": identity().artifact_fingerprint,
            "committedActivationArtifactFingerprint": new_artifact,
            "backupId": "import-backup:import-1",
            "notebookDocumentId": "notebook:notebook-1",
            "pageDocumentIds": ["page:page-1"],
            "assetIds": [],
            "preparedAt": timestamp(),
            "status": "committed"
        }))
        .expect("receipt serializes");
        let request = WorkspaceAdditiveImportRequest {
            expected_activation: old_activation.clone(),
            activation: new_activation.clone(),
            receipt,
            assets: vec![],
            repo_entries: new_entries,
        };
        assert_eq!(
            test.database
                .v2_additive_import(request.clone())
                .expect("additive import commits")
                .status,
            WorkspaceImportOperationStatus::Committed
        );
        assert_eq!(
            test.database
                .v2_additive_import(request)
                .expect("lost acknowledgement retry is idempotent")
                .status,
            WorkspaceImportOperationStatus::AlreadyCommitted
        );
        assert!(test
            .database
            .v2_repo_load(&["automerge-repo".to_owned(), "imported".to_owned()])
            .expect("imported Repo value reads")
            .is_some());

        let rollback = test
            .database
            .v2_rollback_workspace_import(RollbackWorkspaceImportRequest {
                import_id: "import-1".to_owned(),
                rolled_back_at: timestamp(),
            })
            .expect("last additive import rolls back");
        assert_eq!(rollback.status, WorkspaceImportOperationStatus::RolledBack);
        assert!(test
            .database
            .v2_repo_load(&["automerge-repo".to_owned(), "imported".to_owned()])
            .expect("rolled-back Repo value reads")
            .is_none());
        assert_eq!(
            test.database
                .v2_get_workspace_authority()
                .expect("authority reads")
                .expect("authority remains active")
                .activation,
            old_activation
        );
        assert_eq!(
            test.database
                .v2_rollback_workspace_import(RollbackWorkspaceImportRequest {
                    import_id: "import-1".to_owned(),
                    rolled_back_at: timestamp(),
                })
                .expect("rollback retry is idempotent")
                .status,
            WorkspaceImportOperationStatus::AlreadyRolledBack
        );
    }

    fn delta_activation(base: &[u8], artifact: &str, extra_page: bool) -> Vec<u8> {
        let mut activation: serde_json::Value =
            serde_json::from_slice(base).expect("activation parses");
        activation["artifactFingerprint"] = serde_json::json!(artifact);
        activation["layout"] = serde_json::json!("repo-live");
        if extra_page {
            activation["manifest"]["pageDocumentIds"] =
                serde_json::json!(["page:page-1", "page:page-2"]);
            activation["documents"]
                .as_array_mut()
                .expect("documents array")
                .push(serde_json::json!({
                    "documentId": "page:page-2", "kind": "page",
                    "url": "automerge:new-page", "heads": ["head-2"]
                }));
        }
        serde_json::to_vec(&activation).expect("activation serializes")
    }

    fn repo_key(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| (*part).to_owned()).collect()
    }

    #[test]
    fn delta_commit_writes_only_changes_with_activation_cas() {
        let test = TestDatabase::new();
        let kept = RepoStorageEntry {
            key: repo_key(&["automerge-repo", "old-page", "snapshot", "a"]),
            data: b"kept page".to_vec(),
        };
        let removed = RepoStorageEntry {
            key: repo_key(&["automerge-repo", "gone-page", "snapshot", "b"]),
            data: b"removed page".to_vec(),
        };
        let old_activation = activate_workspace(&test, vec![kept.clone(), removed.clone()]);
        let artifact = format!("sha256:{}", "e".repeat(64));
        let activation = delta_activation(&old_activation, &artifact, true);
        let request = WorkspaceDeltaCommitRequest {
            expected_activation: old_activation.clone(),
            activation: activation.clone(),
            receipt: None,
            assets: vec![],
            repo_entries: vec![RepoStorageEntry {
                key: repo_key(&["automerge-repo", "new-page", "snapshot", "c"]),
                data: b"new page".to_vec(),
            }],
            removed_prefixes: vec![repo_key(&["automerge-repo", "gone-page"])],
        };
        assert_eq!(
            test.database
                .v2_commit_workspace_delta(request.clone())
                .expect("delta commits"),
            WorkspaceRevisionCommitStatus::Committed
        );
        assert!(test
            .database
            .v2_repo_load(&kept.key)
            .expect("reads")
            .is_some());
        assert!(test
            .database
            .v2_repo_load(&removed.key)
            .expect("reads")
            .is_none());
        assert!(test
            .database
            .v2_repo_load(&repo_key(&["automerge-repo", "new-page", "snapshot", "c"]))
            .expect("reads")
            .is_some());
        assert_eq!(
            test.database
                .v2_commit_workspace_delta(request.clone())
                .expect("retry is idempotent"),
            WorkspaceRevisionCommitStatus::AlreadyCommitted
        );
        // A stale expectation is a conflict and writes nothing.
        let stale = WorkspaceDeltaCommitRequest {
            activation: delta_activation(
                &old_activation,
                &format!("sha256:{}", "f".repeat(64)),
                false,
            ),
            repo_entries: vec![RepoStorageEntry {
                key: repo_key(&["automerge-repo", "stale", "snapshot", "d"]),
                data: b"stale".to_vec(),
            }],
            ..request
        };
        assert!(matches!(
            test.database.v2_commit_workspace_delta(stale),
            Err(StorageError::Conflict(_))
        ));
        assert!(test
            .database
            .v2_repo_load(&repo_key(&["automerge-repo", "stale", "snapshot", "d"]))
            .expect("reads")
            .is_none());
        // Delta commits cannot wipe a whole namespace or write outside it.
        let wipe = WorkspaceDeltaCommitRequest {
            expected_activation: activation.clone(),
            activation: delta_activation(&activation, &format!("sha256:{}", "1".repeat(64)), true),
            receipt: None,
            assets: vec![],
            repo_entries: vec![],
            removed_prefixes: vec![repo_key(&["automerge-repo"])],
        };
        assert!(matches!(
            test.database.v2_commit_workspace_delta(wipe),
            Err(StorageError::InvalidV2(_))
        ));
    }

    #[test]
    fn delta_import_rollback_removes_only_imported_prefixes() {
        let test = TestDatabase::new();
        let existing = RepoStorageEntry {
            key: repo_key(&["automerge-repo", "old-page", "snapshot", "a"]),
            data: b"existing page".to_vec(),
        };
        let old_activation = activate_workspace(&test, vec![existing.clone()]);
        let imported = RepoStorageEntry {
            key: repo_key(&["automerge-repo", "new-page", "snapshot", "c"]),
            data: b"imported page".to_vec(),
        };
        test.database
            .v2_stage_workspace_entries(WorkspaceStageEntriesRequest {
                assets: vec![],
                repo_entries: vec![imported.clone()],
            })
            .expect("staging writes unreferenced chunks");
        let artifact = format!("sha256:{}", "e".repeat(64));
        let activation = delta_activation(&old_activation, &artifact, true);
        let receipt = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "importId": "import-delta",
            "importArtifactFingerprint": format!("sha256:{}", "d".repeat(64)),
            "priorActivationArtifactFingerprint": identity().artifact_fingerprint,
            "committedActivationArtifactFingerprint": artifact,
            "backupId": "import-backup:import-delta",
            "notebookDocumentId": "notebook:notebook-1",
            "pageDocumentIds": ["page:page-2"],
            "assetIds": [],
            "preparedAt": timestamp(),
            "status": "committed",
            "rollback": {
                "mode": "remove-prefixes",
                "prefixes": [["automerge-repo", "new-page"], ["canvink-page-index", "new-page"]]
            }
        }))
        .expect("receipt serializes");
        let request = WorkspaceDeltaCommitRequest {
            expected_activation: old_activation.clone(),
            activation,
            receipt: Some(receipt),
            assets: vec![],
            repo_entries: vec![RepoStorageEntry {
                key: repo_key(&["canvink-page-index", "new-page"]),
                data: b"{}".to_vec(),
            }],
            removed_prefixes: vec![],
        };
        assert_eq!(
            test.database
                .v2_commit_workspace_delta(request.clone())
                .expect("delta import commits"),
            WorkspaceRevisionCommitStatus::Committed
        );
        assert_eq!(
            test.database
                .v2_commit_workspace_delta(request)
                .expect("import replay is idempotent"),
            WorkspaceRevisionCommitStatus::AlreadyCommitted
        );
        // An edit to an existing page after the import survives the rollback.
        test.database
            .v2_repo_save(RepoStorageEntry {
                key: repo_key(&["automerge-repo", "old-page", "incremental", "edit"]),
                data: b"later edit".to_vec(),
            })
            .expect("live edit persists");
        let rollback = test
            .database
            .v2_rollback_workspace_import(RollbackWorkspaceImportRequest {
                import_id: "import-delta".to_owned(),
                rolled_back_at: timestamp(),
            })
            .expect("delta import rolls back");
        assert_eq!(rollback.status, WorkspaceImportOperationStatus::RolledBack);
        assert!(test
            .database
            .v2_repo_load(&imported.key)
            .expect("reads")
            .is_none());
        assert!(test
            .database
            .v2_repo_load(&repo_key(&["canvink-page-index", "new-page"]))
            .expect("reads")
            .is_none());
        assert!(test
            .database
            .v2_repo_load(&existing.key)
            .expect("reads")
            .is_some());
        assert!(test
            .database
            .v2_repo_load(&repo_key(&[
                "automerge-repo",
                "old-page",
                "incremental",
                "edit"
            ]))
            .expect("reads")
            .is_some());
        assert_eq!(
            test.database
                .v2_get_workspace_authority()
                .expect("authority reads")
                .expect("authority remains")
                .activation,
            old_activation
        );
    }

    #[test]
    fn later_workspace_revision_blocks_import_rollback() {
        let test = TestDatabase::new();
        let old_entry = RepoStorageEntry {
            key: vec!["automerge-repo".to_owned(), "old".to_owned()],
            data: b"old repo image".to_vec(),
        };
        let old_activation = activate_workspace(&test, vec![old_entry.clone()]);
        let imported_entries = vec![
            old_entry,
            RepoStorageEntry {
                key: vec!["automerge-repo".to_owned(), "imported".to_owned()],
                data: b"imported repo data".to_vec(),
            },
        ];
        let imported_artifact = format!("sha256:{}", "f".repeat(64));
        let (_, imported_activation) = activation_bytes(&imported_artifact, &imported_entries);
        let receipt = serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "importId": "import-with-dependent-revision",
            "importArtifactFingerprint": format!("sha256:{}", "a".repeat(64)),
            "priorActivationArtifactFingerprint": identity().artifact_fingerprint,
            "committedActivationArtifactFingerprint": imported_artifact,
            "backupId": "import-backup:import-with-dependent-revision",
            "notebookDocumentId": "notebook:notebook-1",
            "pageDocumentIds": ["page:page-1"],
            "assetIds": [],
            "preparedAt": timestamp(),
            "status": "committed"
        }))
        .expect("receipt serializes");
        test.database
            .v2_additive_import(WorkspaceAdditiveImportRequest {
                expected_activation: old_activation,
                activation: imported_activation.clone(),
                receipt,
                assets: vec![],
                repo_entries: imported_entries,
            })
            .expect("additive import commits");

        let revised_entries = vec![RepoStorageEntry {
            key: vec!["automerge-repo".to_owned(), "later".to_owned()],
            data: b"later revision repo data".to_vec(),
        }];
        let (_, revised_activation) =
            activation_bytes(&format!("sha256:{}", "b".repeat(64)), &revised_entries);
        test.database
            .v2_commit_workspace_revision(WorkspaceRevisionCommitRequest {
                expected_activation: imported_activation,
                activation: revised_activation.clone(),
                assets: vec![],
                repo_entries: revised_entries,
            })
            .expect("dependent workspace revision commits");

        assert!(matches!(
            test.database
                .v2_rollback_workspace_import(RollbackWorkspaceImportRequest {
                    import_id: "import-with-dependent-revision".to_owned(),
                    rolled_back_at: timestamp(),
                }),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(
            test.database
                .v2_get_workspace_authority()
                .expect("authority reads")
                .expect("authority remains active")
                .activation,
            revised_activation
        );
        let receipt = test
            .database
            .v2_get_workspace_import_receipt("import-with-dependent-revision")
            .expect("receipt reads")
            .expect("receipt remains present");
        let receipt: serde_json::Value =
            serde_json::from_slice(&receipt).expect("receipt remains valid JSON");
        assert_eq!(
            receipt.get("status").and_then(serde_json::Value::as_str),
            Some("committed")
        );
    }

    #[test]
    fn workspace_revision_uses_activation_cas_and_complete_repo_replacement() {
        let test = TestDatabase::new();
        let old_entry = RepoStorageEntry {
            key: vec!["automerge-repo".to_owned(), "old".to_owned()],
            data: b"old repo image".to_vec(),
        };
        let old_activation = activate_workspace(&test, vec![old_entry]);
        let replacement = vec![RepoStorageEntry {
            key: vec!["automerge-repo".to_owned(), "replacement".to_owned()],
            data: b"replacement repo image".to_vec(),
        }];
        let (_, new_activation) =
            activation_bytes(&format!("sha256:{}", "e".repeat(64)), &replacement);
        let request = WorkspaceRevisionCommitRequest {
            expected_activation: old_activation,
            activation: new_activation.clone(),
            assets: vec![],
            repo_entries: replacement,
        };
        assert_eq!(
            test.database
                .v2_commit_workspace_revision(request.clone())
                .expect("workspace revision commits"),
            WorkspaceRevisionCommitStatus::Committed
        );
        assert_eq!(
            test.database
                .v2_commit_workspace_revision(request)
                .expect("workspace revision retry reconciles"),
            WorkspaceRevisionCommitStatus::AlreadyCommitted
        );
        assert!(test
            .database
            .v2_repo_load(&["automerge-repo".to_owned(), "old".to_owned()])
            .expect("old Repo key lookup succeeds")
            .is_none());
        assert_eq!(
            test.database
                .v2_get_workspace_authority()
                .expect("authority reads")
                .expect("authority exists")
                .activation,
            new_activation
        );
    }

    #[test]
    fn rollback_discards_only_stage_and_records_a_durable_marker() {
        let test = TestDatabase::new();
        test.database
            .v2_stage_migration(StageMigrationRequest {
                identity: identity(),
                prepared_at: timestamp(),
                manifest: br#"{"schemaVersion":2}"#.to_vec(),
                documents: vec![],
                assets: vec![],
                repo_entries: vec![RepoStorageEntry {
                    key: vec!["migration".to_owned()],
                    data: vec![1],
                }],
                workspace_authority: None,
            })
            .expect("migration stages");
        let marker = test
            .database
            .v2_rollback_migration(RollbackMigrationRequest {
                identity: identity(),
                rolled_back_at: timestamp(),
                reason: Some("user cancelled".to_owned()),
            })
            .expect("migration rolls back");
        assert_eq!(marker.status, MigrationStatus::RolledBack);
        assert_eq!(marker.error.as_deref(), Some("user cancelled"));
        assert!(test
            .database
            .v2_repo_load(&["migration".to_owned()])
            .expect("active repo reads")
            .is_none());
    }

    #[test]
    fn outbox_cursor_and_snapshots_persist_with_conflict_checks() {
        let test = TestDatabase::new();
        test.database
            .v2_put_document(document("page:sync", b"document".to_vec()))
            .expect("document stores");
        let outbox = test
            .database
            .v2_put_outbox(PutOutboxRequest {
                operation_id: "op-1".to_owned(),
                notebook_id: "notebook-1".to_owned(),
                document_id: "page:sync".to_owned(),
                local_order: 0,
                envelope: vec![1, 2, 3],
                created_at: timestamp(),
            })
            .expect("outbox stores");
        assert_eq!(
            test.database
                .v2_list_outbox("notebook-1", None, None)
                .expect("outbox lists"),
            vec![outbox.clone()]
        );
        for local_order in 1..=2 {
            test.database
                .v2_put_outbox(PutOutboxRequest {
                    operation_id: format!("op-{}", local_order + 1),
                    notebook_id: "notebook-1".to_owned(),
                    document_id: "page:sync".to_owned(),
                    local_order,
                    envelope: vec![local_order as u8 + 1],
                    created_at: timestamp(),
                })
                .expect("additional outbox entry stores");
        }
        let first_page = test
            .database
            .v2_list_outbox("notebook-1", None, Some(2))
            .expect("first outbox page lists");
        assert_eq!(
            first_page
                .iter()
                .map(|entry| entry.local_order)
                .collect::<Vec<_>>(),
            vec![0, 1]
        );
        let second_page = test
            .database
            .v2_list_outbox("notebook-1", Some(1), Some(2))
            .expect("second outbox page lists");
        assert_eq!(
            second_page
                .iter()
                .map(|entry| entry.local_order)
                .collect::<Vec<_>>(),
            vec![2]
        );
        assert!(matches!(
            test.database.v2_delete_outbox(DeleteOutboxRequest {
                operation_id: "op-1".to_owned(),
                envelope_sha256: format!("sha256:{}", "0".repeat(64)),
            }),
            Err(StorageError::Conflict(_))
        ));

        let cursor = SyncCursor {
            notebook_id: "notebook-1".to_owned(),
            contiguous_sequence: 5,
            updated_at: timestamp(),
        };
        test.database
            .v2_put_sync_cursor(cursor.clone())
            .expect("cursor stores");
        let mut regressed = cursor.clone();
        regressed.contiguous_sequence = 4;
        assert!(matches!(
            test.database.v2_put_sync_cursor(regressed),
            Err(StorageError::Conflict(_))
        ));
        let reset = test
            .database
            .v2_reset_sync_cursor(ResetSyncCursorRequest {
                notebook_id: "notebook-1".to_owned(),
                expected_contiguous_sequence: 5,
                reset_at: "2026-08-03T12:00:00.000Z".to_owned(),
            })
            .expect("authenticated reset moves the cursor to zero");
        assert_eq!(reset.contiguous_sequence, 0);
        assert_eq!(
            test.database
                .v2_reset_sync_cursor(ResetSyncCursorRequest {
                    notebook_id: "notebook-1".to_owned(),
                    expected_contiguous_sequence: 5,
                    reset_at: "2026-08-03T12:01:00.000Z".to_owned(),
                })
                .expect("lost reset acknowledgement is idempotent"),
            reset
        );
        test.database
            .v2_put_sync_cursor(SyncCursor {
                notebook_id: "notebook-1".to_owned(),
                contiguous_sequence: 2,
                updated_at: timestamp(),
            })
            .expect("cursor advances after reset replay");
        assert!(matches!(
            test.database.v2_reset_sync_cursor(ResetSyncCursorRequest {
                notebook_id: "notebook-1".to_owned(),
                expected_contiguous_sequence: 5,
                reset_at: timestamp(),
            }),
            Err(StorageError::Conflict(_))
        ));
        assert_eq!(
            test.database
                .v2_get_sync_cursor("notebook-1")
                .expect("cursor reads"),
            Some(SyncCursor {
                notebook_id: "notebook-1".to_owned(),
                contiguous_sequence: 2,
                updated_at: timestamp(),
            })
        );

        let snapshot_bytes = b"snapshot".to_vec();
        let snapshot = test
            .database
            .v2_put_snapshot(PutSnapshotRequest {
                snapshot_id: "snapshot-1".to_owned(),
                document_id: "page:restored-copy".to_owned(),
                name: Some("Before edits".to_owned()),
                heads: vec!["head-1".to_owned()],
                expected_sha256: checksum(&snapshot_bytes),
                bytes: snapshot_bytes.clone(),
                created_at: timestamp(),
            })
            .expect("snapshot stores");
        assert_eq!(
            test.database
                .v2_get_snapshot("snapshot-1")
                .expect("snapshot reads")
                .expect("snapshot exists")
                .bytes,
            snapshot_bytes
        );
        assert_eq!(
            test.database
                .v2_list_snapshots("page:restored-copy", None)
                .expect("snapshots list"),
            vec![snapshot.clone()]
        );
        assert!(matches!(
            test.database
                .v2_delete_snapshot_guarded(DeleteSnapshotGuardedRequest {
                    snapshot_id: snapshot.snapshot_id.clone(),
                    expected_sha256: format!("sha256:{}", "0".repeat(64)),
                }),
            Err(StorageError::Conflict(_))
        ));
        assert!(test
            .database
            .v2_delete_snapshot_guarded(DeleteSnapshotGuardedRequest {
                snapshot_id: snapshot.snapshot_id,
                expected_sha256: snapshot.sha256,
            })
            .expect("matching snapshot checksum permits deletion"));
        assert!(test
            .database
            .v2_list_snapshots("page:restored-copy", None)
            .expect("snapshot deletion reads back")
            .is_empty());
    }
}
