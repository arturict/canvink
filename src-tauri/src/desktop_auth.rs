//! Desktop sign-in through the system browser
//! (services/collab-sync/PERSONAL-SYNC.md §3.7).
//!
//! Clerk never runs inside the app. This module creates the PKCE verifier and
//! `state`, opens `<login>/desktop-login` in the default browser, receives
//! `canvink://auth?code=…&state=…` from the deep-link plugin (or a pasted
//! code), exchanges code and verifier at the sync Worker and keeps the device
//! credential. The WebView only ever sees short-lived access tokens: the
//! verifier, `state` and the refresh token stay on the Rust side.
//!
//! Storage: the refresh token is written to the app data directory. On
//! Windows it is sealed with current-user DPAPI (the same mechanism Windows
//! Credential Manager uses underneath), with its own entropy label, so another
//! Windows account or a copied disk cannot read it. Elsewhere the file is
//! created with mode 0600.

use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use url::Url;
use zeroize::{Zeroize, Zeroizing};

/// Sync Worker and web origin, fixed at build time by `build.rs` from
/// `.env.desktop` (or `.env.desktop.local`, or the process environment). They
/// are compiled in so web content can never redirect a refresh token.
const SYNC_URL: &str = env!("CANVINK_SYNC_URL");
const LOGIN_URL: &str = env!("CANVINK_LOGIN_URL");

/// How long a started sign-in waits for the browser.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// Refresh an access token this long before it expires.
const REFRESH_MARGIN_SECS: u64 = 60;
/// Hand out a cached access token only this long after it was issued. A
/// device signed out on the web is refused by the Worker at once, but the app
/// only learns it on its next refresh; callers ask again after a refused
/// connection, so this bounds how long the app keeps retrying a dead token.
const ACCESS_REUSE_SECS: u64 = 60;
const CREDENTIAL_FILE: &str = "desktop-credential.bin";
#[cfg(windows)]
const DPAPI_LABEL: &[u8] = b"Canvink|DPAPI|desktop-device-credential|v1";

/// Emitted to the WebView with a [`DesktopAuthStatus`] whenever it changes.
pub const CHANGED_EVENT: &str = "desktop-auth://changed";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUser {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    picture: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredCredential {
    refresh_token: String,
    device_id: String,
    user: DesktopUser,
}

impl Drop for StoredCredential {
    fn drop(&mut self) {
        self.refresh_token.zeroize();
    }
}

struct Pending {
    verifier: Zeroizing<String>,
    state: String,
    started: Instant,
}

struct AccessToken {
    token: Zeroizing<String>,
    issued_at: u64,
    expires_at: u64,
}

impl AccessToken {
    fn new(token: String, expires_in: u64) -> Self {
        let now = now_secs();
        Self {
            token: Zeroizing::new(token),
            issued_at: now,
            expires_at: now + expires_in,
        }
    }

    fn reusable(&self, now: u64) -> bool {
        self.expires_at > now + REFRESH_MARGIN_SECS && now < self.issued_at + ACCESS_REUSE_SECS
    }
}

#[derive(Default)]
struct Session {
    loaded: bool,
    credential: Option<StoredCredential>,
    access: Option<AccessToken>,
}

/// Why the last sign-in attempt stopped, for the app's sign-in dialog.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginError {
    Failed,
    Expired,
    BrowserFailed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthStatus {
    configured: bool,
    signed_in: bool,
    user: Option<DesktopUser>,
    /// The browser was opened and the app waits for its answer.
    pending: bool,
    error: Option<LoginError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAccessToken {
    token: String,
    expires_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAuthError {
    code: &'static str,
}

impl DesktopAuthError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }
}

#[derive(Default)]
pub struct DesktopAuthState {
    pending: Mutex<Option<Pending>>,
    error: Mutex<Option<LoginError>>,
    /// Async so one exchange or refresh runs at a time: the Worker rotates the
    /// refresh token on every use.
    session: tauri::async_runtime::Mutex<Session>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: String,
    device_id: String,
    user: DesktopUser,
}

// ---- pure helpers ---------------------------------------------------------

fn random_token() -> String {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut()).expect("the operating system provides randomness");
    URL_SAFE_NO_PAD.encode(bytes.as_ref())
}

