use std::{
    env,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::{Path as FsPath, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(not(target_os = "windows"))]
use std::fs;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use base64::Engine as _;

use super::{
    state_store::{
        clear_recorded_pid, clear_recorded_tray_pid, clear_runtime_config,
        persist_service_tray_pid, read_recorded_pid, read_recorded_tray_pid,
    },
    ApiServiceConfig, ApiServiceMode, ApiServiceStatus, ApiServiceStatusKind,
    DESKTOP_BINARY_BASENAME, DESKTOP_PRODUCT_BASENAME, SERVICE_COMPANION_BINARY_BASENAME,
    SERVICE_PROCESS_FLAG, SERVICE_STATUS_PRODUCT, SERVICE_TRAY_FLAG,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn prepare_background_command(_command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub(crate) fn spawn_service_process(config: &ApiServiceConfig) -> Result<u32, String> {
    let executable = resolve_service_companion_executable()?;
    let encoded_config = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(config)
            .map_err(|error| format!("Unable to serialize API service configuration: {error}"))?,
    );

    let mut command = Command::new(executable);
    prepare_background_command(&mut command);
    let child = command
        .arg(SERVICE_PROCESS_FLAG)
        .arg(super::SERVICE_CONFIG_ARG)
        .arg(encoded_config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch API service companion: {error}"))?;

    Ok(child.id())
}

fn ensure_service_tray_process_running() -> Result<(), String> {
    if read_recorded_tray_pid()
        .is_some_and(|pid| is_expected_service_process(pid, SERVICE_TRAY_FLAG))
    {
        return Ok(());
    }

    let pid = spawn_service_tray_process()?;
    persist_service_tray_pid(pid)
}

fn spawn_service_tray_process() -> Result<u32, String> {
    let executable = resolve_service_companion_executable()?;
    let mut command = Command::new(executable);
    prepare_background_command(&mut command);
    let child = command
        .arg(SERVICE_TRAY_FLAG)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch API service tray companion: {error}"))?;

    Ok(child.id())
}

fn launch_shipflow_service_settings() -> Result<(), String> {
    let executable = resolve_service_companion_executable()?;
    let mut command = Command::new(executable);
    prepare_background_command(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch ShipFlow Service: {error}"))?;
    Ok(())
}

pub fn launch_shipflow_service_app() -> Result<(), String> {
    launch_shipflow_service_settings()
}

fn resolve_service_companion_executable() -> Result<PathBuf, String> {
    let current_executable = env::current_exe()
        .map_err(|error| format!("Unable to resolve ShipFlow executable path: {error}"))?;

    for candidate in service_companion_candidates(&current_executable) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Ok(current_executable)
}

fn resolve_desktop_companion_executable() -> Result<PathBuf, String> {
    let current_executable = env::current_exe()
        .map_err(|error| format!("Unable to resolve ShipFlow executable path: {error}"))?;

    for candidate in desktop_companion_candidates(&current_executable) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Ok(current_executable)
}

fn service_companion_candidates(current_executable: &FsPath) -> Vec<PathBuf> {
    let Some(parent_dir) = current_executable.parent() else {
        return Vec::new();
    };

    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    {
        candidates.push(parent_dir.join(format!("{SERVICE_COMPANION_BINARY_BASENAME}.exe")));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(parent_dir.join(SERVICE_COMPANION_BINARY_BASENAME));
    }

    candidates
}

fn desktop_companion_candidates(current_executable: &FsPath) -> Vec<PathBuf> {
    let Some(parent_dir) = current_executable.parent() else {
        return Vec::new();
    };

    let mut candidates = Vec::new();

    #[cfg(target_os = "windows")]
    {
        candidates.push(parent_dir.join(format!("{DESKTOP_BINARY_BASENAME}.exe")));
        candidates.push(parent_dir.join(format!("{DESKTOP_PRODUCT_BASENAME}.exe")));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(parent_dir.join(DESKTOP_BINARY_BASENAME));
        candidates.push(parent_dir.join(DESKTOP_PRODUCT_BASENAME));
    }

    candidates
}

fn launch_shipflow_desktop() -> Result<(), String> {
    let executable = resolve_desktop_companion_executable()?;
    let mut command = Command::new(executable);
    prepare_background_command(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch ShipFlow Desktop: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn service_tray_autostart_command() -> Result<String, String> {
    let executable = resolve_service_companion_executable()?;
    Ok(format!(
        "\"{}\" {}",
        executable.to_string_lossy(),
        SERVICE_TRAY_FLAG
    ))
}

fn sync_service_tray_autostart(config: &ApiServiceConfig) -> Result<(), String> {
    if config.enabled && config.keep_running_in_tray {
        enable_service_tray_autostart()
    } else {
        disable_service_tray_autostart()
    }
}

fn enable_service_tray_autostart() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let launch_agents_dir = home_dir.join("Library/LaunchAgents");
        fs::create_dir_all(&launch_agents_dir)
            .map_err(|error| format!("Unable to create LaunchAgents directory: {error}"))?;
        let plist_path = launch_agents_dir.join("com.shipflow.service-tray.plist");
        let executable = resolve_service_companion_executable()?;
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.shipflow.service-tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
            xml_escape(&executable.to_string_lossy()),
            SERVICE_TRAY_FLAG
        );
        fs::write(plist_path, plist)
            .map_err(|error| format!("Unable to write LaunchAgent plist: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let command = service_tray_autostart_command()?;
        let mut registry_command = Command::new("reg");
        prepare_background_command(&mut registry_command);
        let status = registry_command
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "ShipFlowServiceTray",
                "/t",
                "REG_SZ",
                "/d",
                &command,
                "/f",
            ])
            .status()
            .map_err(|error| format!("Unable to configure Windows autostart: {error}"))?;

        if !status.success() {
            return Err("Windows autostart command failed.".into());
        }
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let autostart_dir = home_dir.join(".config/autostart");
        fs::create_dir_all(&autostart_dir)
            .map_err(|error| format!("Unable to create autostart directory: {error}"))?;
        let desktop_path = autostart_dir.join("shipflow-service-tray.desktop");
        let executable = resolve_service_companion_executable()?;
        let desktop_file = format!(
            "[Desktop Entry]\nType=Application\nName=ShipFlow Service Tray\nExec=\"{}\" {}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n",
            executable.to_string_lossy(),
            SERVICE_TRAY_FLAG
        );
        fs::write(desktop_path, desktop_file)
            .map_err(|error| format!("Unable to write autostart desktop entry: {error}"))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

fn disable_service_tray_autostart() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let plist_path = home_dir.join("Library/LaunchAgents/com.shipflow.service-tray.plist");
        if plist_path.exists() {
            fs::remove_file(plist_path)
                .map_err(|error| format!("Unable to remove LaunchAgent plist: {error}"))?;
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let mut registry_command = Command::new("reg");
        prepare_background_command(&mut registry_command);
        let _ = registry_command
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "ShipFlowServiceTray",
                "/f",
            ])
            .status();
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let desktop_path = home_dir.join(".config/autostart/shipflow-service-tray.desktop");
        if desktop_path.exists() {
            fs::remove_file(desktop_path)
                .map_err(|error| format!("Unable to remove autostart desktop entry: {error}"))?;
        }
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(crate) fn stop_service_process() {
    if let Some(pid) = read_recorded_pid() {
        if is_expected_service_process(pid, SERVICE_PROCESS_FLAG) {
            let _ = terminate_process(pid);
        }
    }

    clear_recorded_pid();
    clear_runtime_config();
}

pub(crate) fn stop_service_tray_process() {
    if let Some(pid) = read_recorded_tray_pid() {
        if is_expected_service_process(pid, SERVICE_TRAY_FLAG) {
            let _ = terminate_process(pid);
        }
    }

    clear_recorded_tray_pid();
}

fn process_command_line(pid: u32) -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell");
        prepare_background_command(&mut command);
        let output = command
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" | Select-Object -ExpandProperty CommandLine"
                ),
            ])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return (!value.is_empty()).then_some(value);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "command="])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return (!value.is_empty()).then_some(value);
    }
}

