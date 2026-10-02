use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use serde::Deserialize;
use url::Url;

use crate::CommandError;

const MAX_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;
const MIN_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 5 * 60 * 1_000;

static OPERATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OneNoteSystemBrowserRequest {
    operation_id: String,
    authorization_url: String,
    redirect_uri: String,
    timeout_ms: u64,
}

fn error(message: impl Into<String>) -> CommandError {
    CommandError::onenote(message.into())
}

fn validate_operation_id(value: &str) -> Result<(), CommandError> {
    if value.len() < 16
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(error("OneNote authorization operation ID is invalid."));
    }
    Ok(())
}

fn validate_microsoft_url(value: &str, endpoint: &str) -> Result<Url, CommandError> {
    let parsed = Url::parse(value).map_err(|_| error("Microsoft authorization URL is invalid."))?;
    let segments = parsed
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("login.microsoftonline.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || segments.len() != 4
        || segments[1] != "oauth2"
        || segments[2] != "v2.0"
        || segments[3] != endpoint
        || !matches!(segments[0], "common" | "organizations" | "consumers")
            && !(segments[0].len() == 36
                && segments[0]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() || byte == b'-'))
    {
        return Err(error(
            "Only Microsoft OAuth system-browser URLs are allowed.",
        ));
    }
    Ok(parsed)
}

fn validate_authorization_url(value: &str, redirect_uri: &str) -> Result<Url, CommandError> {
    let parsed = validate_microsoft_url(value, "authorize")?;
    let parameters = parsed.query_pairs().collect::<HashMap<_, _>>();
    let scopes = parameters
        .get("scope")
        .map(|value| value.split_whitespace().collect::<Vec<_>>())
        .unwrap_or_default();
    if parameters.get("response_type").map(|value| value.as_ref()) != Some("code")
        || parameters
            .get("code_challenge_method")
            .map(|value| value.as_ref())
            != Some("S256")
        || parameters
            .get("code_challenge")
            .is_none_or(|value| value.len() < 43)
        || parameters.get("state").is_none_or(|value| value.is_empty())
        || parameters.get("nonce").is_none_or(|value| value.is_empty())
        || parameters.get("redirect_uri").map(|value| value.as_ref()) != Some(redirect_uri)
        || !scopes
            .iter()
            .any(|scope| scope.eq_ignore_ascii_case("Notes.Read"))
        || scopes.iter().any(|scope| {
            scope.eq_ignore_ascii_case("Notes.ReadWrite")
                || scope.eq_ignore_ascii_case("Notes.ReadWrite.All")
        })
    {
        return Err(error("Microsoft authorization parameters are invalid."));
    }
    Ok(parsed)
}

fn validate_redirect_uri(value: &str) -> Result<(Url, SocketAddr), CommandError> {
    let parsed =
        Url::parse(value).map_err(|_| error("OneNote loopback redirect URI is invalid."))?;
    let port = parsed
        .port()
        .ok_or_else(|| error("OneNote loopback redirect URI requires an explicit port."))?;
    let address = match parsed.host_str() {
        Some("127.0.0.1" | "localhost") => SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        Some("[::1]" | "::1") => SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
        _ => return Err(error("OneNote redirect URI must use a loopback host.")),
    };
    if parsed.scheme() != "http"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path().is_empty()
        || parsed.path() == "/"
    {
        return Err(error(
            "OneNote loopback redirect URI is not strictly scoped.",
        ));
    }
    Ok((parsed, address))
}

pub(crate) fn open_system_browser(url: &str) -> Result<(), CommandError> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler").arg(url);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|_| error("The system browser could not be opened."))
}