/// RFC 7636 §4.2, S256.
pub(crate) fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// A configured origin: https, or plain http to this machine for local tests.
pub(crate) fn configured_origin(raw: &str) -> Option<Url> {
    let url = Url::parse(raw.trim()).ok()?;
    let local = matches!(url.host_str(), Some("localhost") | Some("127.0.0.1"));
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && local);
    (allowed && url.username().is_empty() && url.password().is_none()).then_some(url)
}

pub(crate) fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    let prefix = url.path().trim_end_matches('/').to_owned();
    url.set_path(&format!("{prefix}{path}"));
    url.set_query(None);
    url
}

pub(crate) fn login_page_url(base: &Url, challenge: &str, state: &str) -> Url {
    let mut url = endpoint(base, "/desktop-login");
    url.query_pairs_mut()
        .append_pair("challenge", challenge)
        .append_pair("state", state);
    // Only changes the page's wording ("Canvink Android"); the flow is the same.
    #[cfg(target_os = "android")]
    url.query_pairs_mut().append_pair("platform", "android");
    url
}

/// `canvink://auth?code=…&state=…` → (code, state).
pub(crate) fn parse_callback(url: &Url) -> Option<(String, Option<String>)> {
    if url.scheme() != "canvink" || url.host_str() != Some("auth") {
        return None;
    }
    let mut code = None;
    let mut state = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            _ => {}
        }
    }
    code.filter(|value| is_code(value))
        .map(|code| (code, state))
}

/// `<spaceId 22>.<secret 43>`, base64url.
pub(crate) fn is_code(value: &str) -> bool {
    let Some((space, secret)) = value.split_once('.') else {
        return false;
    };
    let b64 = |s: &str| {
        s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    space.len() == 22 && secret.len() == 43 && b64(space) && b64(secret)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The computer's name, or empty when the system has none (a phone): the
/// account page then names the device by platform and app version instead of
/// repeating a generic label.
fn device_label() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|value| value.trim().chars().take(40).collect::<String>())
        .unwrap_or_default()
}

fn merge_client_info(request: &mut serde_json::Value, install_id: &str) {
    if let (Some(target), serde_json::Value::Object(info)) =
        (request.as_object_mut(), client_info(install_id))
    {
        target.extend(info);
    }
}

/// What the Worker lists next to the name: the platform and the app version.
fn client_info(install_id: &str) -> serde_json::Value {
    serde_json::json!({
        "install_id": install_id,
        "platform": std::env::consts::OS,
        "app_version": env!("CARGO_PKG_VERSION"),
    })
}

const INSTALL_ID_FILE: &str = "desktop-install-id";

/// A random id that outlives sign-ins and sign-outs, so the Worker can tell
/// that a new sign-in is the same installation and replace its old device
/// entry instead of listing another one. It is not a secret and is stored
/// apart from the credential, which a sign-out deletes.
fn install_id<R: Runtime>(app: &AppHandle<R>) -> String {
    let path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("canvink").join(INSTALL_ID_FILE));
    if let Some(existing) = path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| (16..=64).contains(&value.len()))
    {
        return existing;
    }
    let id = random_token();
    if let Some(path) = path {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, &id);
    }
    id
}

// ---- storage --------------------------------------------------------------

fn credential_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("canvink").join(CREDENTIAL_FILE))
}

fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    #[cfg(windows)]
    {
        crate::key_protection::protect_for(DPAPI_LABEL, plain)
    }
    #[cfg(not(windows))]
    {
        Some(plain.to_vec())
    }
}

