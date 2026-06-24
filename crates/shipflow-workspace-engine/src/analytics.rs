use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::error::Error;
use std::fmt::{Display, Formatter};

use duckdb::types::Value as DuckDbValue;
use duckdb::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::storage::{
    SheetFilter, SheetRowProjection, SheetRowsQuery, SheetValueFilter, SqliteWorkspaceStore,
    WorkspaceStoreError,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsSourceScope {
    AllRows,
    FilteredRows,
    SelectedRows,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsAggregation {
    Sum,
    Average,
    Min,
    Max,
    Count,
    CountUnique,
    UniqueList,
    MostFrequent,
    First,
    Last,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsSortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsValue {
    pub field: String,
    pub aggregation: AnalyticsAggregation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSort {
    pub field: String,
    pub direction: AnalyticsSortDirection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotQuery {
    pub sheet_id: String,
    pub source_scope: AnalyticsSourceScope,
    pub filters: Vec<SheetFilter>,
    #[serde(default)]
    pub value_filters: Vec<SheetValueFilter>,
    pub selected_row_ids: Vec<String>,
    pub row_fields: Vec<String>,
    pub column_fields: Vec<String>,
    pub values: Vec<AnalyticsValue>,
    pub sort: Vec<AnalyticsSort>,
    pub limit: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotResult {
    pub sheet_id: String,
    pub source_row_count: u32,
    pub rows: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartQuery {
    pub pivot_query: PivotQuery,
    pub chart_type: ChartType,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartType {
    Bar,
    Donut,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartResult {
    pub sheet_id: String,
    pub chart_type: ChartType,
    pub source_row_count: u32,
    pub series: Vec<serde_json::Value>,
}

#[derive(Debug)]
pub enum AnalyticsEngineError {
    DuckDb(duckdb::Error),
    Store(WorkspaceStoreError),
}

impl Display for AnalyticsEngineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuckDb(error) => write!(formatter, "duckdb error: {error}"),
            Self::Store(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for AnalyticsEngineError {}

impl From<duckdb::Error> for AnalyticsEngineError {
    fn from(error: duckdb::Error) -> Self {
        Self::DuckDb(error)
    }
}

impl From<WorkspaceStoreError> for AnalyticsEngineError {
    fn from(error: WorkspaceStoreError) -> Self {
        Self::Store(error)
    }
}

pub type AnalyticsEngineResult<T> = Result<T, AnalyticsEngineError>;

#[derive(Clone, Debug)]
pub struct DuckDbAnalyticsEngine {
    max_source_rows: u32,
}

impl DuckDbAnalyticsEngine {
    pub fn new(max_source_rows: u32) -> Self {
        Self { max_source_rows }
    }

    pub fn query_pivot(
        &self,
        store: &SqliteWorkspaceStore,
        query: &PivotQuery,
    ) -> AnalyticsEngineResult<PivotResult> {
        let source_rows = self.query_source_rows(store, query)?;

        query_pivot_from_rows(&source_rows.rows, query)
    }

    pub fn query_chart(
        &self,
        store: &SqliteWorkspaceStore,
        query: &ChartQuery,
    ) -> AnalyticsEngineResult<ChartResult> {
        let pivot = self.query_pivot(store, &query.pivot_query)?;

        Ok(ChartResult {
            sheet_id: pivot.sheet_id,
            chart_type: query.chart_type,
            source_row_count: pivot.source_row_count,
            series: pivot.rows,
        })
    }

    fn query_source_rows(
        &self,
        store: &SqliteWorkspaceStore,
        query: &PivotQuery,
    ) -> AnalyticsEngineResult<crate::storage::SheetRowWindow> {
        let filters = match query.source_scope {
            AnalyticsSourceScope::FilteredRows => query.filters.clone(),
            AnalyticsSourceScope::AllRows | AnalyticsSourceScope::SelectedRows => Vec::new(),
        };
        let value_filters = match query.source_scope {
            AnalyticsSourceScope::FilteredRows => query.value_filters.clone(),
            AnalyticsSourceScope::AllRows | AnalyticsSourceScope::SelectedRows => Vec::new(),
        };
        let mut window = store.query_sheet_rows(
            &SheetRowsQuery {
                sheet_id: query.sheet_id.clone(),
                offset: 0,
                limit: self.max_source_rows,
                filters,
                value_filters,
                sort: vec![],
            },
            self.max_source_rows,
        )?;

        if query.source_scope == AnalyticsSourceScope::SelectedRows {
            let selected_row_ids = query
                .selected_row_ids
                .iter()
                .map(|id| id.trim())
                .filter(|id| !id.is_empty())
                .collect::<HashSet<_>>();
            window
                .rows
                .retain(|row| selected_row_ids.contains(row.row_id.as_str()));
            window.total_count = window.rows.len() as u32;
        }

        Ok(window)
    }
}

#[derive(Clone, Debug, PartialEq)]
struct FieldBinding {
    path: String,
    text_column: String,
    numeric_column: String,
    presence_column: String,
}

#[derive(Clone, Debug, PartialEq)]
struct FieldCell {
    text: String,
    numeric: f64,
    has_value: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct PivotOutputRow {
    row_values: Vec<String>,
    column_values: Vec<String>,
    count: u32,
    metrics: BTreeMap<String, serde_json::Value>,
    share: f64,
}

fn query_pivot_from_rows(
    rows: &[SheetRowProjection],
    query: &PivotQuery,
) -> AnalyticsEngineResult<PivotResult> {
    let bindings = create_field_bindings(query);
    let connection = Connection::open_in_memory()?;
    create_duckdb_source_table(&connection, &bindings)?;
    insert_duckdb_rows(&connection, &bindings, rows)?;

    let mut output_rows = query_duckdb_pivot_rows(&connection, &bindings, query)?;
    apply_pivot_sort(&mut output_rows, &query.sort);
    output_rows.truncate(query.limit as usize);

    Ok(PivotResult {
        sheet_id: query.sheet_id.clone(),
        source_row_count: rows.len() as u32,
        rows: output_rows
            .into_iter()
            .map(|row| {
                json!({
                    "rowValues": row.row_values,
                    "columnValues": row.column_values,
                    "count": row.count,
                    "metrics": row.metrics,
                    "share": row.share,
                })
            })
            .collect(),
    })
}

fn create_field_bindings(query: &PivotQuery) -> Vec<FieldBinding> {
    let mut seen = HashSet::new();
    query
        .row_fields
        .iter()
        .chain(query.column_fields.iter())
        .chain(query.values.iter().map(|value| &value.field))
        .filter_map(|path| {
            let normalized = path.trim();
            if normalized.is_empty() || !seen.insert(normalized.to_string()) {
                return None;
            }

            let index = seen.len() - 1;
            Some(FieldBinding {
                path: normalized.to_string(),
                text_column: format!("field_{index}_text"),
                numeric_column: format!("field_{index}_number"),
                presence_column: format!("field_{index}_has_value"),
            })
        })
        .collect()
}

fn create_duckdb_source_table(
    connection: &Connection,
    bindings: &[FieldBinding],
) -> AnalyticsEngineResult<()> {
    let columns = bindings
        .iter()
        .flat_map(|binding| {
            [
                format!("{} TEXT NOT NULL", quote_identifier(&binding.text_column)),
                format!(
                    "{} DOUBLE NOT NULL",
                    quote_identifier(&binding.numeric_column)
                ),
                format!(
                    "{} BOOLEAN NOT NULL",
                    quote_identifier(&binding.presence_column)
                ),
            ]
        })
        .collect::<Vec<_>>();
    let sql = if columns.is_empty() {
        "CREATE TABLE shipflow_rows (__row_index INTEGER NOT NULL)".to_string()
    } else {
        format!(
            "CREATE TABLE shipflow_rows (__row_index INTEGER NOT NULL, {})",
            columns.join(", ")
        )
    };

    connection.execute(&sql, [])?;
    Ok(())
}

fn insert_duckdb_rows(
    connection: &Connection,
    bindings: &[FieldBinding],
    rows: &[SheetRowProjection],
) -> AnalyticsEngineResult<()> {
    let placeholders = std::iter::repeat_n("?", 1 + bindings.len() * 3)
        .collect::<Vec<_>>()
        .join(", ");
    let insert_columns = std::iter::once("__row_index".to_string())
        .chain(bindings.iter().flat_map(|binding| {
            [
                quote_identifier(&binding.text_column),
                quote_identifier(&binding.numeric_column),
                quote_identifier(&binding.presence_column),
            ]
        }))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("INSERT INTO shipflow_rows ({insert_columns}) VALUES ({placeholders})");
    let mut statement = connection.prepare(&sql)?;

    for (row_index, row) in rows.iter().enumerate() {
        let mut values = vec![DuckDbValue::Int(row_index as i32)];
        for binding in bindings {
            let cell = extract_field_cell(row, &binding.path);
            values.push(DuckDbValue::Text(cell.text));
            values.push(DuckDbValue::Double(cell.numeric));
            values.push(DuckDbValue::Boolean(cell.has_value));
        }
        statement.execute(params_from_iter(values.iter()))?;
    }

    Ok(())
}

fn query_duckdb_pivot_rows(
    connection: &Connection,
    bindings: &[FieldBinding],
    query: &PivotQuery,
) -> AnalyticsEngineResult<Vec<PivotOutputRow>> {
    let binding_by_path = bindings
        .iter()
        .map(|binding| (binding.path.as_str(), binding))
        .collect::<HashMap<_, _>>();
    let dimension_bindings = query
        .row_fields
        .iter()
        .chain(query.column_fields.iter())
        .filter_map(|path| binding_by_path.get(path.as_str()).copied())
        .collect::<Vec<_>>();
    let select_dimensions = dimension_bindings
        .iter()
        .map(|binding| quote_identifier(&binding.text_column))
        .collect::<Vec<_>>();
    let metric_expressions = query
        .values
        .iter()
        .filter_map(|value| {
            binding_by_path
                .get(value.field.as_str())
                .map(|binding| metric_expression(value, binding))
        })
        .collect::<Vec<_>>();
    let select_expressions = select_dimensions
        .iter()
        .cloned()
        .chain(std::iter::once("count(*) AS __row_count".to_string()))
        .chain(metric_expressions)
        .collect::<Vec<_>>();
    let group_by = if select_dimensions.is_empty() {
        String::new()
    } else {
        format!(" GROUP BY {}", select_dimensions.join(", "))
    };
    let order_by = if select_dimensions.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", select_dimensions.join(", "))
    };
    let sql = format!(
        "SELECT {} FROM shipflow_rows{}{}",
        select_expressions.join(", "),
        group_by,
        order_by
    );
    let mut statement = connection.prepare(&sql)?;
    let queried_rows = statement
        .query_map([], |row| {
            let mut column_index = 0;
            let mut row_values = Vec::with_capacity(query.row_fields.len());
            let mut column_values = Vec::with_capacity(query.column_fields.len());

            for _ in &query.row_fields {
                row_values.push(row.get::<_, String>(column_index)?);
                column_index += 1;
            }

            for _ in &query.column_fields {
                column_values.push(row.get::<_, String>(column_index)?);
                column_index += 1;
            }

            let count = row.get::<_, i64>(column_index)? as u32;
            column_index += 1;

            let mut metrics = BTreeMap::new();
            for value in &query.values {
                let key = metric_key(value);
                let value = match value.aggregation {
                    AnalyticsAggregation::UniqueList
                    | AnalyticsAggregation::MostFrequent
                    | AnalyticsAggregation::First
                    | AnalyticsAggregation::Last => {
                        let text = row.get::<_, String>(column_index)?;
                        serde_json::Value::String(text)
                    }
                    AnalyticsAggregation::Count | AnalyticsAggregation::CountUnique => {
                        let count = row.get::<_, i64>(column_index)?;
                        serde_json::Value::Number(count.into())
                    }
                    AnalyticsAggregation::Sum
                    | AnalyticsAggregation::Average
                    | AnalyticsAggregation::Min
                    | AnalyticsAggregation::Max => {
                        let number = row.get::<_, f64>(column_index)?;
                        json!(number)
                    }
                };
                metrics.insert(key, value);
                column_index += 1;
            }

            Ok(PivotOutputRow {
                row_values,
                column_values,
                count,
                metrics,
                share: 0.0,
            })
        })?
        .collect::<Result<Vec<_>, duckdb::Error>>()?;

    let total_count = queried_rows.iter().map(|row| row.count).sum::<u32>();
    Ok(queried_rows
        .into_iter()
        .map(|row| PivotOutputRow {
            share: if total_count > 0 {
                (row.count as f64 / total_count as f64) * 100.0
            } else {
                0.0
            },
            ..row
        })
        .collect())
}

fn apply_pivot_sort(rows: &mut [PivotOutputRow], sort: &[AnalyticsSort]) {
    rows.sort_by(|left, right| {
        for sort_item in sort {
            let ordering = compare_pivot_rows(left, right, sort_item);
            if ordering != Ordering::Equal {
                return match sort_item.direction {
                    AnalyticsSortDirection::Asc => ordering,
                    AnalyticsSortDirection::Desc => ordering.reverse(),
                };
            }
        }

        right
            .count
            .cmp(&left.count)
            .then_with(|| {
                left.row_values
                    .join("\u{1f}")
                    .cmp(&right.row_values.join("\u{1f}"))
            })
            .then_with(|| {
                left.column_values
                    .join("\u{1f}")
                    .cmp(&right.column_values.join("\u{1f}"))
            })
    });
}

fn compare_pivot_rows(
    left: &PivotOutputRow,
    right: &PivotOutputRow,
    sort: &AnalyticsSort,
) -> Ordering {
    if sort.field == "count" {
        return left.count.cmp(&right.count);
    }

    if sort.field == "share" {
        return compare_f64(left.share, right.share);
    }

    if let (Some(left_value), Some(right_value)) = (
        left.metrics.get(&sort.field),
        right.metrics.get(&sort.field),
    ) {
        return compare_json_values(left_value, right_value);
    }

    Ordering::Equal
}

fn compare_json_values(left: &serde_json::Value, right: &serde_json::Value) -> Ordering {
    match (left.as_f64(), right.as_f64()) {
        (Some(left), Some(right)) => compare_f64(left, right),
        _ => left.to_string().cmp(&right.to_string()),
    }
}

fn compare_f64(left: f64, right: f64) -> Ordering {
    left.partial_cmp(&right).unwrap_or(Ordering::Equal)
}

fn metric_expression(value: &AnalyticsValue, binding: &FieldBinding) -> String {
    let text_column = quote_identifier(&binding.text_column);
    let numeric_column = quote_identifier(&binding.numeric_column);
    let presence_column = quote_identifier(&binding.presence_column);
    let alias = quote_identifier(&metric_key(value));

    let expression = match value.aggregation {
        AnalyticsAggregation::Sum => {
            format!("coalesce(sum({numeric_column}) FILTER (WHERE {presence_column}), 0)")
        }
        AnalyticsAggregation::Average => {
            format!("coalesce(avg({numeric_column}) FILTER (WHERE {presence_column}), 0)")
        }
        AnalyticsAggregation::Min => {
            format!("coalesce(min({numeric_column}) FILTER (WHERE {presence_column}), 0)")
        }
        AnalyticsAggregation::Max => {
            format!("coalesce(max({numeric_column}) FILTER (WHERE {presence_column}), 0)")
        }
        AnalyticsAggregation::Count => {
            format!("sum(CASE WHEN {presence_column} THEN 1 ELSE 0 END)")
        }
        AnalyticsAggregation::CountUnique => {
            format!("count(DISTINCT CASE WHEN {presence_column} THEN {text_column} ELSE NULL END)")
        }
        AnalyticsAggregation::UniqueList => {
            format!(
                "coalesce(string_agg(DISTINCT CASE WHEN {presence_column} THEN {text_column} ELSE NULL END, ', '), '-')"
            )
        }
        AnalyticsAggregation::MostFrequent => {
            format!("coalesce(mode({text_column}) FILTER (WHERE {presence_column}), '-')")
        }
        AnalyticsAggregation::First => {
            format!("coalesce(first({text_column}) FILTER (WHERE {presence_column}), '-')")
        }
        AnalyticsAggregation::Last => {
            format!("coalesce(last({text_column}) FILTER (WHERE {presence_column}), '-')")
        }
    };

    format!("{expression} AS {alias}")
}

fn metric_key(value: &AnalyticsValue) -> String {
    format!("{}__{}", value.field, aggregation_key(value.aggregation))
}

fn aggregation_key(aggregation: AnalyticsAggregation) -> &'static str {
    match aggregation {
        AnalyticsAggregation::Sum => "sum",
        AnalyticsAggregation::Average => "average",
        AnalyticsAggregation::Min => "min",
        AnalyticsAggregation::Max => "max",
        AnalyticsAggregation::Count => "count",
        AnalyticsAggregation::CountUnique => "count_unique",
        AnalyticsAggregation::UniqueList => "unique_list",
        AnalyticsAggregation::MostFrequent => "most_frequent",
        AnalyticsAggregation::First => "first",
        AnalyticsAggregation::Last => "last",
    }
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn extract_field_cell(row: &SheetRowProjection, path: &str) -> FieldCell {
    let value = extract_field_value(row, path);
    let Some(value) = value else {
        return missing_field_cell();
    };

    match value {
        serde_json::Value::Null => missing_field_cell(),
        serde_json::Value::Bool(value) => FieldCell {
            text: value.to_string(),
            numeric: if value { 1.0 } else { 0.0 },
            has_value: true,
        },
        serde_json::Value::Number(value) => {
            let numeric = value.as_f64().unwrap_or(0.0);
            FieldCell {
                text: trim_number_text(numeric),
                numeric,
                has_value: true,
            }
        }
        serde_json::Value::String(value) => {
            let text = value.trim();
            if text.is_empty() || text == "-" {
                return missing_field_cell();
            }
            FieldCell {
                text: text.to_string(),
                numeric: text.parse::<f64>().unwrap_or(0.0),
                has_value: true,
            }
        }
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => FieldCell {
            text: value.to_string(),
            numeric: 0.0,
            has_value: true,
        },
    }
}

fn extract_field_value(row: &SheetRowProjection, path: &str) -> Option<serde_json::Value> {
    match path {
        "detail.shipment_header.nomor_kiriman" | "displayTrackingId" => {
            Some(serde_json::Value::String(row.display_tracking_id.clone()))
        }
        "lookupTrackingId" => Some(serde_json::Value::String(row.lookup_tracking_id.clone())),
        _ if path.starts_with("status_akhir.") => {
            let local_path = path.trim_start_matches("status_akhir.");
            extract_json_path(row.status_json.as_ref()?, local_path).cloned()
        }
        _ if path.starts_with("detail.") => {
            let local_path = path.trim_start_matches("detail.");
            extract_json_path(row.detail_json.as_ref()?, local_path).cloned()
        }
        _ => None,
    }
}

fn extract_json_path<'a>(
    value: &'a serde_json::Value,
    path: &str,
) -> Option<&'a serde_json::Value> {
    path.split('.')
        .filter(|segment| !segment.is_empty())
        .try_fold(value, |current, segment| current.get(segment))
}

fn missing_field_cell() -> FieldCell {
    FieldCell {
        text: "-".to_string(),
        numeric: 0.0,
        has_value: false,
    }
}

fn trim_number_text(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    use serde_json::json;

    use crate::storage::{
        AttachTrackingRecordToSheetRowInput, CreateSheetInput, CreateWorkspaceInput, SheetFilter,
        SheetRowProjection, SheetRowStatus, SheetRowsQuery, SheetValueFilter, SqliteWorkspaceStore,
        UpsertSheetRowInput, UpsertTrackingRecordInput,
    };

    #[test]
    fn pivot_query_contract_supports_text_and_numeric_aggregations() {
        let query = PivotQuery {
            sheet_id: "sheet-1".to_string(),
            source_scope: AnalyticsSourceScope::FilteredRows,
            filters: vec![],
            value_filters: vec![SheetValueFilter {
                field: "status_akhir.status".to_string(),
                values: vec!["DELIVERED".to_string()],
            }],
            selected_row_ids: vec![],
            row_fields: vec!["detail.package_detail.jenis_layanan".to_string()],
            column_fields: vec!["status_akhir.status".to_string()],
            values: vec![
                AnalyticsValue {
                    field: "detail.billing_detail.cod_info.total_cod".to_string(),
                    aggregation: AnalyticsAggregation::Sum,
                },
                AnalyticsValue {
                    field: "status_akhir.status".to_string(),
                    aggregation: AnalyticsAggregation::CountUnique,
                },
            ],
            sort: vec![AnalyticsSort {
                field: "share".to_string(),
                direction: AnalyticsSortDirection::Desc,
            }],
            limit: 1_000,
        };

        let json = serde_json::to_string(&query).expect("query serializes");

        assert!(json.contains(r#""sourceScope":"filtered_rows""#));
        assert!(json.contains(r#""valueFilters":[{"field":"status_akhir.status""#));
        assert!(json.contains(r#""aggregation":"count_unique""#));
    }

    #[test]
    fn duckdb_pivot_splits_text_columns_and_aggregates_values() {
        let rows = vec![
            row_projection(
                "row-1",
                "P1",
                "PKH",
                "unBag",
                10,
                serde_json::Value::Number(100.into()),
            ),
            row_projection(
                "row-2",
                "P2",
                "PKH",
                "DELIVERED",
                3,
                serde_json::Value::Number(200.into()),
            ),
            row_projection(
                "row-3",
                "P3",
                "EC3",
                "unBag",
                5,
                serde_json::Value::Number(50.into()),
            ),
        ];

        let result = query_pivot_from_rows(
            &rows,
            &PivotQuery {
                sheet_id: "sheet-1".to_string(),
                source_scope: AnalyticsSourceScope::AllRows,
                filters: vec![],
                value_filters: vec![],
                selected_row_ids: vec![],
                row_fields: vec!["detail.package_detail.jenis_layanan".to_string()],
                column_fields: vec!["status_akhir.status".to_string()],
                values: vec![
                    AnalyticsValue {
                        field: "detail.performance_detail.sla_days_diff".to_string(),
                        aggregation: AnalyticsAggregation::Sum,
                    },
                    AnalyticsValue {
                        field: "detail.shipment_header.nomor_kiriman".to_string(),
                        aggregation: AnalyticsAggregation::CountUnique,
                    },
                ],
                sort: vec![AnalyticsSort {
                    field: "count".to_string(),
                    direction: AnalyticsSortDirection::Desc,
                }],
                limit: 100,
            },
        )
        .expect("pivot query succeeds");

        assert_eq!(result.source_row_count, 3);
        assert_eq!(result.rows.len(), 3);
        assert!(result.rows.iter().any(|row| {
            row["rowValues"] == json!(["PKH"])
                && row["columnValues"] == json!(["unBag"])
                && row["metrics"]["detail.performance_detail.sla_days_diff__sum"] == json!(10.0)
                && row["metrics"]["detail.shipment_header.nomor_kiriman__count_unique"] == json!(1)
        }));
    }

    #[test]
    fn duckdb_pivot_matches_current_ts_fixture_output() {
        let rows = vec![
            row_projection(
                "row-1",
                "P1",
                "Q9",
                "DELIVERED",
                0,
                serde_json::Value::Number(100_000.into()),
            ),
            row_projection(
                "row-4",
                "P4",
                "Q9",
                "DELIVERED",
                0,
                serde_json::Value::Number(200_000.into()),
            ),
            row_projection(
                "row-2",
                "P2",
                "QCOMM",
                "DELIVERED",
                0,
                serde_json::Value::Number(500_000.into()),
            ),
            row_projection(
                "row-3",
                "P3",
                "Q9",
                "INVEHICLE",
                0,
                serde_json::Value::Number(700_000.into()),
            ),
        ];

        let result = query_pivot_from_rows(
            &rows,
            &PivotQuery {
                sheet_id: "sheet-1".to_string(),
                source_scope: AnalyticsSourceScope::AllRows,
                filters: vec![],
                value_filters: vec![],
                selected_row_ids: vec![],
                row_fields: vec!["detail.package_detail.jenis_layanan".to_string()],
                column_fields: vec!["status_akhir.status".to_string()],
                values: vec![AnalyticsValue {
                    field: "detail.billing_detail.cod_info.total_cod".to_string(),
                    aggregation: AnalyticsAggregation::Sum,
                }],
                sort: vec![AnalyticsSort {
                    field: "share".to_string(),
                    direction: AnalyticsSortDirection::Desc,
                }],
                limit: 100,
            },
        )
        .expect("pivot parity fixture succeeds");

        assert_eq!(result.source_row_count, 4);
        assert_eq!(result.rows.len(), 3);
        assert_pivot_row(
            &result.rows,
            "Q9",
            "DELIVERED",
            2,
            50.0,
            "detail.billing_detail.cod_info.total_cod__sum",
            300_000.0,
        );
        assert_pivot_row(
            &result.rows,
            "QCOMM",
            "DELIVERED",
            1,
            25.0,
            "detail.billing_detail.cod_info.total_cod__sum",
            500_000.0,
        );
        assert_pivot_row(
            &result.rows,
            "Q9",
            "INVEHICLE",
            1,
            25.0,
            "detail.billing_detail.cod_info.total_cod__sum",
            700_000.0,
        );
    }

    #[test]
    fn duckdb_pivot_uses_zero_for_missing_numeric_and_dash_for_missing_text() {
        let rows = vec![SheetRowProjection {
            row_id: "row-1".to_string(),
            position: 0,
            display_tracking_id: "P1".to_string(),
            lookup_tracking_id: "P1".to_string(),
            row_status: SheetRowStatus::Loaded,
            error_message: None,
            status_json: Some(json!({})),
            detail_json: Some(json!({})),
            history_json: Some(json!({})),
        }];

        let result = query_pivot_from_rows(
            &rows,
            &PivotQuery {
                sheet_id: "sheet-1".to_string(),
                source_scope: AnalyticsSourceScope::AllRows,
                filters: vec![],
                value_filters: vec![],
                selected_row_ids: vec![],
                row_fields: vec!["status_akhir.status".to_string()],
                column_fields: vec![],
                values: vec![AnalyticsValue {
                    field: "detail.performance_detail.sla_days_diff".to_string(),
                    aggregation: AnalyticsAggregation::Sum,
                }],
                sort: vec![],
                limit: 10,
            },
        )
        .expect("pivot query succeeds");

        assert_eq!(result.rows[0]["rowValues"], json!(["-"]));
        assert_eq!(
            result.rows[0]["metrics"]["detail.performance_detail.sla_days_diff__sum"],
            json!(0.0)
        );
    }

    #[test]
    fn duckdb_pivot_respects_filtered_and_selected_source_scopes() {
        let mut store = prepared_store();
        for (position, row_id, tracking_id, row_status) in [
            (0, "row-1", "P1", SheetRowStatus::Loaded),
            (1, "row-2", "P2", SheetRowStatus::Failed),
            (2, "row-3", "P3", SheetRowStatus::Loaded),
        ] {
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: row_id.to_string(),
                    sheet_id: "sheet-1".to_string(),
                    position,
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    row_status,
                    error_message: None,
                })
                .expect("row is stored");
        }

        let engine = DuckDbAnalyticsEngine::new(100);
        let filtered = engine
            .query_pivot(
                &store,
                &PivotQuery {
                    sheet_id: "sheet-1".to_string(),
                    source_scope: AnalyticsSourceScope::FilteredRows,
                    filters: vec![SheetFilter {
                        field: "rowStatus".to_string(),
                        value: "loaded".to_string(),
                    }],
                    value_filters: vec![],
                    selected_row_ids: vec![],
                    row_fields: vec!["detail.shipment_header.nomor_kiriman".to_string()],
                    column_fields: vec![],
                    values: vec![AnalyticsValue {
                        field: "detail.shipment_header.nomor_kiriman".to_string(),
                        aggregation: AnalyticsAggregation::CountUnique,
                    }],
                    sort: vec![],
                    limit: 10,
                },
            )
            .expect("filtered pivot succeeds");
        let selected = engine
            .query_pivot(
                &store,
                &PivotQuery {
                    sheet_id: "sheet-1".to_string(),
                    source_scope: AnalyticsSourceScope::SelectedRows,
                    filters: vec![SheetFilter {
                        field: "rowStatus".to_string(),
                        value: "loaded".to_string(),
                    }],
                    value_filters: vec![],
                    selected_row_ids: vec!["row-2".to_string()],
                    row_fields: vec!["detail.shipment_header.nomor_kiriman".to_string()],
                    column_fields: vec![],
                    values: vec![AnalyticsValue {
                        field: "detail.shipment_header.nomor_kiriman".to_string(),
                        aggregation: AnalyticsAggregation::CountUnique,
                    }],
                    sort: vec![],
                    limit: 10,
                },
            )
            .expect("selected pivot succeeds");

        assert_eq!(filtered.source_row_count, 2);
        assert_eq!(
            filtered
                .rows
                .iter()
                .map(|row| row["rowValues"][0].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["P1", "P3"]
        );
        assert_eq!(selected.source_row_count, 1);
        assert_eq!(selected.rows[0]["rowValues"][0], "P2");
    }

    #[test]
    fn duckdb_chart_preserves_pivot_source_row_count() {
        let mut store = prepared_store();
        for (position, row_id, tracking_id) in [(0, "row-1", "P1"), (1, "row-2", "P2")] {
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: row_id.to_string(),
                    sheet_id: "sheet-1".to_string(),
                    position,
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("row is stored");
        }

        let engine = DuckDbAnalyticsEngine::new(100);
        let chart = engine
            .query_chart(
                &store,
                &ChartQuery {
                    pivot_query: PivotQuery {
                        sheet_id: "sheet-1".to_string(),
                        source_scope: AnalyticsSourceScope::AllRows,
                        filters: vec![],
                        value_filters: vec![],
                        selected_row_ids: vec![],
                        row_fields: vec!["detail.shipment_header.nomor_kiriman".to_string()],
                        column_fields: vec![],
                        values: vec![AnalyticsValue {
                            field: "detail.shipment_header.nomor_kiriman".to_string(),
                            aggregation: AnalyticsAggregation::CountUnique,
                        }],
                        sort: vec![],
                        limit: 10,
                    },
                    chart_type: ChartType::Bar,
                },
            )
            .expect("chart query succeeds");

        assert_eq!(chart.chart_type, ChartType::Bar);
        assert_eq!(chart.source_row_count, 2);
        assert_eq!(chart.series.len(), 2);
    }

    #[test]
    fn duckdb_pivot_applies_filtered_value_filters_before_aggregation() {
        let mut store = prepared_store();
        for (position, tracking_id, status, service) in [
            (0, "P1", "INLOCATION", "PKH"),
            (1, "P2", "DELIVERED", "PKH"),
            (2, "P3", "INLOCATION", "EC3"),
        ] {
            let row_id = format!("row-{position}");
            let record_id = format!("record-{position}");
            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: row_id.clone(),
                    sheet_id: "sheet-1".to_string(),
                    position,
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("row is stored");
            store
                .upsert_tracking_record(&UpsertTrackingRecordInput {
                    record_id: record_id.clone(),
                    display_tracking_id: tracking_id.to_string(),
                    lookup_tracking_id: tracking_id.to_string(),
                    normalized_status: Some(status.to_string()),
                    status_json: json!({
                        "status": status,
                    }),
                    detail_json: json!({
                        "shipment_header": {
                            "nomor_kiriman": tracking_id,
                        },
                        "package_detail": {
                            "jenis_layanan": service,
                        }
                    }),
                    history_json: json!({}),
                    raw_blob_id: None,
                    source_url: format!("https://example.test/{tracking_id}"),
                })
                .expect("tracking record is stored");
            store
                .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                    row_id,
                    tracking_record_id: record_id,
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("tracking record is attached");
        }

        let engine = DuckDbAnalyticsEngine::new(100);
        let result = engine
            .query_pivot(
                &store,
                &PivotQuery {
                    sheet_id: "sheet-1".to_string(),
                    source_scope: AnalyticsSourceScope::FilteredRows,
                    filters: vec![],
                    value_filters: vec![SheetValueFilter {
                        field: "status_akhir.status".to_string(),
                        values: vec!["INLOCATION".to_string()],
                    }],
                    selected_row_ids: vec![],
                    row_fields: vec!["status_akhir.status".to_string()],
                    column_fields: vec![],
                    values: vec![AnalyticsValue {
                        field: "detail.shipment_header.nomor_kiriman".to_string(),
                        aggregation: AnalyticsAggregation::CountUnique,
                    }],
                    sort: vec![],
                    limit: 10,
                },
            )
            .expect("filtered value pivot succeeds");

        assert_eq!(result.source_row_count, 2);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0]["rowValues"], json!(["INLOCATION"]));
        assert_eq!(result.rows[0]["count"], json!(2));
        assert_eq!(
            result.rows[0]["metrics"]["detail.shipment_header.nomor_kiriman__count_unique"],
            json!(2)
        );
    }

    #[test]
    fn duckdb_query_and_pivot_handle_10k_rows_performance_smoke() {
        let started = Instant::now();
        let mut store = prepared_store();
        let services = ["PKH", "EC3", "Q9", "KILAT"];
        let statuses = ["DELIVERED", "INLOCATION", "unBag"];

        for position in 0..10_000_u32 {
            let row_id = format!("row-{position}");
            let tracking_id = format!("P{position:013}");
            let record_id = format!("tracking:{tracking_id}");
            let service = services[position as usize % services.len()];
            let status = statuses[position as usize % statuses.len()];
            let total_cod = (position % 1_000) as f64;

            store
                .upsert_sheet_row(&UpsertSheetRowInput {
                    row_id: row_id.clone(),
                    sheet_id: "sheet-1".to_string(),
                    position,
                    display_tracking_id: tracking_id.clone(),
                    lookup_tracking_id: tracking_id.clone(),
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("row is stored");
            store
                .upsert_tracking_record(&UpsertTrackingRecordInput {
                    record_id: record_id.clone(),
                    display_tracking_id: tracking_id.clone(),
                    lookup_tracking_id: tracking_id.clone(),
                    normalized_status: Some(status.to_string()),
                    status_json: json!({ "status": status }),
                    detail_json: json!({
                        "shipment_header": {
                            "nomor_kiriman": tracking_id,
                        },
                        "package_detail": {
                            "jenis_layanan": service,
                        },
                        "billing_detail": {
                            "cod_info": {
                                "total_cod": total_cod,
                            }
                        }
                    }),
                    history_json: json!({}),
                    raw_blob_id: None,
                    source_url: "https://example.test/track".to_string(),
                })
                .expect("tracking record is stored");
            store
                .attach_tracking_record_to_sheet_row(&AttachTrackingRecordToSheetRowInput {
                    row_id,
                    tracking_record_id: record_id,
                    row_status: SheetRowStatus::Loaded,
                    error_message: None,
                })
                .expect("tracking record is attached");
        }

        let window = store
            .query_sheet_rows(
                &SheetRowsQuery {
                    sheet_id: "sheet-1".to_string(),
                    offset: 0,
                    limit: 100,
                    filters: vec![],
                    value_filters: vec![],
                    sort: vec![],
                },
                1_000,
            )
            .expect("10k row window query succeeds");
        assert_eq!(window.total_count, 10_000);
        assert_eq!(window.rows.len(), 100);

        let engine = DuckDbAnalyticsEngine::new(10_000);
        let pivot = engine
            .query_pivot(
                &store,
                &PivotQuery {
                    sheet_id: "sheet-1".to_string(),
                    source_scope: AnalyticsSourceScope::AllRows,
                    filters: vec![],
                    value_filters: vec![],
                    selected_row_ids: vec![],
                    row_fields: vec!["detail.package_detail.jenis_layanan".to_string()],
                    column_fields: vec!["status_akhir.status".to_string()],
                    values: vec![AnalyticsValue {
                        field: "detail.billing_detail.cod_info.total_cod".to_string(),
                        aggregation: AnalyticsAggregation::Sum,
                    }],
                    sort: vec![AnalyticsSort {
                        field: "share".to_string(),
                        direction: AnalyticsSortDirection::Desc,
                    }],
                    limit: 10,
                },
            )
            .expect("10k DuckDB pivot succeeds");

        assert_eq!(pivot.source_row_count, 10_000);
        assert!(!pivot.rows.is_empty());
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "10k query/pivot smoke exceeded 30s"
        );
    }

    fn assert_pivot_row(
        rows: &[serde_json::Value],
        row_value: &str,
        column_value: &str,
        count: u32,
        share: f64,
        metric_key: &str,
        metric_value: f64,
    ) {
        let row = rows
            .iter()
            .find(|row| {
                row["rowValues"] == json!([row_value])
                    && row["columnValues"] == json!([column_value])
            })
            .unwrap_or_else(|| panic!("missing pivot row {row_value}/{column_value}"));

        assert_eq!(row["count"], json!(count));
        assert_eq!(row["share"], json!(share));
        assert_eq!(row["metrics"][metric_key], json!(metric_value));
    }

    fn row_projection(
        row_id: &str,
        tracking_id: &str,
        service: &str,
        status: &str,
        sla_days_diff: i64,
        total_cod: serde_json::Value,
    ) -> SheetRowProjection {
        SheetRowProjection {
            row_id: row_id.to_string(),
            position: 0,
            display_tracking_id: tracking_id.to_string(),
            lookup_tracking_id: tracking_id.to_string(),
            row_status: SheetRowStatus::Loaded,
            error_message: None,
            status_json: Some(json!({
                "status": status,
            })),
            detail_json: Some(json!({
                "shipment_header": {
                    "nomor_kiriman": tracking_id,
                },
                "package_detail": {
                    "jenis_layanan": service,
                },
                "billing_detail": {
                    "cod_info": {
                        "total_cod": total_cod,
                    }
                },
                "performance_detail": {
                    "sla_days_diff": sla_days_diff,
                }
            })),
            history_json: Some(json!({})),
        }
    }

    fn prepared_store() -> SqliteWorkspaceStore {
        let mut store = SqliteWorkspaceStore::open_memory().expect("memory store opens");
        store
            .create_workspace(&CreateWorkspaceInput {
                workspace_id: "workspace-1".to_string(),
                name: "Main workspace".to_string(),
            })
            .expect("workspace is created");
        store
            .create_sheet(&CreateSheetInput {
                sheet_id: "sheet-1".to_string(),
                workspace_id: "workspace-1".to_string(),
                name: "Sheet 1".to_string(),
                position: 0,
            })
            .expect("sheet is created");
        store
    }
}
