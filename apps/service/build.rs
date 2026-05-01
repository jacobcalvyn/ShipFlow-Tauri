#[cfg(windows)]
fn main() {
    let windows_attributes = tauri_build::WindowsAttributes::new()
        .window_icon_path("../../src-tauri/icons/service-icon.ico")
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attributes = tauri_build::Attributes::new().windows_attributes(windows_attributes);

    tauri_build::try_build(attributes).expect("failed to build ShipFlow Service Tauri context");
}

#[cfg(not(windows))]
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new())
        .expect("failed to build ShipFlow Service Tauri context");
}