fn command_line_matches_service_process(command_line: &str, required_flag: &str) -> bool {
    let normalized = command_line.to_ascii_lowercase();
    let has_expected_binary =
        command_line_contains_binary(&normalized, SERVICE_COMPANION_BINARY_BASENAME)
            || command_line_contains_binary(&normalized, DESKTOP_BINARY_BASENAME)
            || command_line_contains_binary(&normalized, DESKTOP_PRODUCT_BASENAME);

    has_expected_binary && command_line.contains(required_flag)
}

fn command_line_contains_binary(normalized_command_line: &str, binary_name: &str) -> bool {
    let binary_name = binary_name.to_ascii_lowercase();
    normalized_command_line.starts_with(&binary_name)
        || normalized_command_line.contains(&format!(" {binary_name}"))
        || normalized_command_line.contains(&format!("\"{binary_name}"))
        || normalized_command_line.contains(&format!("/{binary_name}"))
        || normalized_command_line.contains(&format!("\\{binary_name}"))
}

pub(crate) fn is_expected_service_process(pid: u32, required_flag: &str) -> bool {
    is_process_alive(pid)
        && process_command_line(pid)
            .as_deref()
            .is_some_and(|command_line| {
                command_line_matches_service_process(command_line, required_flag)
            })
}

fn terminate_process(pid: u32) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut taskkill_command = Command::new("taskkill");
        prepare_background_command(&mut taskkill_command);
        let status = taskkill_command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .map_err(|error| format!("Unable to terminate API service companion: {error}"))?;

        if !status.success() {
            return Err("Unable to terminate API service companion.".into());
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let status = Command::new("kill")
            .arg(pid.to_string())
            .status()
            .map_err(|error| format!("Unable to terminate API service companion: {error}"))?;

        if !status.success() {
            return Err("Unable to terminate API service companion.".into());
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if !is_process_alive(pid) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(75));
        }

        let force_status = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .map_err(|error| format!("Unable to force-stop API service companion: {error}"))?;

        if !force_status.success() {
            return Err("Unable to force-stop API service companion.".into());
        }
    }

    Ok(())
}

