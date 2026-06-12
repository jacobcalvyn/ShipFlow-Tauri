use shipflow_tauri_runtime::pod_preview::resolve_pod_image_source;

#[tauri::command]
pub async fn resolve_pod_image(image_source: String) -> Result<String, String> {
    resolve_pod_image_source(image_source.trim(), 0).await
}
