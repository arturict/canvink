use std::{
    collections::HashMap,
    fs,
    io::Write,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use reqwest::{header, redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

const PROTOCOL_VERSION: u8 = 1;
const MAX_REQUEST_BYTES: usize = 512 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_SECRET_BYTES: usize = 8 * 1024;
const MAX_VAULT_BYTES: usize = 64 * 1024;
const MAX_STROKES: usize = 256;
const MAX_POINTS_PER_STROKE: usize = 4_096;
const MAX_TOTAL_POINTS: usize = 16_384;
const MAX_BOUND: f64 = 8_192.0;
const MAX_LATEX_BYTES: usize = 64 * 1024;
const MAX_CANDIDATES: usize = 5;
const MAX_WARNINGS: usize = 32;
const MAX_VERSION_BYTES: usize = 128;
const MAX_ENDPOINT_BYTES: usize = 2_048;
const MAX_ACTIVE_REQUESTS: usize = 8;
const MIN_SECRET_SUBSTRING_BYTES: usize = 8;
const MATHPIX_ENDPOINT: &str = "https://api.mathpix.com/v3/strokes";
const PROVIDER_ENTROPY: &[u8] = b"Canvink|DPAPI|math-provider-secret|v1";
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecognitionProviderKind {
    Compatible,
    Mathpix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecognitionNetworkScope {
    Public,
    Private,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ProviderConfigurationRequest {
    Compatible {
        endpoint: String,
        network_scope: RecognitionNetworkScope,
        allow_insecure_private_http: bool,
        bearer_token_base64: String,
    },
    Mathpix {
        app_id_base64: String,
        app_key_base64: String,
    },
}

impl Drop for ProviderConfigurationRequest {
    fn drop(&mut self) {
        match self {
            Self::Compatible {
                endpoint,
                bearer_token_base64,
                ..
            } => {
                endpoint.zeroize();
                bearer_token_base64.zeroize();
            }
            Self::Mathpix {
                app_id_base64,
                app_key_base64,
            } => {
                app_id_base64.zeroize();
                app_key_base64.zeroize();
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum StoredProviderConfiguration {
    Compatible {
        endpoint: String,
        network_scope: RecognitionNetworkScope,
        allow_insecure_private_http: bool,
        bearer_token: String,
    },
    Mathpix {
        app_id: String,
        app_key: String,
    },
}

impl StoredProviderConfiguration {
    fn kind(&self) -> RecognitionProviderKind {
        match self {
            Self::Compatible { .. } => RecognitionProviderKind::Compatible,
            Self::Mathpix { .. } => RecognitionProviderKind::Mathpix,
        }
    }

    fn network_scope(&self) -> RecognitionNetworkScope {
        match self {
            Self::Compatible { network_scope, .. } => *network_scope,
            Self::Mathpix { .. } => RecognitionNetworkScope::Public,
        }
    }
}

impl Drop for StoredProviderConfiguration {
    fn drop(&mut self) {
        match self {
            Self::Compatible {
                endpoint,
                bearer_token,
                ..
            } => {
                endpoint.zeroize();
                bearer_token.zeroize();
            }
            Self::Mathpix { app_id, app_key } => {
                app_id.zeroize();
                app_key.zeroize();
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    provider: RecognitionProviderKind,
    configured: bool,
    network_scope: RecognitionNetworkScope,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedPoint {
    x: f64,
    y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pressure: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedStroke {
    points: Vec<NormalizedPoint>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecognitionBoundingBox {
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecognitionSettings {
    angle_mode: String,
    decimal_separator: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecognitionRequest {
    protocol_version: u8,
    selection_kind: String,
    trigger: String,
    user_initiated: bool,
    provider: RecognitionProviderKind,
    operation_id: String,
    request_id: String,
    revision_sha256: String,
    strokes: Vec<NormalizedStroke>,
    bounding_box: RecognitionBoundingBox,
    locale: String,
    settings: RecognitionSettings,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionCandidate {
    latex: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionResult {
    protocol_version: u8,
    request_id: String,
    revision_sha256: String,
    latex: String,
    candidates: Vec<RecognitionCandidate>,
    provider: RecognitionProviderKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    processing_duration_ms: Option<u64>,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MathRecognitionCommandError {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecognitionFailure {
    InvalidInput,
    PayloadTooLarge,
    ProviderUnavailable,
    SecretUnavailable,
    UnsafeEndpoint,
    Network,
    Timeout,
    Http,
    InvalidResponse,
    Aborted,
}

impl From<RecognitionFailure> for MathRecognitionCommandError {
    fn from(value: RecognitionFailure) -> Self {
        let (code, message, retryable) = match value {
            RecognitionFailure::InvalidInput => {
                ("invalid-input", "Math recognition input is invalid.", false)
            }
            RecognitionFailure::PayloadTooLarge => (
                "payload-too-large",
                "Math recognition input exceeds a configured limit.",
                false,
            ),
            RecognitionFailure::ProviderUnavailable => (
                "provider-unavailable",
                "The math recognition provider is unavailable.",
                false,
            ),
            RecognitionFailure::SecretUnavailable => (
                "secret-unavailable",
                "The math recognition credential is unavailable.",
                false,
            ),
            RecognitionFailure::UnsafeEndpoint => (
                "unsafe-endpoint",
                "The math recognition endpoint is not permitted.",
                false,
            ),
            RecognitionFailure::Network => (
                "network-error",
                "The math recognition request failed.",
                true,
            ),
            RecognitionFailure::Timeout => {
                ("timeout", "The math recognition request timed out.", true)
            }
            RecognitionFailure::Http => (
                "http-error",
                "The math recognition provider rejected the request.",
                false,
            ),
            RecognitionFailure::InvalidResponse => (
                "invalid-response",
                "The math recognition provider returned an invalid response.",
                false,
            ),
            RecognitionFailure::Aborted => (
                "aborted",
                "The math recognition request was cancelled.",
                false,
            ),
        };
        Self {
            code,
            message,
            retryable,
        }
    }
}

#[derive(Clone)]
pub struct MathRecognitionState {
    vault: ProviderVault,
    in_flight: Arc<InFlightRegistry>,
}

impl MathRecognitionState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            vault: ProviderVault::new(app_data_dir.join("canvink").join("math-provider-vault")),
            in_flight: Arc::new(InFlightRegistry::default()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct RecognitionBinding {
    request_id: String,
    revision_sha256: String,
}

impl RecognitionBinding {
    fn validate(&self) -> Result<(), RecognitionFailure> {
        if !safe_identifier(&self.request_id)
            || self.revision_sha256.len() != 64
            || !self
                .revision_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(RecognitionFailure::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecognitionCancellationRequest {
    request_id: String,
    revision_sha256: String,
}

impl From<RecognitionCancellationRequest> for RecognitionBinding {
    fn from(value: RecognitionCancellationRequest) -> Self {
        Self {
            request_id: value.request_id,
            revision_sha256: value.revision_sha256,
        }
    }
}

struct ActiveRequest {
    generation: u64,
    cancel: Arc<dyn Fn() + Send + Sync>,
    cancellation_dispatched: bool,
}

#[derive(Default)]
struct DeferredAbort {
    requested: AtomicBool,
    action: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl DeferredAbort {
    fn request(&self) {
        self.requested.store(true, Ordering::Release);
        if let Ok(action) = self.action.lock() {
            if let Some(action) = action.as_ref() {
                action();
            }
        }
    }

    fn bind(&self, action: Arc<dyn Fn() + Send + Sync>) {
        if let Ok(mut stored) = self.action.lock() {
            *stored = Some(Arc::clone(&action));
        } else {
            action();
            return;
        }
        if self.requested.load(Ordering::Acquire) {
            action();
        }
    }

    fn is_requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }
}

#[derive(Default)]
struct InFlightRegistry {
    active: Mutex<HashMap<RecognitionBinding, ActiveRequest>>,
    generation: AtomicU64,
}

impl InFlightRegistry {
    fn register(
        self: &Arc<Self>,
        binding: RecognitionBinding,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<InFlightRegistration, RecognitionFailure> {
        binding.validate()?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| RecognitionFailure::ProviderUnavailable)?;
        if active.len() >= MAX_ACTIVE_REQUESTS {
            return Err(RecognitionFailure::ProviderUnavailable);
        }
        if active.contains_key(&binding) {
            return Err(RecognitionFailure::InvalidInput);
        }
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        active.insert(
            binding.clone(),
            ActiveRequest {
                generation,
                cancel,
                cancellation_dispatched: false,
            },
        );
        Ok(InFlightRegistration {
            registry: Arc::clone(self),
            binding,
            generation,
        })
    }

    fn cancel(&self, binding: &RecognitionBinding) -> Result<bool, RecognitionFailure> {
        binding.validate()?;
        let cancel = {
            let mut active = self
                .active
                .lock()
                .map_err(|_| RecognitionFailure::ProviderUnavailable)?;
            let Some(request) = active.get_mut(binding) else {
                return Ok(false);
            };
            if request.cancellation_dispatched {
                return Ok(true);
            }
            request.cancellation_dispatched = true;
            Arc::clone(&request.cancel)
        };
        cancel();
        Ok(true)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.active.lock().expect("registry lock").len()
    }
}

struct InFlightRegistration {
    registry: Arc<InFlightRegistry>,
    binding: RecognitionBinding,
    generation: u64,
}

impl Drop for InFlightRegistration {
    fn drop(&mut self) {
        if let Ok(mut active) = self.registry.active.lock() {
            if active
                .get(&self.binding)
                .is_some_and(|request| request.generation == self.generation)
            {
                active.remove(&self.binding);
            }
        }
    }
}

#[derive(Clone)]
struct ProviderVault {
    directory: PathBuf,
}

impl ProviderVault {
    fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn path(&self, provider: RecognitionProviderKind) -> PathBuf {
        self.directory.join(match provider {
            RecognitionProviderKind::Compatible => "compatible.vault",
            RecognitionProviderKind::Mathpix => "mathpix.vault",
        })
    }

    fn save(&self, configuration: &StoredProviderConfiguration) -> Result<(), RecognitionFailure> {
        fs::create_dir_all(&self.directory).map_err(|_| RecognitionFailure::SecretUnavailable)?;
        let mut plaintext = Zeroizing::new(
            serde_json::to_vec(configuration).map_err(|_| RecognitionFailure::InvalidInput)?,
        );
        if plaintext.is_empty() || plaintext.len() > MAX_VAULT_BYTES {
            return Err(RecognitionFailure::PayloadTooLarge);
        }
        let protected = protect_provider_bytes(&mut plaintext)?;
        plaintext.zeroize();
        if protected.is_empty() || protected.len() > MAX_VAULT_BYTES {
            return Err(RecognitionFailure::PayloadTooLarge);
        }
        atomic_write(&self.path(configuration.kind()), protected.as_slice())
    }

    fn load(
        &self,
        provider: RecognitionProviderKind,
    ) -> Result<Option<StoredProviderConfiguration>, RecognitionFailure> {
        let path = self.path(provider);
        let mut protected = match fs::read(path) {
            Ok(value) => Zeroizing::new(value),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(RecognitionFailure::SecretUnavailable),
        };
        if protected.is_empty() || protected.len() > MAX_VAULT_BYTES {
            return Err(RecognitionFailure::SecretUnavailable);
        }
        let plaintext = unprotect_provider_bytes(&mut protected)?;
        protected.zeroize();
        let configuration: StoredProviderConfiguration = serde_json::from_slice(&plaintext)
            .map_err(|_| RecognitionFailure::SecretUnavailable)?;
        if configuration.kind() != provider {
            return Err(RecognitionFailure::SecretUnavailable);
        }
        Ok(Some(configuration))
    }

    fn delete(&self, provider: RecognitionProviderKind) -> Result<(), RecognitionFailure> {
        match fs::remove_file(self.path(provider)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(RecognitionFailure::SecretUnavailable),
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), RecognitionFailure> {
    let parent = path.parent().ok_or(RecognitionFailure::SecretUnavailable)?;
    let temporary = parent.join(format!(
        ".math-provider-{}-{}.tmp",
        std::process::id(),
        TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|_| RecognitionFailure::SecretUnavailable)?;
        file.write_all(bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| RecognitionFailure::SecretUnavailable)?;
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), RecognitionFailure> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: both paths are valid, NUL-terminated UTF-16 buffers for the call.
    let succeeded = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        return Err(RecognitionFailure::SecretUnavailable);
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), RecognitionFailure> {
    fs::rename(source, destination).map_err(|_| RecognitionFailure::SecretUnavailable)
}

#[cfg(windows)]
fn protect_provider_bytes(
    plaintext: &mut Zeroizing<Vec<u8>>,
) -> Result<Zeroizing<Vec<u8>>, RecognitionFailure> {
    crypt_protect(plaintext, PROVIDER_ENTROPY)
}

#[cfg(windows)]
fn unprotect_provider_bytes(
    protected: &mut Zeroizing<Vec<u8>>,
) -> Result<Zeroizing<Vec<u8>>, RecognitionFailure> {
    crypt_unprotect(protected, PROVIDER_ENTROPY)
}

#[cfg(windows)]
fn crypt_protect(
    plaintext: &mut Zeroizing<Vec<u8>>,
    entropy_bytes: &[u8],
) -> Result<Zeroizing<Vec<u8>>, RecognitionFailure> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB},
    };

    let mut entropy = Zeroizing::new(entropy_bytes.to_vec());
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len() as u32,
        pbData: plaintext.as_mut_ptr(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: all blob pointers remain valid for the duration of the call and UI is forbidden.
    let succeeded = unsafe {
        CryptProtectData(
            &input,
            null(),
            &entropy_blob,
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 || output.pbData.is_null() || output.cbData == 0 {
        return Err(RecognitionFailure::SecretUnavailable);
    }
    let length = output.cbData as usize;
    if length > MAX_VAULT_BYTES {
        // SAFETY: DPAPI allocated cbData writable bytes at pbData.
        unsafe {
            std::slice::from_raw_parts_mut(output.pbData, length).zeroize();
            LocalFree(output.pbData.cast());
        }
        return Err(RecognitionFailure::PayloadTooLarge);
    }
    // SAFETY: DPAPI returned exactly cbData readable bytes.
    let copied = unsafe { std::slice::from_raw_parts(output.pbData, length) }.to_vec();
    // SAFETY: the DPAPI allocation is writable for cbData bytes and released with LocalFree.
    unsafe {
        std::slice::from_raw_parts_mut(output.pbData, length).zeroize();
        LocalFree(output.pbData.cast());
    }
    Ok(Zeroizing::new(copied))
}

#[cfg(windows)]
fn crypt_unprotect(
    protected: &mut Zeroizing<Vec<u8>>,
    entropy_bytes: &[u8],
) -> Result<Zeroizing<Vec<u8>>, RecognitionFailure> {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };

    let mut entropy = Zeroizing::new(entropy_bytes.to_vec());
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len() as u32,
        pbData: protected.as_mut_ptr(),
    };
    let entropy_blob = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: all blob pointers remain valid for the duration of the call and UI is forbidden.
    let succeeded = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            &entropy_blob,
            null_mut(),
            null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if succeeded == 0 || output.pbData.is_null() || output.cbData == 0 {
        return Err(RecognitionFailure::SecretUnavailable);
    }
    let length = output.cbData as usize;
    if length > MAX_VAULT_BYTES {
        // SAFETY: DPAPI allocated cbData writable bytes at pbData.
        unsafe {
            std::slice::from_raw_parts_mut(output.pbData, length).zeroize();
            LocalFree(output.pbData.cast());
        }
        return Err(RecognitionFailure::PayloadTooLarge);
    }
    // SAFETY: DPAPI returned exactly cbData readable bytes.
    let copied = unsafe { std::slice::from_raw_parts(output.pbData, length) }.to_vec();
    // SAFETY: the DPAPI allocation is writable for cbData bytes and released with LocalFree.
    unsafe {
        std::slice::from_raw_parts_mut(output.pbData, length).zeroize();
        LocalFree(output.pbData.cast());
    }
    Ok(Zeroizing::new(copied))
}

#[cfg(not(windows))]
fn protect_provider_bytes(
    _plaintext: &mut Zeroizing<Vec<u8>>,
) -> Result<Zeroizing<Vec<u8>>, RecognitionFailure> {
    Err(RecognitionFailure::ProviderUnavailable)
}

#[cfg(not(windows))]
fn unprotect_provider_bytes(
    _protected: &mut Zeroizing<Vec<u8>>,
) -> Result<Zeroizing<Vec<u8>>, RecognitionFailure> {
    Err(RecognitionFailure::ProviderUnavailable)
}

fn decode_secret(value: &mut String) -> Result<Zeroizing<Vec<u8>>, RecognitionFailure> {
    if value.is_empty() || value.len() > MAX_SECRET_BYTES.div_ceil(3) * 4 {
        return Err(RecognitionFailure::InvalidInput);
    }
    let decoded = BASE64_STANDARD
        .decode(value.as_bytes())
        .map_err(|_| RecognitionFailure::InvalidInput)?;
    if decoded.is_empty()
        || decoded.len() > MAX_SECRET_BYTES
        || BASE64_STANDARD.encode(&decoded) != *value
    {
        return Err(RecognitionFailure::InvalidInput);
    }
    value.zeroize();
    Ok(Zeroizing::new(decoded))
}

fn secret_string(bytes: &Zeroizing<Vec<u8>>) -> Result<String, RecognitionFailure> {
    let value = std::str::from_utf8(bytes).map_err(|_| RecognitionFailure::InvalidInput)?;
    if value.is_empty()
        || value
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err(RecognitionFailure::InvalidInput);
    }
    Ok(value.to_owned())
}

fn stored_configuration(
    request: &mut ProviderConfigurationRequest,
) -> Result<StoredProviderConfiguration, RecognitionFailure> {
    match request {
        ProviderConfigurationRequest::Compatible {
            endpoint,
            network_scope,
            allow_insecure_private_http,
            bearer_token_base64,
        } => {
            let parsed =
                validate_compatible_url(endpoint, *network_scope, *allow_insecure_private_http)?;
            let token = decode_secret(bearer_token_base64)?;
            let bearer_token = secret_string(&token)?;
            Ok(StoredProviderConfiguration::Compatible {
                endpoint: parsed.to_string(),
                network_scope: *network_scope,
                allow_insecure_private_http: *allow_insecure_private_http,
                bearer_token,
            })
        }
        ProviderConfigurationRequest::Mathpix {
            app_id_base64,
            app_key_base64,
        } => {
            let app_id_bytes = decode_secret(app_id_base64)?;
            let app_key_bytes = decode_secret(app_key_base64)?;
            Ok(StoredProviderConfiguration::Mathpix {
                app_id: secret_string(&app_id_bytes)?,
                app_key: secret_string(&app_key_bytes)?,
            })
        }
    }
}

fn validate_request(request: &RecognitionRequest) -> Result<(), RecognitionFailure> {
    if request.protocol_version != PROTOCOL_VERSION
        || request.selection_kind != "explicitMathSelection"
        || !matches!(
            request.trigger.as_str(),
            "activeLocalMathBlock" | "explicitUserSelection"
        )
        || !request.user_initiated
        || !safe_identifier(&request.operation_id)
        || !safe_identifier(&request.request_id)
        || request.revision_sha256.len() != 64
        || !request
            .revision_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !valid_locale(&request.locale)
        || !matches!(request.settings.angle_mode.as_str(), "degree" | "radian")
        || !matches!(request.settings.decimal_separator.as_str(), "dot" | "comma")
    {
        return Err(RecognitionFailure::InvalidInput);
    }
    if !request.bounding_box.width.is_finite()
        || !request.bounding_box.height.is_finite()
        || request.bounding_box.width <= 0.0
        || request.bounding_box.height <= 0.0
        || request.bounding_box.width > MAX_BOUND
        || request.bounding_box.height > MAX_BOUND
    {
        return Err(RecognitionFailure::InvalidInput);
    }
    if request.strokes.is_empty() || request.strokes.len() > MAX_STROKES {
        return Err(RecognitionFailure::InvalidInput);
    }
    let mut total_points = 0_usize;
    for stroke in &request.strokes {
        if stroke.points.is_empty() {
            return Err(RecognitionFailure::InvalidInput);
        }
        if stroke.points.len() > MAX_POINTS_PER_STROKE {
            return Err(RecognitionFailure::PayloadTooLarge);
        }
        total_points = total_points
            .checked_add(stroke.points.len())
            .ok_or(RecognitionFailure::PayloadTooLarge)?;
        if total_points > MAX_TOTAL_POINTS {
            return Err(RecognitionFailure::PayloadTooLarge);
        }
        for point in &stroke.points {
            if !point.x.is_finite()
                || !point.y.is_finite()
                || !(0.0..=1.0).contains(&point.x)
                || !(0.0..=1.0).contains(&point.y)
                || point.pressure.is_some_and(|pressure| {
                    !pressure.is_finite() || !(0.0..=1.0).contains(&pressure)
                })
            {
                return Err(RecognitionFailure::InvalidInput);
            }
        }
    }
    let serialized = serde_json::to_vec(request).map_err(|_| RecognitionFailure::InvalidInput)?;
    if serialized.len() > MAX_REQUEST_BYTES {
        return Err(RecognitionFailure::PayloadTooLarge);
    }
    Ok(())
}

fn safe_identifier(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn valid_locale(value: &str) -> bool {
    if value.is_empty() || value.len() > 35 || !value.is_ascii() {
        return false;
    }
    let mut parts = value.split('-');
    let Some(language) = parts.next() else {
        return false;
    };
    if !(2..=8).contains(&language.len())
        || !language.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    parts.all(|part| {
        (1..=8).contains(&part.len()) && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

fn validate_compatible_url(
    value: &str,
    scope: RecognitionNetworkScope,
    allow_insecure_private_http: bool,
) -> Result<Url, RecognitionFailure> {
    if value.is_empty() || value.len() > MAX_ENDPOINT_BYTES {
        return Err(RecognitionFailure::UnsafeEndpoint);
    }
    let parsed = Url::parse(value).map_err(|_| RecognitionFailure::UnsafeEndpoint)?;
    if parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/v1/math/recognize"
    {
        return Err(RecognitionFailure::UnsafeEndpoint);
    }
    match parsed.scheme() {
        "https" => {}
        "http" if scope == RecognitionNetworkScope::Private && allow_insecure_private_http => {
            let host = parsed
                .host_str()
                .ok_or(RecognitionFailure::UnsafeEndpoint)?;
            let address = parse_ip_host(host)?;
            if !is_allowed_private(address) {
                return Err(RecognitionFailure::UnsafeEndpoint);
            }
        }
        _ => return Err(RecognitionFailure::UnsafeEndpoint),
    }
    Ok(parsed)
}

fn is_tailscale(address: Ipv4Addr) -> bool {
    let raw = u32::from(address);
    (raw & 0xffc0_0000) == u32::from(Ipv4Addr::new(100, 64, 0, 0))
}

fn parse_ip_host(value: &str) -> Result<IpAddr, RecognitionFailure> {
    value
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse()
        .map_err(|_| RecognitionFailure::UnsafeEndpoint)
}

fn is_allowed_private(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => value.is_private() || value.is_loopback() || is_tailscale(value),
        IpAddr::V6(value) => {
            value
                .to_ipv4_mapped()
                .is_some_and(|mapped| is_allowed_private(IpAddr::V4(mapped)))
                || value.is_loopback()
                || value.is_unique_local()
        }
    }
}

fn is_documentation_v4(value: Ipv4Addr) -> bool {
    let octets = value.octets();
    matches!(
        octets,
        [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
    )
}

fn is_benchmark_v4(value: Ipv4Addr) -> bool {
    let octets = value.octets();
    octets[0] == 198 && matches!(octets[1], 18 | 19)
}

fn is_documentation_v6(value: Ipv6Addr) -> bool {
    let segments = value.segments();
    segments[0] == 0x2001 && segments[1] == 0x0db8
}

fn is_allowed_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => {
            let first = value.octets()[0];
            !value.is_private()
                && !value.is_loopback()
                && !value.is_link_local()
                && !value.is_multicast()
                && !value.is_unspecified()
                && !value.is_broadcast()
                && !is_tailscale(value)
                && !is_documentation_v4(value)
                && !is_benchmark_v4(value)
                && first != 0
                && first < 224
        }
        IpAddr::V6(value) => {
            value.segments()[0] & 0xe000 == 0x2000
                && value.to_ipv4_mapped().is_none()
                && !is_documentation_v6(value)
        }
    }
}

fn validate_resolved_addresses(
    addresses: &[SocketAddr],
    scope: RecognitionNetworkScope,
) -> Result<(), RecognitionFailure> {
    if addresses.is_empty()
        || addresses.iter().any(|address| match scope {
            RecognitionNetworkScope::Private => !is_allowed_private(address.ip()),
            RecognitionNetworkScope::Public => !is_allowed_public(address.ip()),
        })
    {
        return Err(RecognitionFailure::UnsafeEndpoint);
    }
    Ok(())
}

async fn resolve_and_pin(
    endpoint: &Url,
    scope: RecognitionNetworkScope,
) -> Result<Client, RecognitionFailure> {
    let host = endpoint
        .host_str()
        .ok_or(RecognitionFailure::UnsafeEndpoint)?
        .to_owned();
    let port = endpoint
        .port_or_known_default()
        .ok_or(RecognitionFailure::UnsafeEndpoint)?;
    let resolve_host = host.clone();
    let addresses = tauri::async_runtime::spawn_blocking(move || {
        (resolve_host.as_str(), port)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    })
    .await
    .map_err(|_| RecognitionFailure::Network)?
    .map_err(|_| RecognitionFailure::Network)?;
    validate_resolved_addresses(&addresses, scope)?;
    Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(20))
        .user_agent("Canvink-Math-Recognition/1")
        .resolve_to_addrs(&host, &addresses)
        .build()
        .map_err(|_| RecognitionFailure::ProviderUnavailable)
}

struct PreparedProviderRequest {
    endpoint: Url,
    scope: RecognitionNetworkScope,
    headers: Vec<(&'static str, String)>,
    body: Zeroizing<Vec<u8>>,
}

impl Drop for PreparedProviderRequest {
    fn drop(&mut self) {
        for (_, value) in &mut self.headers {
            value.zeroize();
        }
    }
}

fn prepare_provider_request(
    configuration: &StoredProviderConfiguration,
    request: &RecognitionRequest,
) -> Result<PreparedProviderRequest, RecognitionFailure> {
    validate_request(request)?;
    if configuration.kind() != request.provider {
        return Err(RecognitionFailure::ProviderUnavailable);
    }
    match configuration {
        StoredProviderConfiguration::Compatible {
            endpoint,
            network_scope,
            allow_insecure_private_http,
            bearer_token,
        } => {
            let endpoint =
                validate_compatible_url(endpoint, *network_scope, *allow_insecure_private_http)?;
            let body = serde_json::to_vec(&serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "requestId": request.request_id,
                "strokes": request.strokes,
                "boundingBox": {
                    "x": 0,
                    "y": 0,
                    "width": request.bounding_box.width,
                    "height": request.bounding_box.height,
                },
                "locale": request.locale,
                "settings": request.settings,
            }))
            .map_err(|_| RecognitionFailure::InvalidInput)?;
            if body.len() > MAX_REQUEST_BYTES {
                return Err(RecognitionFailure::PayloadTooLarge);
            }
            Ok(PreparedProviderRequest {
                endpoint,
                scope: *network_scope,
                headers: vec![("authorization", format!("Bearer {bearer_token}"))],
                body: Zeroizing::new(body),
            })
        }
        StoredProviderConfiguration::Mathpix { app_id, app_key } => {
            let endpoint = Url::parse(MATHPIX_ENDPOINT)
                .map_err(|_| RecognitionFailure::ProviderUnavailable)?;
            let x = request
                .strokes
                .iter()
                .map(|stroke| {
                    stroke
                        .points
                        .iter()
                        .map(|point| point.x * request.bounding_box.width)
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let y = request
                .strokes
                .iter()
                .map(|stroke| {
                    stroke
                        .points
                        .iter()
                        .map(|point| point.y * request.bounding_box.height)
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            let body = serde_json::to_vec(&serde_json::json!({
                "strokes": { "strokes": { "x": x, "y": y } },
                "formats": ["latex_styled"],
                "metadata": { "improve_mathpix": false },
            }))
            .map_err(|_| RecognitionFailure::InvalidInput)?;
            if body.len() > MAX_REQUEST_BYTES {
                return Err(RecognitionFailure::PayloadTooLarge);
            }
            Ok(PreparedProviderRequest {
                endpoint,
                scope: RecognitionNetworkScope::Public,
                headers: vec![("app_id", app_id.clone()), ("app_key", app_key.clone())],
                body: Zeroizing::new(body),
            })
        }
    }
}

async fn send_provider_request(
    prepared: &mut PreparedProviderRequest,
) -> Result<Zeroizing<Vec<u8>>, RecognitionFailure> {
    let client = resolve_and_pin(&prepared.endpoint, prepared.scope).await?;
    let mut request = client
        .post(prepared.endpoint.clone())
        .header(header::ACCEPT, "application/json")
        .header(header::CONTENT_TYPE, "application/json");
    for (name, value) in &prepared.headers {
        request = request.header(*name, value);
    }
    let body = prepared.body.to_vec();
    let mut response = request.body(body).send().await.map_err(|error| {
        if error.is_timeout() {
            RecognitionFailure::Timeout
        } else {
            RecognitionFailure::Network
        }
    })?;
    if !response.status().is_success() {
        return Err(RecognitionFailure::Http);
    }
    let media_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim);
    if media_type != Some("application/json") {
        return Err(RecognitionFailure::InvalidResponse);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(RecognitionFailure::InvalidResponse);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            RecognitionFailure::Timeout
        } else {
            RecognitionFailure::Network
        }
    })? {
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(RecognitionFailure::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(RecognitionFailure::InvalidResponse);
    }
    Ok(bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompatibleCandidate {
    latex: String,
    confidence: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompatibleResponse {
    latex: String,
    #[serde(default)]
    candidates: Vec<CompatibleCandidate>,
    model_version: Option<String>,
    api_version: Option<String>,
    processing_duration_ms: Option<u64>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Deserialize)]
struct MathpixResponse {
    latex_styled: Option<String>,
    text: Option<String>,
    confidence: Option<f64>,
    is_handwritten: Option<bool>,
    version: Option<String>,
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && !value.chars().any(|character| {
            character == '\0'
                || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        })
}

fn valid_confidence(value: Option<f64>) -> bool {
    value.is_none_or(|confidence| confidence.is_finite() && (0.0..=1.0).contains(&confidence))
}

fn strip_mathpix_delimiters(value: &str) -> &str {
    let trimmed = value.trim();
    if (trimmed.starts_with("\\(") && trimmed.ends_with("\\)"))
        || (trimmed.starts_with("\\[") && trimmed.ends_with("\\]"))
    {
        trimmed[2..trimmed.len() - 2].trim()
    } else {
        trimmed
    }
}

fn parse_provider_response(
    provider: RecognitionProviderKind,
    bytes: &[u8],
    request_id: String,
    revision_sha256: String,
    elapsed_ms: u64,
) -> Result<RecognitionResult, RecognitionFailure> {
    if bytes.is_empty() || bytes.len() > MAX_RESPONSE_BYTES {
        return Err(RecognitionFailure::InvalidResponse);
    }
    match provider {
        RecognitionProviderKind::Compatible => {
            let response: CompatibleResponse =
                serde_json::from_slice(bytes).map_err(|_| RecognitionFailure::InvalidResponse)?;
            if !valid_text(&response.latex, MAX_LATEX_BYTES)
                || response.candidates.len() > MAX_CANDIDATES
                || response.warnings.len() > MAX_WARNINGS
                || response.candidates.iter().any(|candidate| {
                    !valid_text(&candidate.latex, MAX_LATEX_BYTES)
                        || !valid_confidence(candidate.confidence)
                })
                || response
                    .warnings
                    .iter()
                    .any(|warning| !valid_text(warning, MAX_VERSION_BYTES))
                || response
                    .model_version
                    .as_deref()
                    .is_some_and(|value| !valid_text(value, MAX_VERSION_BYTES))
                || response
                    .api_version
                    .as_deref()
                    .is_some_and(|value| !valid_text(value, MAX_VERSION_BYTES))
                || response
                    .processing_duration_ms
                    .is_some_and(|value| value > 120_000)
            {
                return Err(RecognitionFailure::InvalidResponse);
            }
            Ok(RecognitionResult {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                revision_sha256,
                latex: response.latex,
                candidates: response
                    .candidates
                    .into_iter()
                    .map(|candidate| RecognitionCandidate {
                        latex: candidate.latex,
                        confidence: candidate.confidence,
                    })
                    .collect(),
                provider,
                model_version: response.model_version,
                api_version: response.api_version,
                processing_duration_ms: response.processing_duration_ms.or(Some(elapsed_ms)),
                warnings: response.warnings,
            })
        }
        RecognitionProviderKind::Mathpix => {
            let response: MathpixResponse =
                serde_json::from_slice(bytes).map_err(|_| RecognitionFailure::InvalidResponse)?;
            let latex_source = response
                .latex_styled
                .as_deref()
                .or(response.text.as_deref())
                .ok_or(RecognitionFailure::InvalidResponse)?;
            let latex = strip_mathpix_delimiters(latex_source).to_owned();
            if !valid_text(&latex, MAX_LATEX_BYTES)
                || !valid_confidence(response.confidence)
                || response
                    .version
                    .as_deref()
                    .is_some_and(|value| !valid_text(value, MAX_VERSION_BYTES))
            {
                return Err(RecognitionFailure::InvalidResponse);
            }
            let warnings = if response.is_handwritten == Some(false) {
                vec!["notHandwritten".to_owned()]
            } else {
                Vec::new()
            };
            Ok(RecognitionResult {
                protocol_version: PROTOCOL_VERSION,
                request_id,
                revision_sha256,
                latex,
                candidates: Vec::new(),
                provider,
                model_version: response.version,
                api_version: Some("v3/strokes".to_owned()),
                processing_duration_ms: Some(elapsed_ms),
                warnings,
            })
        }
    }
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let difference = left
        .iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        });
    difference == 0
}

fn value_reflects_secret(value: &str, secret: &[u8]) -> bool {
    let value = value.as_bytes();
    constant_time_equal(value, secret)
        || (secret.len() >= MIN_SECRET_SUBSTRING_BYTES
            && value.len() > secret.len()
            && value
                .windows(secret.len())
                .any(|window| constant_time_equal(window, secret)))
}

fn credential_patterns(configuration: &StoredProviderConfiguration) -> Vec<Zeroizing<Vec<u8>>> {
    let credentials: Vec<&str> = match configuration {
        StoredProviderConfiguration::Compatible { bearer_token, .. } => vec![bearer_token],
        StoredProviderConfiguration::Mathpix { app_id, app_key } => vec![app_id, app_key],
    };
    credentials
        .into_iter()
        .flat_map(|credential| {
            [
                Zeroizing::new(credential.as_bytes().to_vec()),
                Zeroizing::new(BASE64_STANDARD.encode(credential.as_bytes()).into_bytes()),
            ]
        })
        .collect()
}

fn reject_credential_reflection(
    result: &RecognitionResult,
    configuration: &StoredProviderConfiguration,
) -> Result<(), RecognitionFailure> {
    let patterns = credential_patterns(configuration);
    let reflected = std::iter::once(result.latex.as_str())
        .chain(
            result
                .candidates
                .iter()
                .map(|candidate| candidate.latex.as_str()),
        )
        .chain(result.warnings.iter().map(String::as_str))
        .chain(result.model_version.as_deref())
        .chain(result.api_version.as_deref())
        .any(|value| {
            patterns
                .iter()
                .any(|pattern| value_reflects_secret(value, pattern.as_slice()))
        });
    if reflected {
        return Err(RecognitionFailure::InvalidResponse);
    }
    Ok(())
}

#[tauri::command]
pub async fn math_provider_configure(
    state: tauri::State<'_, MathRecognitionState>,
    mut request: ProviderConfigurationRequest,
) -> Result<ProviderStatus, MathRecognitionCommandError> {
    let configuration =
        stored_configuration(&mut request).map_err(MathRecognitionCommandError::from)?;
    let status = ProviderStatus {
        provider: configuration.kind(),
        configured: true,
        network_scope: configuration.network_scope(),
    };
    state
        .vault
        .save(&configuration)
        .map_err(MathRecognitionCommandError::from)?;
    Ok(status)
}

#[tauri::command]
pub async fn math_provider_status(
    state: tauri::State<'_, MathRecognitionState>,
    provider: RecognitionProviderKind,
) -> Result<ProviderStatus, MathRecognitionCommandError> {
    let configuration = state
        .vault
        .load(provider)
        .map_err(MathRecognitionCommandError::from)?;
    Ok(ProviderStatus {
        provider,
        configured: configuration.is_some(),
        network_scope: configuration
            .as_ref()
            .map(StoredProviderConfiguration::network_scope)
            .unwrap_or(match provider {
                RecognitionProviderKind::Compatible => RecognitionNetworkScope::Private,
                RecognitionProviderKind::Mathpix => RecognitionNetworkScope::Public,
            }),
    })
}

#[tauri::command]
pub async fn math_provider_delete(
    state: tauri::State<'_, MathRecognitionState>,
    provider: RecognitionProviderKind,
) -> Result<(), MathRecognitionCommandError> {
    state
        .vault
        .delete(provider)
        .map_err(MathRecognitionCommandError::from)
}

#[tauri::command]
pub async fn math_recognition_cancel(
    state: tauri::State<'_, MathRecognitionState>,
    request: RecognitionCancellationRequest,
) -> Result<bool, MathRecognitionCommandError> {
    let binding = RecognitionBinding::from(request);
    state
        .in_flight
        .cancel(&binding)
        .map_err(MathRecognitionCommandError::from)
}

#[tauri::command]
pub async fn math_recognize(
    state: tauri::State<'_, MathRecognitionState>,
    request: RecognitionRequest,
) -> Result<RecognitionResult, MathRecognitionCommandError> {
    validate_request(&request).map_err(MathRecognitionCommandError::from)?;
    let binding = RecognitionBinding {
        request_id: request.request_id.clone(),
        revision_sha256: request.revision_sha256.clone(),
    };
    let deferred_abort = Arc::new(DeferredAbort::default());
    let cancellation = Arc::clone(&deferred_abort);
    let registration = state
        .in_flight
        .register(binding, Arc::new(move || cancellation.request()))
        .map_err(MathRecognitionCommandError::from)?;
    let configuration = state
        .vault
        .load(request.provider)
        .map_err(MathRecognitionCommandError::from)?
        .ok_or_else(|| {
            MathRecognitionCommandError::from(RecognitionFailure::ProviderUnavailable)
        })?;
    let mut prepared = prepare_provider_request(&configuration, &request)
        .map_err(MathRecognitionCommandError::from)?;
    if deferred_abort.is_requested() {
        return Err(MathRecognitionCommandError::from(
            RecognitionFailure::Aborted,
        ));
    }
    let started = Instant::now();
    let task =
        tauri::async_runtime::spawn(async move { send_provider_request(&mut prepared).await });
    let abort_handle = task.inner().abort_handle();
    deferred_abort.bind(Arc::new(move || abort_handle.abort()));
    let bytes = match task.await {
        Ok(result) => result.map_err(MathRecognitionCommandError::from),
        Err(tauri::Error::JoinError(error)) if error.is_cancelled() => Err(
            MathRecognitionCommandError::from(RecognitionFailure::Aborted),
        ),
        Err(_) => Err(MathRecognitionCommandError::from(
            RecognitionFailure::Network,
        )),
    }?;
    drop(registration);
    let result = parse_provider_response(
        request.provider,
        bytes.as_slice(),
        request.request_id,
        request.revision_sha256,
        started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    )
    .map_err(MathRecognitionCommandError::from)?;
    reject_credential_reflection(&result, &configuration)
        .map_err(MathRecognitionCommandError::from)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Read,
        net::TcpListener,
        sync::{
            atomic::{AtomicUsize, Ordering as AtomicOrdering},
            mpsc,
        },
        thread,
    };

    fn request(provider: RecognitionProviderKind) -> RecognitionRequest {
        RecognitionRequest {
            protocol_version: PROTOCOL_VERSION,
            selection_kind: "explicitMathSelection".to_owned(),
            trigger: "explicitUserSelection".to_owned(),
            user_initiated: true,
            provider,
            operation_id: "operation_1234567890".to_owned(),
            request_id: "request_1234567890".to_owned(),
            revision_sha256: "a".repeat(64),
            strokes: vec![NormalizedStroke {
                points: vec![
                    NormalizedPoint {
                        x: 0.0,
                        y: 0.0,
                        pressure: None,
                    },
                    NormalizedPoint {
                        x: 1.0,
                        y: 1.0,
                        pressure: Some(0.5),
                    },
                ],
            }],
            bounding_box: RecognitionBoundingBox {
                width: 200.0,
                height: 100.0,
            },
            locale: "de-CH".to_owned(),
            settings: RecognitionSettings {
                angle_mode: "degree".to_owned(),
                decimal_separator: "comma".to_owned(),
            },
        }
    }

    fn binding(number: usize) -> RecognitionBinding {
        RecognitionBinding {
            request_id: format!("request_{number:016}"),
            revision_sha256: format!("{number:064x}"),
        }
    }

    #[test]
    fn cancellation_registry_is_bounded_isolated_idempotent_and_cleans_up() {
        let registry = Arc::new(InFlightRegistry::default());
        let cancellations = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&cancellations);
        let active = registry
            .register(
                binding(1),
                Arc::new(move || {
                    counter.fetch_add(1, AtomicOrdering::SeqCst);
                }),
            )
            .expect("register active request");

        let mut wrong_revision = binding(1);
        wrong_revision.revision_sha256 = "f".repeat(64);
        assert!(!registry.cancel(&wrong_revision).expect("wrong revision"));
        assert!(!registry.cancel(&binding(2)).expect("wrong request ID"));
        assert_eq!(cancellations.load(AtomicOrdering::SeqCst), 0);
        assert!(registry.cancel(&binding(1)).expect("cancel active"));
        assert!(registry.cancel(&binding(1)).expect("duplicate cancel"));
        assert_eq!(cancellations.load(AtomicOrdering::SeqCst), 1);
        assert_eq!(registry.len(), 1);
        assert_eq!(
            registry.register(binding(1), Arc::new(|| {})).map(|_| ()),
            Err(RecognitionFailure::InvalidInput)
        );

        drop(active);
        assert_eq!(registry.len(), 0);
        assert!(!registry.cancel(&binding(1)).expect("completed no-op"));

        let registrations = (0..MAX_ACTIVE_REQUESTS)
            .map(|index| {
                registry
                    .register(binding(index + 10), Arc::new(|| {}))
                    .expect("bounded registration")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            registry.register(binding(999), Arc::new(|| {})).map(|_| ()),
            Err(RecognitionFailure::ProviderUnavailable)
        );
        drop(registrations);
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn cancellation_requested_before_native_task_binding_aborts_on_bind() {
        let deferred = DeferredAbort::default();
        let cancellations = Arc::new(AtomicUsize::new(0));
        deferred.request();
        let counter = Arc::clone(&cancellations);
        deferred.bind(Arc::new(move || {
            counter.fetch_add(1, AtomicOrdering::SeqCst);
        }));
        assert!(deferred.is_requested());
        assert_eq!(cancellations.load(AtomicOrdering::SeqCst), 1);
    }

    #[test]
    fn cancellation_aborts_delayed_provider_body_and_discards_late_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let address = listener.local_addr().expect("loopback address");
        let (streaming_tx, streaming_rx) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read timeout");
            let mut request_bytes = [0_u8; 4_096];
            let _ = stream.read(&mut request_bytes).expect("read request");
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\n\r\n{\"latex\":",
                )
                .expect("write partial response");
            stream.flush().expect("flush partial response");
            streaming_tx.send(()).expect("signal streaming");
            thread::sleep(Duration::from_millis(750));
            let _ = stream.write_all(b"\"late\"}");
        });

        let registry = Arc::new(InFlightRegistry::default());
        let task_binding = binding(42);
        tauri::async_runtime::block_on(async {
            let mut prepared = PreparedProviderRequest {
                endpoint: Url::parse(&format!(
                    "http://127.0.0.1:{}/v1/math/recognize",
                    address.port()
                ))
                .expect("endpoint"),
                scope: RecognitionNetworkScope::Private,
                headers: vec![("authorization", "Bearer fixture".to_owned())],
                body: Zeroizing::new(br#"{"requestId":"fixture"}"#.to_vec()),
            };
            let task =
                tauri::async_runtime::spawn(
                    async move { send_provider_request(&mut prepared).await },
                );
            let abort_handle = task.inner().abort_handle();
            let registration = registry
                .register(task_binding.clone(), Arc::new(move || abort_handle.abort()))
                .expect("register HTTP request");
            streaming_rx
                .recv_timeout(Duration::from_secs(3))
                .expect("provider began streaming");
            let cancelled_at = Instant::now();
            assert!(registry.cancel(&task_binding).expect("cancel HTTP request"));
            let result = task.await;
            assert!(matches!(
                result,
                Err(tauri::Error::JoinError(error)) if error.is_cancelled()
            ));
            assert!(cancelled_at.elapsed() < Duration::from_millis(500));
            drop(registration);
        });
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn compatible_urls_are_exact_and_scope_bound() {
        assert!(validate_compatible_url(
            "https://gpu.example/v1/math/recognize",
            RecognitionNetworkScope::Public,
            false,
        )
        .is_ok());
        assert!(validate_compatible_url(
            "http://100.64.0.1:8080/v1/math/recognize",
            RecognitionNetworkScope::Private,
            true,
        )
        .is_ok());
        assert!(validate_compatible_url(
            "http://[::1]:8080/v1/math/recognize",
            RecognitionNetworkScope::Private,
            true,
        )
        .is_ok());
        for unsafe_url in [
            "file:///v1/math/recognize",
            "https://user:pass@gpu.example/v1/math/recognize",
            "https://gpu.example/v1/math/recognize?redirect=x",
            "https://gpu.example/v1/math/%72ecognize",
            "https://gpu.example/v1/math/recognize#fragment",
            "http://gpu.example/v1/math/recognize",
            "http://169.254.169.254/v1/math/recognize",
        ] {
            assert!(
                validate_compatible_url(unsafe_url, RecognitionNetworkScope::Private, true,)
                    .is_err(),
                "accepted {unsafe_url}"
            );
        }
    }

    #[test]
    fn resolved_addresses_cannot_cross_public_private_or_metadata_boundaries() {
        assert!(validate_resolved_addresses(
            &["100.64.1.2:443".parse().expect("address")],
            RecognitionNetworkScope::Private,
        )
        .is_ok());
        assert!(validate_resolved_addresses(
            &["192.168.1.5:443".parse().expect("address")],
            RecognitionNetworkScope::Private,
        )
        .is_ok());
        assert!(validate_resolved_addresses(
            &["8.8.8.8:443".parse().expect("address")],
            RecognitionNetworkScope::Public,
        )
        .is_ok());
        for addresses in [
            vec!["169.254.169.254:80".parse().expect("address")],
            vec!["127.0.0.1:80".parse().expect("address")],
            vec!["[::ffff:169.254.169.254]:80".parse().expect("address")],
            vec![
                "8.8.8.8:443".parse().expect("address"),
                "192.168.1.1:443".parse().expect("address"),
            ],
        ] {
            assert!(
                validate_resolved_addresses(&addresses, RecognitionNetworkScope::Public).is_err()
            );
        }
    }

    #[test]
    fn request_validation_enforces_normalized_finite_bounded_selected_ink() {
        assert!(validate_request(&request(RecognitionProviderKind::Compatible)).is_ok());
        let mut invalid = request(RecognitionProviderKind::Compatible);
        invalid.strokes[0].points[0].x = -0.01;
        assert_eq!(
            validate_request(&invalid),
            Err(RecognitionFailure::InvalidInput)
        );
        let mut restored = request(RecognitionProviderKind::Compatible);
        restored.user_initiated = false;
        assert_eq!(
            validate_request(&restored),
            Err(RecognitionFailure::InvalidInput)
        );
        let mut oversized = request(RecognitionProviderKind::Compatible);
        oversized.strokes[0].points = (0..=MAX_POINTS_PER_STROKE)
            .map(|_| NormalizedPoint {
                x: 0.0,
                y: 0.0,
                pressure: None,
            })
            .collect();
        assert_eq!(
            validate_request(&oversized),
            Err(RecognitionFailure::PayloadTooLarge)
        );
    }

    #[test]
    fn adapters_emit_only_selected_payload_and_mathpix_privacy_opt_out() {
        let compatible = StoredProviderConfiguration::Compatible {
            endpoint: "https://gpu.example/v1/math/recognize".to_owned(),
            network_scope: RecognitionNetworkScope::Public,
            allow_insecure_private_http: false,
            bearer_token: "fixture-token".to_owned(),
        };
        let prepared =
            prepare_provider_request(&compatible, &request(RecognitionProviderKind::Compatible))
                .expect("compatible request");
        let body = String::from_utf8(prepared.body.to_vec()).expect("utf8");
        assert!(body.contains("\"requestId\":\"request_1234567890\""));
        assert!(!body.contains("operation"));
        assert!(!body.contains("revision"));
        assert!(!body.contains("notebook"));

        let mathpix = StoredProviderConfiguration::Mathpix {
            app_id: "fixture-id".to_owned(),
            app_key: "fixture-key".to_owned(),
        };
        let prepared =
            prepare_provider_request(&mathpix, &request(RecognitionProviderKind::Mathpix))
                .expect("mathpix request");
        let body: serde_json::Value = serde_json::from_slice(&prepared.body).expect("json");
        assert_eq!(body["metadata"]["improve_mathpix"], false);
        assert_eq!(body["strokes"]["strokes"]["x"][0][1], 200.0);
        assert_eq!(prepared.endpoint.as_str(), MATHPIX_ENDPOINT);
    }

    #[test]
    fn provider_responses_are_bounded_strict_and_never_use_html() {
        let compatible = br#"{
            "latex":"x^2","candidates":[{"latex":"x^{2}","confidence":0.8}],
            "modelVersion":"fixture","apiVersion":"v1","processingDurationMs":12,
            "warnings":["ambiguous"]
        }"#;
        let result = parse_provider_response(
            RecognitionProviderKind::Compatible,
            compatible,
            "request_1234567890".to_owned(),
            "a".repeat(64),
            20,
        )
        .expect("response");
        assert_eq!(result.latex, "x^2");
        let mathpix = br#"{
            "latex_styled":"\\( 3 x^{2} \\)","confidence":1,
            "is_handwritten":true,"version":"SuperNet","html":"<script>bad()</script>"
        }"#;
        let result = parse_provider_response(
            RecognitionProviderKind::Mathpix,
            mathpix,
            "request_1234567890".to_owned(),
            "a".repeat(64),
            20,
        )
        .expect("response");
        assert_eq!(result.latex, "3 x^{2}");
        assert!(!serde_json::to_string(&result)
            .expect("json")
            .contains("script"));
        assert!(parse_provider_response(
            RecognitionProviderKind::Compatible,
            br#"{"latex":"x","unexpected":"value"}"#,
            "request_1234567890".to_owned(),
            "a".repeat(64),
            20,
        )
        .is_err());
    }

    #[test]
    fn provider_responses_reject_raw_and_base64_credential_echoes() {
        let compatible = StoredProviderConfiguration::Compatible {
            endpoint: "https://gpu.example/v1/math/recognize".to_owned(),
            network_scope: RecognitionNetworkScope::Public,
            allow_insecure_private_http: false,
            bearer_token: "fixture-token-123".to_owned(),
        };
        let safe = || {
            parse_provider_response(
                RecognitionProviderKind::Compatible,
                br#"{"latex":"x^2","candidates":[],"warnings":[],"modelVersion":"safe","apiVersion":"v1"}"#,
                "request_1234567890".to_owned(),
                "a".repeat(64),
                20,
            )
            .expect("safe response")
        };
        assert!(reject_credential_reflection(&safe(), &compatible).is_ok());

        let mut raw_latex = safe();
        raw_latex.latex = "prefix-fixture-token-123-suffix".to_owned();
        assert_eq!(
            reject_credential_reflection(&raw_latex, &compatible),
            Err(RecognitionFailure::InvalidResponse)
        );

        let encoded = BASE64_STANDARD.encode("fixture-token-123");
        let mut encoded_candidate = safe();
        encoded_candidate.candidates.push(RecognitionCandidate {
            latex: format!("x+{encoded}"),
            confidence: None,
        });
        assert_eq!(
            reject_credential_reflection(&encoded_candidate, &compatible),
            Err(RecognitionFailure::InvalidResponse)
        );

        let mut reflected_metadata = safe();
        reflected_metadata.warnings = vec!["fixture-token-123".to_owned()];
        assert!(reject_credential_reflection(&reflected_metadata, &compatible).is_err());
        reflected_metadata.warnings.clear();
        reflected_metadata.model_version = Some(format!("model-{encoded}"));
        assert!(reject_credential_reflection(&reflected_metadata, &compatible).is_err());
        reflected_metadata.model_version = None;
        reflected_metadata.api_version = Some("fixture-token-123".to_owned());
        assert!(reject_credential_reflection(&reflected_metadata, &compatible).is_err());

        let mathpix = StoredProviderConfiguration::Mathpix {
            app_id: "mathpix-app-123".to_owned(),
            app_key: "mathpix-key-456".to_owned(),
        };
        let mut mathpix_result = safe();
        mathpix_result.provider = RecognitionProviderKind::Mathpix;
        mathpix_result.model_version = Some("model-mathpix-app-123".to_owned());
        assert!(reject_credential_reflection(&mathpix_result, &mathpix).is_err());
        mathpix_result.model_version = None;
        mathpix_result.latex = BASE64_STANDARD.encode("mathpix-key-456");
        assert!(reject_credential_reflection(&mathpix_result, &mathpix).is_err());
    }

    #[test]
    fn short_credentials_reject_exact_echo_without_substring_false_positives() {
        let configuration = StoredProviderConfiguration::Compatible {
            endpoint: "https://gpu.example/v1/math/recognize".to_owned(),
            network_scope: RecognitionNetworkScope::Public,
            allow_insecure_private_http: false,
            bearer_token: "short".to_owned(),
        };
        let mut result = parse_provider_response(
            RecognitionProviderKind::Compatible,
            br#"{"latex":"short","candidates":[],"warnings":[]}"#,
            "request_1234567890".to_owned(),
            "a".repeat(64),
            20,
        )
        .expect("short response");
        assert!(reject_credential_reflection(&result, &configuration).is_err());
        result.latex = "shortening".to_owned();
        assert!(reject_credential_reflection(&result, &configuration).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn vault_is_dpapi_protected_domain_separated_and_atomically_replaceable() {
        let directory = std::env::temp_dir().join(format!(
            "canvink-math-vault-{}-{}",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let vault = ProviderVault::new(directory.clone());
        let first = StoredProviderConfiguration::Compatible {
            endpoint: "https://gpu.example/v1/math/recognize".to_owned(),
            network_scope: RecognitionNetworkScope::Public,
            allow_insecure_private_http: false,
            bearer_token: "SECRET-FIRST".to_owned(),
        };
        vault.save(&first).expect("save first");
        let stored = fs::read(vault.path(RecognitionProviderKind::Compatible)).expect("read vault");
        assert!(!stored
            .windows("SECRET-FIRST".len())
            .any(|window| window == b"SECRET-FIRST"));
        let loaded = vault
            .load(RecognitionProviderKind::Compatible)
            .expect("load")
            .expect("configured");
        assert_eq!(loaded.kind(), RecognitionProviderKind::Compatible);
        let vault_path = vault.path(RecognitionProviderKind::Compatible);
        let mut tampered = fs::read(&vault_path).expect("read for tamper");
        *tampered.last_mut().expect("non-empty vault") ^= 0x80;
        fs::write(&vault_path, tampered).expect("write tamper");
        assert_eq!(
            vault.load(RecognitionProviderKind::Compatible).map(|_| ()),
            Err(RecognitionFailure::SecretUnavailable)
        );

        let mut plaintext = Zeroizing::new(b"domain-separated".to_vec());
        let mut wrong = crypt_protect(&mut plaintext, b"Canvink|DPAPI|notebook-key-material|v1")
            .expect("wrong-domain protection");
        assert_eq!(
            unprotect_provider_bytes(&mut wrong),
            Err(RecognitionFailure::SecretUnavailable)
        );

        let second = StoredProviderConfiguration::Compatible {
            endpoint: "https://gpu.example/v1/math/recognize".to_owned(),
            network_scope: RecognitionNetworkScope::Public,
            allow_insecure_private_http: false,
            bearer_token: "SECRET-SECOND".to_owned(),
        };
        vault.save(&second).expect("replace");
        vault
            .delete(RecognitionProviderKind::Compatible)
            .expect("delete");
        assert!(vault
            .load(RecognitionProviderKind::Compatible)
            .expect("load empty")
            .is_none());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn command_errors_are_content_free() {
        let serialized = serde_json::to_string(&MathRecognitionCommandError::from(
            RecognitionFailure::Network,
        ))
        .expect("error serializes");
        assert!(!serialized.contains("endpoint"));
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("latex"));
        assert!(!serialized.contains("stroke"));
    }
}