fn read_request(stream: &mut TcpStream) -> Result<Vec<u8>, CommandError> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| error("The OneNote callback read timeout could not be configured."))?;
    let mut request = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                request.extend_from_slice(&chunk[..read]);
                if request.len() > MAX_CALLBACK_REQUEST_BYTES {
                    return Err(error(
                        "The OneNote callback request exceeded its byte limit.",
                    ));
                }
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Err(read_error)
                if matches!(
                    read_error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut
                ) =>
            {
                return Err(error("The OneNote callback request timed out."));
            }
            Err(_) => return Err(error("The OneNote callback request could not be read.")),
        }
    }
    Ok(request)
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn accept_callback(
    listener: TcpListener,
    redirect: &Url,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<String, CommandError> {
    listener
        .set_nonblocking(true)
        .map_err(|_| error("The OneNote loopback listener could not be configured."))?;
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cancelled.load(Ordering::Acquire) {
            return Err(error("The OneNote authorization was cancelled."));
        }
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if !peer.ip().is_loopback() {
                    respond(&mut stream, "403 Forbidden", "Loopback requests only.");
                    continue;
                }
                let request = match read_request(&mut stream) {
                    Ok(request) => request,
                    Err(_) => {
                        respond(&mut stream, "400 Bad Request", "Invalid callback request.");
                        continue;
                    }
                };
                let request = match std::str::from_utf8(&request) {
                    Ok(request) => request,
                    Err(_) => {
                        respond(&mut stream, "400 Bad Request", "Invalid callback request.");
                        continue;
                    }
                };
                let mut lines = request.split("\r\n");
                let request_line = lines.next().unwrap_or_default();
                let mut request_parts = request_line.split_whitespace();
                let method = request_parts.next();
                let target = request_parts.next();
                let version = request_parts.next();
                if method != Some("GET")
                    || !matches!(version, Some("HTTP/1.0" | "HTTP/1.1"))
                    || request_parts.next().is_some()
                {
                    respond(
                        &mut stream,
                        "405 Method Not Allowed",
                        "Invalid callback request.",
                    );
                    continue;
                }
                let expected_authority = redirect
                    [url::Position::BeforeHost..url::Position::AfterPort]
                    .to_ascii_lowercase();
                let host = lines.find_map(|line| {
                    line.split_once(':').and_then(|(name, value)| {
                        name.eq_ignore_ascii_case("host")
                            .then(|| value.trim().to_ascii_lowercase())
                    })
                });
                let target = target.unwrap_or_default();
                let callback = match Url::parse(&format!("http://{expected_authority}{target}")) {
                    Ok(callback) => callback,
                    Err(_) => {
                        respond(&mut stream, "400 Bad Request", "Invalid callback request.");
                        continue;
                    }
                };
                let parameters = callback.query_pairs().collect::<HashMap<_, _>>();
                if host.as_deref() != Some(expected_authority.as_str())
                    || callback.path() != redirect.path()
                    || callback.fragment().is_some()
                    || parameters.get("state").is_none_or(|value| value.is_empty())
                    || (!parameters.contains_key("code") && !parameters.contains_key("error"))
                {
                    respond(
                        &mut stream,
                        "404 Not Found",
                        "This is not the expected callback.",
                    );
                    continue;
                }
                respond(
                    &mut stream,
                    "200 OK",
                    "Authorization received. You can close this tab and return to Canvink.",
                );
                return Ok(format!("?{}", callback.query().unwrap_or_default()));
            }
            Err(accept_error) if accept_error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return Err(error("The OneNote loopback callback failed.")),
        }
    }
    Err(error("The OneNote authorization callback timed out."))
}

#[tauri::command]
pub async fn onenote_system_browser_authorize(
    request: OneNoteSystemBrowserRequest,
) -> Result<String, CommandError> {
    validate_operation_id(&request.operation_id)?;
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms) {
        return Err(error(
            "OneNote authorization timeout is outside the allowed range.",
        ));
    }
    let (redirect, address) = validate_redirect_uri(&request.redirect_uri)?;
    let authorization =
        validate_authorization_url(&request.authorization_url, &request.redirect_uri)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut operations = OPERATIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| error("OneNote authorization state is unavailable."))?;
        if operations.contains_key(&request.operation_id) {
            return Err(error("OneNote authorization operation is already active."));
        }
        operations.insert(request.operation_id.clone(), Arc::clone(&cancelled));
    }
    let operation_id = request.operation_id;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind(address).map_err(|_| {
            error("The registered OneNote loopback callback address is unavailable.")
        })?;
        open_system_browser(authorization.as_str())?;
        accept_callback(
            listener,
            &redirect,
            &cancelled,
            Duration::from_millis(request.timeout_ms),
        )
    })
    .await
    .unwrap_or_else(|join_error| {
        Err(error(format!(
            "OneNote authorization task failed: {join_error}"
        )))
    });
    if let Ok(mut operations) = OPERATIONS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        operations.remove(&operation_id);
    }
    result
}

#[tauri::command]
pub fn onenote_cancel_system_browser_authorization(
    operation_id: String,
) -> Result<(), CommandError> {
    validate_operation_id(&operation_id)?;
    let operations = OPERATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| error("OneNote authorization state is unavailable."))?;
    if let Some(cancelled) = operations.get(&operation_id) {
        cancelled.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
pub fn onenote_open_system_browser_logout(logout_url: String) -> Result<(), CommandError> {
    let logout = validate_microsoft_url(&logout_url, "logout")?;
    open_system_browser(logout.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_exact_loopback_redirect_and_read_only_pkce_authorize_url() {
        let redirect = "http://127.0.0.1:49152/onenote/callback";
        let authorize = format!(
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code&code_challenge_method=S256&code_challenge={}&state=s&nonce=n&scope=Notes.Read&redirect_uri={}",
            "a".repeat(43),
            url::form_urlencoded::byte_serialize(redirect.as_bytes()).collect::<String>(),
        );
        assert!(validate_redirect_uri(redirect).is_ok());
        assert!(validate_authorization_url(&authorize, redirect).is_ok());
        assert!(validate_redirect_uri("http://0.0.0.0:49152/onenote/callback").is_err());
        assert!(validate_redirect_uri("http://127.0.0.1/onenote/callback").is_err());
        assert!(validate_authorization_url(
            &authorize.replace("Notes.Read", "Notes.ReadWrite"),
            redirect
        )
        .is_err());
        assert!(validate_authorization_url(
            &authorize.replace("/authorize?", "/logout?"),
            redirect
        )
        .is_err());
    }
}
