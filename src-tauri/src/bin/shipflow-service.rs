fn main() {
    if shipflow3_tauri_lib::maybe_run_service_tray_from_current_args()
        .expect("failed to initialize ShipFlow service tray companion")
    {
        return;
    }

    let did_run = shipflow3_tauri_lib::maybe_run_service_process_from_current_args()
        .expect("failed to initialize ShipFlow service companion");

    if did_run {
        return;
    }

    if shipflow3_tauri_lib::maybe_delegate_to_existing_service_settings_process()
        .expect("failed to delegate to existing ShipFlow Service settings process")
    {
        return;
    }

    shipflow3_tauri_lib::run_service_settings();
}