fn open(sealed: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    #[cfg(windows)]
    {
        crate::key_protection::unprotect_for(DPAPI_LABEL, sealed)
    }
    #[cfg(not(windows))]
    {
        Some(Zeroizing::new(sealed.to_vec()))
    }
}

fn write_private(path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

fn load_credential<R: Runtime>(app: &AppHandle<R>) -> Option<StoredCredential> {
    let path = credential_path(app)?;
    let sealed = std::fs::read(&path).ok()?;
    let credential = open(&sealed).and_then(|plain| serde_json::from_slice(&plain).ok());
    if credential.is_none() {
        // Unreadable (another Windows account, corruption): sign in again.
        let _ = std::fs::remove_file(&path);
    }
    credential
}

fn save_credential<R: Runtime>(app: &AppHandle<R>, credential: &StoredCredential) -> bool {
    let Some(path) = credential_path(app) else {
        return false;
    };
    let Ok(plain) = serde_json::to_vec(credential).map(Zeroizing::new) else {
        return false;
    };
    seal(&plain).is_some_and(|sealed| write_private(&path, &sealed).is_ok())
}

fn delete_credential<R: Runtime>(app: &AppHandle<R>) {
    if let Some(path) = credential_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

// ---- state ----------------------------------------------------------------

fn sync_origin() -> Option<Url> {
    configured_origin(SYNC_URL)
}

pub(crate) fn login_origin() -> Option<Url> {
    configured_origin(LOGIN_URL)
}

fn http_client() -> Result<reqwest::Client, DesktopAuthError> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("Canvink-Desktop-Sign-In/1")
        .build()
        .map_err(|_| DesktopAuthError::new("offline"))
}

fn set_error<R: Runtime>(app: &AppHandle<R>, error: Option<LoginError>) {
    *app.state::<DesktopAuthState>().error.lock().unwrap() = error;
}

async fn status<R: Runtime>(app: &AppHandle<R>) -> DesktopAuthStatus {
    let state = app.state::<DesktopAuthState>();
    let mut session = state.session.lock().await;
    ensure_loaded(app, &mut session);
    let pending = state
        .pending
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|p| p.started.elapsed() < PENDING_TTL);
    let error = *state.error.lock().unwrap();
    DesktopAuthStatus {
        configured: sync_origin().is_some() && login_origin().is_some(),
        signed_in: session.credential.is_some(),
        user: session.credential.as_ref().map(|c| c.user.clone()),
        pending,
        error,
    }
}

fn ensure_loaded<R: Runtime>(app: &AppHandle<R>, session: &mut Session) {
    if !session.loaded {
        session.credential = load_credential(app);
        session.loaded = true;
    }
}

async fn emit_status<R: Runtime>(app: &AppHandle<R>) {
    let status = status(app).await;
    let _ = app.emit(CHANGED_EVENT, status);
}

enum GrantError {
    /// The Worker refused the grant: the code or refresh token is spent.
    Rejected,
    /// No answer; try again later.
    Offline,
}

async fn token_request(body: serde_json::Value) -> Result<TokenResponse, GrantError> {
    let base = sync_origin().ok_or(GrantError::Offline)?;
    let client = http_client().map_err(|_| GrantError::Offline)?;
    let response = client
        .post(endpoint(&base, "/api/v1/device/token"))
        .json(&body)
        .send()
        .await
        .map_err(|_| GrantError::Offline)?;
    // The Worker rate-limits by address (429): that is a pause. Treating it as
    // a refusal deleted the credential, so the next sign-in added a second
    // device while the first stayed in the account's list.
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(GrantError::Offline);
    }
    if response.status().is_client_error() {
        return Err(GrantError::Rejected);
    }
    if !response.status().is_success() {
        return Err(GrantError::Offline);
    }
    response.json().await.map_err(|_| GrantError::Offline)
}

