#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    shipflow3_tauri_lib::install_runtime_logging();

    if shipflow3_tauri_lib::maybe_delegate_to_existing_desktop_process()
        .expect("failed to delegate to existing ShipFlow Desktop process")
    {
        return;
    }

    shipflow3_tauri_lib::run()
}
