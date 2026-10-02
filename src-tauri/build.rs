use std::{collections::HashMap, fs, path::Path};

/// Desktop sign-in endpoints (src/desktop_auth.rs), compiled into the binary.
/// Same sources and precedence as Vite's `--mode desktop`: the process
/// environment, then `../.env.desktop.local`, then `../.env.desktop`.
fn desktop_endpoints() {
    let mut values: HashMap<String, String> = HashMap::new();
    for file in ["../.env.desktop", "../.env.desktop.local"] {
        println!("cargo:rerun-if-changed={file}");
        let Ok(text) = fs::read_to_string(Path::new(file)) else {
            continue;
        };
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                values.insert(key.trim().to_owned(), value.trim().to_owned());
            }
        }
    }
    for (env_key, file_key) in [
        ("CANVINK_SYNC_URL", "VITE_COLLAB_SYNC_URL"),
        ("CANVINK_LOGIN_URL", "VITE_DESKTOP_LOGIN_URL"),
    ] {
        println!("cargo:rerun-if-env-changed={file_key}");
        let value = std::env::var(file_key)
            .ok()
            .or_else(|| values.get(file_key).cloned())
            .unwrap_or_default();
        println!("cargo:rustc-env={env_key}={value}");
    }
}

fn main() {
    desktop_endpoints();
    tauri_build::build()
}