pub(crate) fn is_process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut tasklist_command = Command::new("tasklist");
        prepare_background_command(&mut tasklist_command);
        return tasklist_command
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout.contains(&pid.to_string())
            })
            .unwrap_or(false);
    }

    #[cfg(not(target_os = "windows"))]
    {
        return Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
    }
}

fn service_probe_socket_addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

fn read_authenticated_service_status(
    port: u16,
    auth_token: &str,
    timeout: Duration,
) -> Result<String, String> {
    let trimmed_token = auth_token.trim();
    if trimmed_token.is_empty() {
        return Err("Service status probe requires an auth token.".into());
    }

    let mut stream = TcpStream::connect_timeout(&service_probe_socket_addr(port), timeout)
        .map_err(|error| {
            format!("Unable to connect to ShipFlow Service status endpoint: {error}")
        })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let request = format!(
        "GET /status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {trimmed_token}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("Unable to write ShipFlow Service status probe: {error}"))?;

    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("Unable to read ShipFlow Service status probe: {error}"))?;
    Ok(response)
}

fn authenticated_service_status_is_valid(response: &str) -> bool {
    let mut parts = response.splitn(2, "\r\n\r\n");
    let headers = parts.next().unwrap_or_default();
    let body = parts.next().unwrap_or_default().trim();

    let status_line = headers.lines().next().unwrap_or_default();
    if !status_line.contains(" 200 ") {
        return false;
    }

    let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };

    payload.get("service").and_then(|value| value.as_str()) == Some("running")
        && payload.get("product").and_then(|value| value.as_str()) == Some(SERVICE_STATUS_PRODUCT)
}

pub(crate) fn is_service_runtime_ready(config: &ApiServiceConfig, timeout: Duration) -> bool {
    read_authenticated_service_status(config.port, &config.auth_token, timeout)
        .map(|response| authenticated_service_status_is_valid(&response))
        .unwrap_or(false)
}

pub(crate) fn wait_for_service_runtime(config: &ApiServiceConfig, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if is_service_runtime_ready(config, Duration::from_millis(250)) {
            return true;
        }
        thread::sleep(Duration::from_millis(75));
    }
    false
}

pub fn sync_service_tray_companion(config: &ApiServiceConfig) -> Result<(), String> {
    sync_service_tray_autostart(config)?;

    if config.enabled && config.keep_running_in_tray {
        ensure_service_tray_process_running()
    } else {
        stop_service_tray_process();
        Ok(())
    }
}

pub(crate) fn build_service_endpoint(
    config: &ApiServiceConfig,
    status: &ApiServiceStatus,
) -> String {
    let port = status.port.unwrap_or(config.port);
    let mode = status.mode.clone().unwrap_or_else(|| config.mode.clone());

    match mode {
        ApiServiceMode::Local => format!("http://127.0.0.1:{port}"),
        ApiServiceMode::Lan => format!(
            "http://{}:{port}",
            status.bind_address.as_deref().unwrap_or("0.0.0.0")
        ),
    }
}

