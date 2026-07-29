mod model;
mod storage;

use std::path::PathBuf;

pub use model::{
    Notebook, Page, PageElement, PageMode, Section, WorkspaceState, WORKSPACE_SCHEMA_VERSION,
};
use serde::Serialize;
use storage::{Database, StorageError};
use tauri::Manager;

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
pub async fn load_workspace(
    database: tauri::State<'_, Database>,
) -> Result<WorkspaceState, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.load_workspace())
        .await
        .map_err(|error| CommandError::task(error.to_string()))?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn save_workspace(
    database: tauri::State<'_, Database>,
    workspace: WorkspaceState,
) -> Result<WorkspaceState, CommandError> {
    let database = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || database.save_workspace(&workspace))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let database = Database::new(database_path(app.handle())?);
            database.initialize()?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![load_workspace, save_workspace])
        .run(tauri::generate_context!())
        .expect("failed to run Canvink");
}
