#[cfg(windows)]
fn main() {
    let mut resource = tauri_winres::WindowsResource::new();
    resource
        .set_icon("../../src-tauri/icons/service-icon.ico")
        .set_manifest(include_str!("windows-app-manifest.xml"))
        .set("ProductName", "ShipFlow Service")
        .set("FileDescription", "Standalone ShipFlow Service");

    resource
        .compile()
        .expect("failed to embed ShipFlow Service Windows resources");
}

#[cfg(not(windows))]
fn main() {}
