use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use crate::parse::{bag::TrackBagResponse, manifest::TrackManifestResponse, track::TrackResponse};

#[derive(Debug, Clone, Serialize)]
pub struct ParserDriftEvent {
    pub kind: String,
    pub id: String,
    pub url: String,
    pub reasons: Vec<String>,
    pub detected_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParserGuardSnapshot {
    pub total_events: usize,
    pub recent: Vec<ParserDriftEvent>,
}

pub struct DriftGuard {
    max_events: usize,
    recent_events: Mutex<VecDeque<ParserDriftEvent>>,
}

impl DriftGuard {
    pub fn new(max_events: usize) -> Self {
        Self {
            max_events: max_events.max(10),
            recent_events: Mutex::new(VecDeque::new()),
        }
    }

    pub fn analyze_track(&self, id: &str, response: &TrackResponse) -> usize {
        let mut reasons = Vec::new();
        if response.detail.header.nomor_kiriman.is_none() {
            reasons.push("detail.shipment_header.nomor_kiriman is missing".to_string());
        }
        if response.status_akhir.status.is_none() {
            reasons.push("status_akhir.status is missing".to_string());
        }
        if response.history.is_empty() {
            reasons.push("history is empty".to_string());
        }

        if reasons.len() >= 2 {
            self.push_event(ParserDriftEvent {
                kind: "track".to_string(),
                id: id.to_string(),
                url: response.url.clone(),
                reasons,
                detected_at_ms: now_ms(),
            });
            1
        } else {
            0
        }
    }

    pub fn analyze_bag(&self, id: &str, response: &TrackBagResponse) -> usize {
        let mut reasons = Vec::new();
        if response.items.is_empty() {
            reasons.push("items is empty".to_string());
        }
        if response.nomor_kantung.is_none() && !response.items.is_empty() {
            reasons.push("nomor_kantung is missing while items exist".to_string());
        }

        if !reasons.is_empty() {
            self.push_event(ParserDriftEvent {
                kind: "bag".to_string(),
                id: id.to_string(),
                url: response.url.clone(),
                reasons,
                detected_at_ms: now_ms(),
            });
            1
        } else {
            0
        }
    }

    pub fn analyze_manifest(&self, id: &str, response: &TrackManifestResponse) -> usize {
        let mut reasons = Vec::new();
        if response.items.is_empty() {
            reasons.push("items is empty".to_string());
        }
        if response.total_berat.is_none() && !response.items.is_empty() {
            reasons.push("total_berat is missing while items exist".to_string());
        }

        if !reasons.is_empty() {
            self.push_event(ParserDriftEvent {
                kind: "manifest".to_string(),
                id: id.to_string(),
                url: response.url.clone(),
                reasons,
                detected_at_ms: now_ms(),
            });
            1
        } else {
            0
        }
    }

    pub fn snapshot(&self) -> ParserGuardSnapshot {
        let events = self
            .recent_events
            .lock()
            .expect("drift guard mutex should not be poisoned");
        ParserGuardSnapshot {
            total_events: events.len(),
            recent: events.iter().cloned().collect(),
        }
    }

    fn push_event(&self, event: ParserDriftEvent) {
        let mut events = self
            .recent_events
            .lock()
            .expect("drift guard mutex should not be poisoned");
        events.push_front(event);
        while events.len() > self.max_events {
            events.pop_back();
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
