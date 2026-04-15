export type ContactDetail = {
  nama?: string;
  telepon?: string;
  alamat?: string;
  kode_pos?: string;
};

export type ShipmentHeader = {
  nomor_kiriman?: string;
  booking_code?: string;
  id_pelanggan_korporat?: string;
};

export type OriginDetail = {
  nama_kantor?: string;
  id_kantor?: string;
  nama_petugas?: string;
  id_petugas?: string;
  tanggal_input?: string;
  waktu_input?: string;
};

export type PackageDetail = {
  jenis_layanan?: string;
  kriteria_kiriman?: string;
  isi_kiriman?: string;
  berat_actual?: number | null;
  berat_volumetric?: number | null;
};

export type TrackCodDetail = {
  is_cod: boolean;
  virtual_account?: string;
  total_cod?: number | null;
  status?: string;
  tanggal?: string;
};

export type BillingDetail = {
  type_pembayaran?: string;
  bea_dasar?: number | null;
  nilai_barang?: number | null;
  htnb?: number | null;
  cod_info: TrackCodDetail;
};

export type Actors = {
  pengirim: ContactDetail;
  penerima: ContactDetail;
};

export type PerformanceDetail = {
  sla_target?: string;
  sla_category?: string;
  sla_days_diff?: number;
};

export type TrackDetail = {
  shipment_header: ShipmentHeader;
  origin_detail: OriginDetail;
  package_detail: PackageDetail;
  billing_detail: BillingDetail;
  actors: Actors;
  performance_detail: PerformanceDetail;
};

export type TrackStatusAkhir = {
  status?: string;
  location?: string;
  officer_name?: string;
  officer_id?: string;
  datetime?: string;
};

export type TrackPod = {
  photo1_url?: string;
  photo2_url?: string;
  signature_url?: string;
  coordinate?: string;
  coordinate_map_url?: string;
};

export type TrackHistoryEntry = {
  tanggal_update: string;
  detail_history: string;
};

export type IrregularitySummary = {
  status?: string;
  petugas?: string;
  lokasi?: string;
  koordinat?: string;
  tanggal?: string;
  waktu?: string;
};

export type BaggingUnbaggingEvent = {
  petugas?: string;
  lokasi?: string;
  tanggal?: string;
  waktu?: string;
};

export type BaggingUnbaggingSummary = {
  nomor_kantung: string;
  bagging?: BaggingUnbaggingEvent;
  unbagging?: BaggingUnbaggingEvent;
};

export type ManifestR7Summary = {
  nomor_r7?: string;
  petugas?: string;
  lokasi?: string;
  tujuan?: string;
  tanggal?: string;
  waktu?: string;
};

export type DeliveryRunsheetUpdate = {
  petugas?: string;
  status?: string;
  tanggal?: string;
  waktu?: string;
  koordinat?: string;
};

export type DeliveryRunsheetSummary = {
  petugas_mandor?: string;
  petugas_kurir?: string;
  lokasi?: string;
  tanggal?: string;
  waktu?: string;
  koordinat?: string;
  updates: DeliveryRunsheetUpdate[];
};

export type HistorySummary = {
  irregularity: IrregularitySummary[];
  bagging_unbagging: BaggingUnbaggingSummary[];
  manifest_r7: ManifestR7Summary[];
  delivery_runsheet: DeliveryRunsheetSummary[];
};

export type TrackResponse = {
  url: string;
  detail: TrackDetail;
  status_akhir: TrackStatusAkhir;
  pod: TrackPod;
  history: TrackHistoryEntry[];
  history_summary: HistorySummary;
};