pub(crate) fn format_service_status_label(
    config: &ApiServiceConfig,
    status: &ApiServiceStatus,
) -> String {
    if !config.enabled {
        return "API Off".into();
    }

    match status.status {
        ApiServiceStatusKind::Running => {
            let mode = status.mode.clone().unwrap_or_else(|| config.mode.clone());
            let port = status.port.unwrap_or(config.port);
            match mode {
                ApiServiceMode::Local => format!("API Local :{port}"),
                ApiServiceMode::Lan => format!("API LAN :{port}"),
            }
        }
        ApiServiceStatusKind::Error => {
            let port = status.port.unwrap_or(config.port);
            format!("API Error :{port}")
        }
        ApiServiceStatusKind::Stopped => "API Off".into(),
    }
}

pub(crate) fn launch_shipflow_desktop_companion() -> Result<(), String> {
    launch_shipflow_desktop()
}

pub(crate) fn launch_shipflow_service_settings_companion() -> Result<(), String> {
    launch_shipflow_service_settings()
}

#[cfg(test)]
mod tests {
    use super::{
        authenticated_service_status_is_valid, build_service_endpoint,
        command_line_matches_service_process, format_service_status_label, ApiServiceConfig,
        ApiServiceMode, ApiServiceStatus, ApiServiceStatusKind,
    };
    use crate::tracking::model::TrackingSource;

    fn sample_config() -> ApiServiceConfig {
        ApiServiceConfig {
            version: 1,
            enabled: true,
            mode: ApiServiceMode::Local,
            port: 18422,
            auth_token: "sf_process_runtime_token".into(),
            tracking_source: TrackingSource::Default,
            external_api_base_url: String::new(),
            external_api_auth_token: String::new(),
            allow_insecure_external_api_http: false,
            keep_running_in_tray: true,
            last_updated_at: "2026-04-21T00:00:00.000Z".into(),
        }
    }

    fn sample_status() -> ApiServiceStatus {
        ApiServiceStatus {
            status: ApiServiceStatusKind::Running,
            enabled: true,
            mode: Some(ApiServiceMode::Local),
            bind_address: Some("127.0.0.1".into()),
            port: Some(19422),
            error_message: None,
        }
    }

    #[test]
    fn build_service_endpoint_uses_status_mode_and_port() {
        let endpoint = build_service_endpoint(&sample_config(), &sample_status());

        assert_eq!(endpoint, "http://127.0.0.1:19422");
    }

    #[test]
    fn build_service_endpoint_uses_bind_address_for_lan_mode() {
        let endpoint = build_service_endpoint(
            &sample_config(),
            &ApiServiceStatus {
                mode: Some(ApiServiceMode::Lan),
                bind_address: Some("192.168.1.24".into()),
                ..sample_status()
            },
        );

        assert_eq!(endpoint, "http://192.168.1.24:19422");
    }

    #[test]
    fn status_label_reports_local_running_state() {
        let label = format_service_status_label(&sample_config(), &sample_status());

        assert_eq!(label, "API Local :19422");
    }

    #[test]
    fn status_label_reports_error_port_when_service_fails() {
        let label = format_service_status_label(
            &sample_config(),
            &ApiServiceStatus {
                status: ApiServiceStatusKind::Error,
                port: Some(20001),
                ..sample_status()
            },
        );

        assert_eq!(label, "API Error :20001");
    }

    #[test]
    fn status_label_returns_off_when_config_is_disabled() {
        let label = format_service_status_label(
            &ApiServiceConfig {
                enabled: false,
                ..sample_config()
            },
            &sample_status(),
        );

        assert_eq!(label, "API Off");
    }

    #[test]
    fn service_process_command_line_requires_shipflow_binary_and_flag() {
        assert!(command_line_matches_service_process(
            "/Applications/ShipFlow Desktop.app/Contents/MacOS/shipflow-service --shipflow-service-process",
            super::SERVICE_PROCESS_FLAG
        ));
        assert!(!command_line_matches_service_process(
            "/usr/bin/python other.py --shipflow-service-process",
            super::SERVICE_PROCESS_FLAG
        ));
    }

    #[test]
    fn authenticated_status_probe_requires_shipflow_identity() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n",
            r#"{"service":"running","product":"shipflow-service","mode":"local","port":18422}"#
        );

        assert!(authenticated_service_status_is_valid(response));
        assert!(!authenticated_service_status_is_valid(
            "HTTP/1.1 200 OK\r\n\r\n{\"service\":\"running\"}"
        ));
        assert!(!authenticated_service_status_is_valid(
            "HTTP/1.1 401 Unauthorized\r\n\r\n{\"error\":\"bad token\"}"
        ));
    }
}
