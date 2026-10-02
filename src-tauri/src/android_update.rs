//! Update notice of the Android app.
//!
//! Tauri's updater does not support Android, and the app is not in a store, so
//! the web app publishes `/download/android.json` next to the APK. The app
//! compares the published version with its own and, when the published one is
//! newer, offers to open the APK download in the browser, where the system
//! installs it over the old version.
//!
//! The request and the download address are fixed here: neither the WebView
//! nor the JSON can point the app at another server.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use url::Url;

const APK_PATH: &str = "/download/Canvink.apk";
const FEED_PATH: &str = "/download/android.json";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Deserialize)]
struct Feed {
    version: String,
}

#[derive(Debug, Serialize)]
pub struct AndroidUpdate {
    version: String,
}

/// `major.minor.patch` as numbers; anything else is not a release version.
fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let mut parts = raw.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((major, minor, patch))
}

pub(crate) fn is_newer(published: &str, installed: &str) -> bool {
    match (parse_version(published), parse_version(installed)) {
        (Some(published), Some(installed)) => published > installed,
        _ => false,
    }
}

fn site_url(path: &str) -> Option<Url> {
    let origin = crate::desktop_auth::login_origin()?;
    Some(crate::desktop_auth::endpoint(&origin, path))
}

/// The newer published version, or none when the app is current or offline.
#[tauri::command]
pub async fn android_update_check() -> Option<AndroidUpdate> {
    let url = site_url(FEED_PATH)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("Canvink-Android-Update/1")
        .build()
        .ok()?;
    let response = client.get(url).send().await.ok()?.error_for_status().ok()?;
    let feed: Feed = response.json().await.ok()?;
    is_newer(&feed.version, VERSION).then_some(AndroidUpdate {
        version: feed.version,
    })
}

/// Opens the APK download in the system browser.
#[tauri::command]
pub fn android_update_open<R: Runtime>(app: AppHandle<R>) -> bool {
    let Some(url) = site_url(APK_PATH) else {
        return false;
    };
    crate::desktop_auth::open_in_system_browser(&app, url.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_higher_release_version_is_an_update() {
        assert!(is_newer("0.3.2", "0.3.1"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(!is_newer("0.3.1", "0.3.1"));
        assert!(!is_newer("0.3.0", "0.3.1"));
        assert!(!is_newer("0.3.2-beta", "0.3.1"));
        assert!(!is_newer("", "0.3.1"));
    }
}
