#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if shipflow3_tauri_lib::maybe_run_service_tray_from_current_args()
        .expect("failed to initialize ShipFlow service tray process")
    {
        return;
    }

    if shipflow3_tauri_lib::maybe_run_service_process_from_current_args()
        .expect("failed to initialize ShipFlow service process")
    {
        return;
    }

    if shipflow3_tauri_lib::maybe_delegate_to_existing_desktop_process()
        .expect("failed to delegate to existing ShipFlow Desktop process")
    {
        return;
    }

    shipflow3_tauri_lib::run()
}