fn store_grant<R: Runtime>(app: &AppHandle<R>, session: &mut Session, grant: TokenResponse) {
    let credential = StoredCredential {
        refresh_token: grant.refresh_token,
        device_id: grant.device_id,
        user: grant.user,
    };
    // Persist the rotated token before anything uses it. If this fails the
    // session still works until the app quits.
    let _ = save_credential(app, &credential);
    session.access = Some(AccessToken::new(grant.access_token, grant.expires_in));
    session.credential = Some(credential);
    session.loaded = true;
}

async fn exchange_code<R: Runtime>(app: &AppHandle<R>, code: String, verifier: Zeroizing<String>) {
    let state = app.state::<DesktopAuthState>();
    let result = {
        let mut session = state.session.lock().await;
        let mut request = serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier.as_str(),
            "device_name": device_label(),
        });
        merge_client_info(&mut request, &install_id(app));
        let response = token_request(request).await;
        match response {
            Ok(grant) => {
                store_grant(app, &mut session, grant);
                None
            }
            Err(_) => Some(LoginError::Failed),
        }
    };
    set_error(app, result);
    // Bring the app back in front of the browser; a phone has no window to
    // unminimize, the system already returned to the app through the deep link.
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    emit_status(app).await;
}

/// Handles `canvink://auth?…` from the deep-link plugin.
pub fn handle_deep_link<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    let Some((code, returned_state)) = parse_callback(url) else {
        return;
    };
    let state = app.state::<DesktopAuthState>();
    let pending = {
        let mut guard = state.pending.lock().unwrap();
        match guard.as_ref() {
            None => None,
            Some(p) if p.started.elapsed() >= PENDING_TTL => {
                guard.take();
                None
            }
            // A link whose state does not match was not started here (or is a
            // forged one): ignore it and keep waiting for the real answer.
            Some(p)
                if !returned_state
                    .as_deref()
                    .is_some_and(|s| constant_time_eq(s, &p.state)) =>
            {
                return;
            }
            Some(_) => guard.take(),
        }
    };
    let app = app.clone();
    match pending {
        Some(pending) => {
            tauri::async_runtime::spawn(async move {
                exchange_code(&app, code, pending.verifier).await;
            });
        }
        None => {
            set_error(&app, Some(LoginError::Expired));
            tauri::async_runtime::spawn(async move { emit_status(&app).await });
        }
    }
}

// ---- commands -------------------------------------------------------------

/// Opens a page outside the app: Google refuses OAuth inside an
/// embedded WebView, so it must be the system browser on every platform.
#[cfg(target_os = "android")]
pub(crate) fn open_in_system_browser<R: Runtime>(app: &AppHandle<R>, url: &str) -> bool {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).is_ok()
}

#[cfg(not(target_os = "android"))]
pub(crate) fn open_in_system_browser<R: Runtime>(_app: &AppHandle<R>, url: &str) -> bool {
    crate::onenote_auth::open_system_browser(url).is_ok()
}

#[tauri::command]
pub async fn desktop_auth_status<R: Runtime>(app: AppHandle<R>) -> DesktopAuthStatus {
    status(&app).await
}

#[tauri::command]
pub async fn desktop_login_start<R: Runtime>(app: AppHandle<R>) -> Result<(), DesktopAuthError> {
    let (Some(login), Some(_)) = (login_origin(), sync_origin()) else {
        return Err(DesktopAuthError::new("notConfigured"));
    };
    let verifier = Zeroizing::new(random_token());
    let state_value = random_token();
    let url = login_page_url(&login, &pkce_challenge(&verifier), &state_value);
    *app.state::<DesktopAuthState>().pending.lock().unwrap() = Some(Pending {
        verifier,
        state: state_value,
        started: Instant::now(),
    });
    let opened = open_in_system_browser(&app, url.as_str());
    if !opened {
        app.state::<DesktopAuthState>()
            .pending
            .lock()
            .unwrap()
            .take();
    }
    set_error(&app, (!opened).then_some(LoginError::BrowserFailed));
    emit_status(&app).await;
    if opened {
        Ok(())
    } else {
        Err(DesktopAuthError::new("browserFailed"))
    }
}

