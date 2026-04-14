use serde::{Deserialize, Serialize};

use crate::parse::track::TrackLiteResponse;

#[derive(Clone, Serialize, Deserialize)]
pub struct TrackLiteBatchResponse {
    pub total: usize,
    pub success: usize,
    pub failed: usize,
    pub results: Vec<TrackLiteBatchItem>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TrackLiteBatchItem {
    pub id: String,
    pub ok: bool,
    pub data: Option<TrackLiteResponse>,
    pub error: Option<TrackLiteBatchError>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TrackLiteBatchError {
    pub code: String,
    pub message: String,
}
