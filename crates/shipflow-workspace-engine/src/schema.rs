pub const SCHEMA_VERSION: u32 = 1;

pub const SQLITE_PRAGMAS: &[&str] = &[
    "PRAGMA journal_mode = WAL;",
    "PRAGMA foreign_keys = ON;",
    "PRAGMA synchronous = NORMAL;",
];

pub const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sheets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  view_mode TEXT NOT NULL DEFAULT 'workspace',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracking_records (
  id TEXT PRIMARY KEY,
  display_tracking_id TEXT NOT NULL,
  lookup_tracking_id TEXT NOT NULL,
  normalized_status TEXT,
  status_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  history_json TEXT NOT NULL,
  raw_blob_id TEXT REFERENCES raw_blobs(id),
  fetched_at TEXT NOT NULL,
  source_url TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sheet_rows (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  display_tracking_id TEXT NOT NULL,
  lookup_tracking_id TEXT NOT NULL,
  tracking_record_id TEXT REFERENCES tracking_records(id),
  row_status TEXT NOT NULL,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(sheet_id, position)
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  total_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);

CREATE TABLE IF NOT EXISTS import_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL,
  source_item_kind TEXT NOT NULL,
  position INTEGER NOT NULL,
  status TEXT NOT NULL,
  tracking_ids_json TEXT NOT NULL DEFAULT '[]',
  sheet_row_ids_json TEXT NOT NULL DEFAULT '[]',
  error_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, source_item_id, source_item_kind)
);

CREATE TABLE IF NOT EXISTS import_attempts (
  id TEXT PRIMARY KEY,
  job_item_id TEXT NOT NULL REFERENCES import_job_items(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  raw_blob_id TEXT REFERENCES raw_blobs(id),
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS raw_blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  byte_len INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_cache (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  query_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(sheet_id, query_hash, source_revision)
);

CREATE INDEX IF NOT EXISTS idx_sheet_rows_sheet_position ON sheet_rows(sheet_id, position);
CREATE INDEX IF NOT EXISTS idx_sheet_rows_sheet_display_id ON sheet_rows(sheet_id, display_tracking_id);
CREATE INDEX IF NOT EXISTS idx_sheet_rows_lookup_id ON sheet_rows(lookup_tracking_id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_sheet_status ON import_jobs(sheet_id, status);
CREATE INDEX IF NOT EXISTS idx_import_items_job_status ON import_job_items(job_id, status);
CREATE INDEX IF NOT EXISTS idx_import_attempts_item_number ON import_attempts(job_item_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_tracking_records_lookup_id ON tracking_records(lookup_tracking_id);
"#;

pub fn migration_sql() -> String {
    let mut sql = SQLITE_PRAGMAS.join("\n");
    sql.push('\n');
    sql.push_str(SCHEMA_SQL);
    sql
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_contains_required_pragmas() {
        let migration = migration_sql();

        assert!(migration.contains("PRAGMA journal_mode = WAL;"));
        assert!(migration.contains("PRAGMA foreign_keys = ON;"));
        assert!(migration.contains("PRAGMA synchronous = NORMAL;"));
    }

    #[test]
    fn schema_contains_big_bang_tables_and_indexes() {
        let required_fragments = [
            "CREATE TABLE IF NOT EXISTS sheets",
            "CREATE TABLE IF NOT EXISTS sheet_rows",
            "CREATE TABLE IF NOT EXISTS tracking_records",
            "CREATE TABLE IF NOT EXISTS import_jobs",
            "CREATE TABLE IF NOT EXISTS import_job_items",
            "CREATE TABLE IF NOT EXISTS import_attempts",
            "CREATE TABLE IF NOT EXISTS raw_blobs",
            "CREATE TABLE IF NOT EXISTS analytics_cache",
            "idx_sheet_rows_sheet_position",
            "idx_sheet_rows_sheet_display_id",
            "idx_import_jobs_sheet_status",
            "idx_tracking_records_lookup_id",
        ];

        for fragment in required_fragments {
            assert!(SCHEMA_SQL.contains(fragment), "missing {fragment}");
        }
    }
}
