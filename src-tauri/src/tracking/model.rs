use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct TrackingClientState {
    pub client: reqwest::Client,
    pub source_config: Arc<Mutex<TrackingSourceConfig>>,
}

impl TrackingClientState {
    pub fn update_source_config(&self, config: TrackingSourceConfig) {
        let mut source_config = self
            .source_config
            .lock()
            .expect("tracking source config lock poisoned");
        *source_config = config;
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackingSource {
    Default,
    ExternalApi,
}

impl Default for TrackingSource {
    fn default() -> Self {
        Self::Default
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingSourceConfig {
    pub tracking_source: TrackingSource,
    pub external_api_base_url: String,
    pub external_api_auth_token: String,
    pub allow_insecure_external_api_http: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TrackDetail {
    #[serde(rename = "shipment_header")]
    pub header: ShipmentHeader,
    #[serde(rename = "origin_detail")]
    pub origin: OriginDetail,
    #[serde(rename = "package_detail")]
    pub package: PackageDetail,
    #[serde(rename = "billing_detail")]
    pub billing: BillingDetail,
    #[serde(rename = "actors")]
    pub actors: Actors,
    #[serde(rename = "performance_detail")]
    pub performance: PerformanceDetail,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ShipmentHeader {
    pub nomor_kiriman: Option<String>,
    pub booking_code: Option<String>,
    pub id_pelanggan_korporat: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct OriginDetail {
    pub nama_kantor: Option<String>,
    pub id_kantor: Option<String>,
    pub nama_petugas: Option<String>,
    pub id_petugas: Option<String>,
    #[serde(rename = "tanggal_input")]
    pub tanggal: Option<String>,
    #[serde(rename = "waktu_input")]
    pub waktu: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PackageDetail {
    pub jenis_layanan: Option<String>,
    pub kriteria_kiriman: Option<String>,
    pub isi_kiriman: Option<String>,
    pub berat_actual: Option<f64>,
    pub berat_volumetric: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BillingDetail {
    pub type_pembayaran: Option<String>,
    pub bea_dasar: Option<f64>,
    pub nilai_barang: Option<f64>,
    pub htnb: Option<f64>,
    #[serde(rename = "cod_info")]
    pub cod: TrackCodDetail,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Actors {
    pub pengirim: ContactDetail,
    pub penerima: ContactDetail,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PerformanceDetail {
    #[serde(rename = "sla_target")]
    pub sla: Option<String>,
    pub sla_category: Option<String>,
    #[serde(rename = "sla_days_diff")]
    pub sla_days: Option<i32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TrackCodDetail {
    pub is_cod: bool,
    pub virtual_account: Option<String>,
    pub total_cod: Option<f64>,
    pub status: Option<String>,
    pub tanggal: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TrackStatusAkhir {
    pub status: Option<String>,
    pub location: Option<String>,
    pub officer_name: Option<String>,
    pub officer_id: Option<String>,
    pub datetime: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TrackPod {
    pub photo1_url: Option<String>,
    pub photo2_url: Option<String>,
    pub signature_url: Option<String>,
    pub coordinate: Option<String>,
    pub coordinate_map_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrackHistoryEntry {
    pub tanggal_update: String,
    pub detail_history: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HistorySummary {
    pub irregularity: Vec<IrregularitySummary>,
    pub bagging_unbagging: Vec<BaggingUnbaggingSummary>,
    pub manifest_r7: Vec<ManifestR7Summary>,
    pub delivery_runsheet: Vec<DeliveryRunsheetSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IrregularitySummary {
    pub status: Option<String>,
    pub petugas: Option<String>,
    pub lokasi: Option<String>,
    pub koordinat: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaggingUnbaggingEvent {
    pub petugas: Option<String>,
    pub lokasi: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BaggingUnbaggingSummary {
    pub nomor_kantung: String,
    pub bagging: Option<BaggingUnbaggingEvent>,
    pub unbagging: Option<BaggingUnbaggingEvent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManifestR7Summary {
    pub nomor_r7: Option<String>,
    pub petugas: Option<String>,
    pub lokasi: Option<String>,
    pub tujuan: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeliveryRunsheetUpdate {
    pub petugas: Option<String>,
    pub status: Option<String>,
    pub keterangan_status: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
    pub koordinat: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeliveryRunsheetSummary {
    pub petugas_mandor: Option<String>,
    pub petugas_kurir: Option<String>,
    pub lokasi: Option<String>,
    pub tanggal: Option<String>,
    pub waktu: Option<String>,
    pub koordinat: Option<String>,
    pub updates: Vec<DeliveryRunsheetUpdate>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrackResponse {
    pub url: String,
    pub detail: TrackDetail,
    pub status_akhir: TrackStatusAkhir,
    pub pod: TrackPod,
    pub history: Vec<TrackHistoryEntry>,
    pub history_summary: HistorySummary,
}

#[derive(Debug)]
pub enum TrackingError {
    BadRequest(String),
    NotFound(String),
    Upstream(String),
}

pub type StatusAkhirParts = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ContactDetail {
    pub nama: Option<String>,
    pub telepon: Option<String>,
    pub alamat: Option<String>,
    pub kode_pos: Option<String>,
}