#[tauri::command]
pub async fn desktop_login_cancel<R: Runtime>(app: AppHandle<R>) {
    app.state::<DesktopAuthState>()
        .pending
        .lock()
        .unwrap()
        .take();
    set_error(&app, None);
    emit_status(&app).await;
}

/// The fallback: a code (or the whole `canvink://` link) copied from the page.
#[tauri::command]
pub async fn desktop_login_submit<R: Runtime>(
    app: AppHandle<R>,
    input: String,
) -> Result<(), DesktopAuthError> {
    let input = input.trim();
    if input.starts_with("canvink:") {
        let url = Url::parse(input).map_err(|_| DesktopAuthError::new("invalidCode"))?;
        if parse_callback(&url).is_none() {
            return Err(DesktopAuthError::new("invalidCode"));
        }
        handle_deep_link(&app, &url);
        return Ok(());
    }
    if !is_code(input) {
        return Err(DesktopAuthError::new("invalidCode"));
    }
    // Only this app's verifier can redeem the code (PKCE), so a pasted code
    // needs no state check.
    let pending = app
        .state::<DesktopAuthState>()
        .pending
        .lock()
        .unwrap()
        .take();
    let Some(pending) = pending.filter(|p| p.started.elapsed() < PENDING_TTL) else {
        set_error(&app, Some(LoginError::Expired));
        emit_status(&app).await;
        return Err(DesktopAuthError::new("expired"));
    };
    exchange_code(&app, input.to_owned(), pending.verifier).await;
    Ok(())
}

/// A current access token, refreshed when it is about to expire (or always,
/// with `force`, after the Worker refused a connection). `None` when signed
/// out. A refused refresh (device signed out elsewhere, token reuse) signs
/// this app out.
#[tauri::command]
pub async fn desktop_access_token<R: Runtime>(
    app: AppHandle<R>,
    force: Option<bool>,
) -> Result<Option<DesktopAccessToken>, DesktopAuthError> {
    let state = app.state::<DesktopAuthState>();
    let signed_out = {
        let mut session = state.session.lock().await;
        ensure_loaded(&app, &mut session);
        let Some(credential) = session.credential.as_ref() else {
            return Ok(None);
        };
        let cached = session
            .access
            .as_ref()
            .filter(|a| !force.unwrap_or(false) && a.reusable(now_secs()));
        if let Some(access) = cached {
            return Ok(Some(DesktopAccessToken {
                token: access.token.to_string(),
                expires_at: access.expires_at,
            }));
        }
        let response = token_request(serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": credential.refresh_token.as_str(),
            // An update of the app shows in the account's device list.
            "app_version": env!("CARGO_PKG_VERSION"),
        }))
        .await;
        match response {
            Ok(grant) => {
                store_grant(&app, &mut session, grant);
                let access = session.access.as_ref().expect("just stored");
                return Ok(Some(DesktopAccessToken {
                    token: access.token.to_string(),
                    expires_at: access.expires_at,
                }));
            }
            Err(GrantError::Offline) => return Err(DesktopAuthError::new("offline")),
            Err(GrantError::Rejected) => {
                session.credential = None;
                session.access = None;
                delete_credential(&app);
                true
            }
        }
    };
    if signed_out {
        emit_status(&app).await;
    }
    Ok(None)
}

