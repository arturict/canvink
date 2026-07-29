use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const WORKSPACE_SCHEMA_VERSION: u32 = 1;

fn workspace_schema_version() -> u32 {
    WORKSPACE_SCHEMA_VERSION
}

fn epoch_timestamp() -> String {
    "1970-01-01T00:00:00.000Z".to_owned()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    #[serde(default = "workspace_schema_version")]
    pub schema_version: u32,
    #[serde(default = "epoch_timestamp")]
    pub updated_at: String,
    #[serde(default)]
    pub notebooks: Vec<Notebook>,
    #[serde(default)]
    pub trash: Vec<Value>,
    #[serde(default)]
    pub active_notebook_id: String,
    #[serde(default)]
    pub active_section_id: String,
    #[serde(default)]
    pub active_page_id: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            schema_version: WORKSPACE_SCHEMA_VERSION,
            updated_at: epoch_timestamp(),
            notebooks: Vec::new(),
            trash: Vec::new(),
            active_notebook_id: String::new(),
            active_section_id: String::new(),
            active_page_id: String::new(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notebook {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub sections: Vec<Section>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub pages: Vec<Page>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PageMode {
    #[default]
    Free,
    A4,
}

impl PageMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::A4 => "a4",
        }
    }
}

impl TryFrom<&str> for PageMode {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "free" => Ok(Self::Free),
            "a4" => Ok(Self::A4),
            _ => Err(format!("unsupported page mode `{value}`")),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_page_id: Option<String>,
    #[serde(default)]
    pub mode: PageMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub elements: Vec<PageElement>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageElement {
    pub id: String,
    #[serde(alias = "type")]
    pub kind: String,
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(flatten)]
    pub payload: BTreeMap<String, Value>,
}