/// Signs this device out at the Worker (best effort) and forgets the credential.
#[tauri::command]
pub async fn desktop_logout<R: Runtime>(app: AppHandle<R>) {
    let state = app.state::<DesktopAuthState>();
    {
        let mut session = state.session.lock().await;
        ensure_loaded(&app, &mut session);
        if let Some(credential) = session.credential.take() {
            let mut access = session
                .access
                .take()
                .filter(|a| a.expires_at > now_secs() + 5);
            if access.is_none() {
                if let Ok(grant) = token_request(serde_json::json!({
                    "grant_type": "refresh_token",
                    "refresh_token": credential.refresh_token.as_str(),
                }))
                .await
                {
                    access = Some(AccessToken::new(grant.access_token, grant.expires_in));
                }
            }
            if let (Some(access), Some(base), Ok(client)) = (access, sync_origin(), http_client()) {
                let url = endpoint(
                    &base,
                    &format!("/api/v1/me/devices/{}", credential.device_id),
                );
                let _ = client
                    .delete(url)
                    .bearer_auth(access.token.as_str())
                    .send()
                    .await;
            }
        }
        session.loaded = true;
        delete_credential(&app);
    }
    state.pending.lock().unwrap().take();
    set_error(&app, None);
    emit_status(&app).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc_7636_appendix_b() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_tokens_are_43_char_base64url_and_distinct() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'));
    }

    #[test]
    fn parses_only_well_formed_auth_callbacks() {
        let code = format!("{}.{}", "a".repeat(22), "b".repeat(43));
        let url = Url::parse(&format!("canvink://auth?code={code}&state=xyz")).unwrap();
        assert_eq!(
            parse_callback(&url),
            Some((code.clone(), Some("xyz".to_owned())))
        );
        for bad in [
            format!("canvink://other?code={code}&state=xyz"),
            format!("https://auth?code={code}&state=xyz"),
            "canvink://auth?code=short&state=xyz".to_owned(),
            "canvink://auth?state=xyz".to_owned(),
        ] {
            assert_eq!(parse_callback(&Url::parse(&bad).unwrap()), None, "{bad}");
        }
    }

    #[test]
    fn accepts_https_origins_and_local_http_only() {
        assert!(configured_origin("https://canvink.example.com").is_some());
        assert!(configured_origin("http://localhost:5188").is_some());
        assert!(configured_origin("http://127.0.0.1:8791").is_some());
        assert!(configured_origin("http://example.com").is_none());
        assert!(configured_origin("").is_none());
        assert!(configured_origin("https://user:pw@example.com").is_none());
    }

    #[test]
    fn sign_in_carries_the_installation_platform_and_version() {
        let mut body = serde_json::json!({ "grant_type": "authorization_code" });
        merge_client_info(&mut body, "install-id-0123456789");
        assert_eq!(body["grant_type"], "authorization_code");
        assert_eq!(body["install_id"], "install-id-0123456789");
        assert_eq!(body["platform"], std::env::consts::OS);
        assert_eq!(body["app_version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn builds_the_login_page_url() {
        let base = Url::parse("https://canvink.example.com").unwrap();
        assert_eq!(
            login_page_url(&base, "c", "s").as_str(),
            "https://canvink.example.com/desktop-login?challenge=c&state=s"
        );
        let local = Url::parse("http://localhost:5188/").unwrap();
        assert_eq!(
            endpoint(&local, "/api/v1/device/token").as_str(),
            "http://localhost:5188/api/v1/device/token"
        );
    }

    #[test]
    fn cached_access_tokens_are_reused_only_briefly() {
        let token = AccessToken {
            token: Zeroizing::new("t".to_owned()),
            issued_at: 1_000,
            expires_at: 1_600,
        };
        assert!(token.reusable(1_030));
        assert!(!token.reusable(1_000 + ACCESS_REUSE_SECS));
        let nearly_expired = AccessToken {
            issued_at: 1_000,
            expires_at: 1_050,
            ..token
        };
        assert!(!nearly_expired.reusable(1_010));
    }

    #[test]
    fn constant_time_eq_compares_values() {
        assert!(constant_time_eq("state", "state"));
        assert!(!constant_time_eq("state", "stat3"));
        assert!(!constant_time_eq("state", "states"));
    }
}
