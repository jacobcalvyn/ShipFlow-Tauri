#![allow(dead_code)]

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
    SERVICE_OPEN_SETTINGS_FLAG, SERVICE_PROCESS_FLAG, SERVICE_STATUS_PRODUCT, SERVICE_TRAY_FLAG,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const SERVICE_PRODUCT_BASENAME: &str = "ShipFlow Service";

fn prepare_background_command(_command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

pub fn spawn_service_process(config: &ApiServiceConfig) -> Result<u32, String> {
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

pub fn ensure_service_tray_process_running() -> Result<(), String> {
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
        .arg(SERVICE_OPEN_SETTINGS_FLAG)
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

    if executable_name_matches(
        &current_executable,
        &[SERVICE_COMPANION_BINARY_BASENAME, SERVICE_PRODUCT_BASENAME],
    ) {
        return Ok(current_executable);
    }

    Err("Unable to find the installed ShipFlow Service app. Install ShipFlow Service or run the service app before opening it from Desktop.".into())
}

fn resolve_desktop_companion_executable() -> Result<PathBuf, String> {
    let current_executable = env::current_exe()
        .map_err(|error| format!("Unable to resolve ShipFlow executable path: {error}"))?;

    for candidate in desktop_companion_candidates(&current_executable) {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    if executable_name_matches(
        &current_executable,
        &[DESKTOP_BINARY_BASENAME, DESKTOP_PRODUCT_BASENAME],
    ) {
        return Ok(current_executable);
    }

    Err("Unable to find the installed ShipFlow Desktop app. Install ShipFlow Desktop before opening it from the Service tray.".into())
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

    candidates.extend(installed_service_companion_candidates(current_executable));

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

    candidates.extend(installed_desktop_companion_candidates(current_executable));

    candidates
}

fn executable_name_matches(path: &FsPath, expected_basenames: &[&str]) -> bool {
    let Some(file_name) = path
        .file_stem()
        .or_else(|| path.file_name())
        .and_then(|value| value.to_str())
    else {
        return false;
    };
    let normalized_file_name = file_name.to_ascii_lowercase();

    expected_basenames
        .iter()
        .any(|basename| normalized_file_name == basename.to_ascii_lowercase())
}

fn installed_service_companion_candidates(current_executable: &FsPath) -> Vec<PathBuf> {
    installed_app_executable_candidates(
        current_executable,
        SERVICE_PRODUCT_BASENAME,
        &[SERVICE_COMPANION_BINARY_BASENAME],
    )
}

fn installed_desktop_companion_candidates(current_executable: &FsPath) -> Vec<PathBuf> {
    installed_app_executable_candidates(
        current_executable,
        DESKTOP_PRODUCT_BASENAME,
        &[DESKTOP_BINARY_BASENAME, DESKTOP_PRODUCT_BASENAME],
    )
}

fn installed_app_executable_candidates(
    current_executable: &FsPath,
    product_name: &str,
    binary_names: &[&str],
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(not(target_os = "macos"))]
    let _ = current_executable;

    #[cfg(target_os = "macos")]
    {
        if let Some(sibling_app_dir) = macos_sibling_app_dir(current_executable, product_name) {
            candidates.extend(macos_app_executables(sibling_app_dir, binary_names));
        }

        candidates.extend(macos_app_executables(
            PathBuf::from("/Applications").join(format!("{product_name}.app")),
            binary_names,
        ));

        if let Some(home_dir) = env::var_os("HOME").map(PathBuf::from) {
            candidates.extend(macos_app_executables(
                home_dir
                    .join("Applications")
                    .join(format!("{product_name}.app")),
                binary_names,
            ));
        }
    }

    #[cfg(target_os = "windows")]
    {
        for install_dir in windows_install_dirs(product_name) {
            for binary_name in binary_names {
                candidates.push(install_dir.join(format!("{binary_name}.exe")));
            }
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for binary_name in binary_names {
            candidates.push(PathBuf::from("/usr/local/bin").join(binary_name));
            candidates.push(PathBuf::from("/usr/bin").join(binary_name));
        }
    }

    candidates
}

#[cfg(target_os = "macos")]
fn macos_sibling_app_dir(current_executable: &FsPath, product_name: &str) -> Option<PathBuf> {
    current_executable.ancestors().find_map(|ancestor| {
        let is_app_bundle = ancestor
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
        if !is_app_bundle {
            return None;
        }

        ancestor
            .parent()
            .map(|apps_dir| apps_dir.join(format!("{product_name}.app")))
    })
}

#[cfg(target_os = "macos")]
fn macos_app_executables(app_dir: PathBuf, binary_names: &[&str]) -> Vec<PathBuf> {
    binary_names
        .iter()
        .map(|binary_name| app_dir.join("Contents/MacOS").join(binary_name))
        .collect()
}

#[cfg(target_os = "windows")]
fn windows_install_dirs(product_name: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local_app_data.join("Programs").join(product_name));
        dirs.push(local_app_data.join(product_name));
    }

    if let Some(program_files) = env::var_os("ProgramFiles").map(PathBuf::from) {
        dirs.push(program_files.join(product_name));
    }

    if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)").map(PathBuf::from) {
        dirs.push(program_files_x86.join(product_name));
    }

    dirs
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
    if config.enabled
        && config.keep_running_in_tray
        && !config.uses_custom_desktop_service_connection()
    {
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

pub fn stop_service_process() {
    if let Some(pid) = read_recorded_pid() {
        if is_expected_service_process(pid, SERVICE_PROCESS_FLAG) {
            let _ = terminate_process(pid);
        }
    }

    clear_recorded_pid();
    clear_runtime_config();
}

pub fn stop_service_tray_process() {
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
        (!value.is_empty()).then_some(value)
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
        (!value.is_empty()).then_some(value)
    }
}

fn command_line_matches_service_process(command_line: &str, required_flag: &str) -> bool {
    command_line_matches_shipflow_binary(command_line) && command_line.contains(required_flag)
}

fn command_line_matches_service_settings_process(command_line: &str) -> bool {
    command_line_matches_shipflow_binary(command_line)
        && !command_line.contains(SERVICE_PROCESS_FLAG)
        && !command_line.contains(SERVICE_TRAY_FLAG)
}

fn command_line_matches_shipflow_binary(command_line: &str) -> bool {
    let normalized = command_line.to_ascii_lowercase();
    command_line_contains_binary(&normalized, SERVICE_COMPANION_BINARY_BASENAME)
        || command_line_contains_binary(&normalized, DESKTOP_BINARY_BASENAME)
        || command_line_contains_binary(&normalized, DESKTOP_PRODUCT_BASENAME)
}

fn command_line_contains_binary(normalized_command_line: &str, binary_name: &str) -> bool {
    let binary_name = binary_name.to_ascii_lowercase();
    normalized_command_line.starts_with(&binary_name)
        || normalized_command_line.contains(&format!(" {binary_name}"))
        || normalized_command_line.contains(&format!("\"{binary_name}"))
        || normalized_command_line.contains(&format!("/{binary_name}"))
        || normalized_command_line.contains(&format!("\\{binary_name}"))
}

pub fn is_expected_service_process(pid: u32, required_flag: &str) -> bool {
    is_process_alive(pid)
        && process_command_line(pid)
            .as_deref()
            .is_some_and(|command_line| {
                command_line_matches_service_process(command_line, required_flag)
            })
}

pub fn is_expected_service_settings_process(pid: u32) -> bool {
    is_process_alive(pid)
        && process_command_line(pid)
            .as_deref()
            .is_some_and(command_line_matches_service_settings_process)
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

pub fn is_process_alive(pid: u32) -> bool {
    #[cfg(target_os = "windows")]
    {
        let mut tasklist_command = Command::new("tasklist");
        prepare_background_command(&mut tasklist_command);
        tasklist_command
            .args(["/FI", &format!("PID eq {pid}")])
            .output()
            .map(|output| {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout.contains(&pid.to_string())
            })
            .unwrap_or(false)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
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

pub fn is_service_runtime_ready(config: &ApiServiceConfig, timeout: Duration) -> bool {
    read_authenticated_service_status(config.port, &config.auth_token, timeout)
        .map(|response| authenticated_service_status_is_valid(&response))
        .unwrap_or(false)
}

pub fn wait_for_service_runtime(config: &ApiServiceConfig, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if is_service_runtime_ready(config, Duration::from_millis(250)) {
            return true;
        }
        thread::sleep(Duration::from_millis(75));
    }
    false
}

fn should_keep_service_tray_companion(config: &ApiServiceConfig) -> bool {
    config.keep_running_in_tray && !config.uses_custom_desktop_service_connection()
}

pub fn sync_service_tray_companion(config: &ApiServiceConfig) -> Result<(), String> {
    sync_service_tray_autostart(config)?;

    if should_keep_service_tray_companion(config) {
        ensure_service_tray_process_running()
    } else {
        stop_service_tray_process();
        Ok(())
    }
}

pub fn build_service_endpoint(config: &ApiServiceConfig, status: &ApiServiceStatus) -> String {
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

pub fn format_service_status_label(config: &ApiServiceConfig, status: &ApiServiceStatus) -> String {
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

pub fn launch_shipflow_desktop_companion() -> Result<(), String> {
    launch_shipflow_desktop()
}

pub fn launch_shipflow_service_settings_companion() -> Result<(), String> {
    launch_shipflow_service_settings()
}

#[cfg(test)]
mod tests {
    use super::{
        authenticated_service_status_is_valid, build_service_endpoint,
        command_line_matches_service_process, command_line_matches_service_settings_process,
        format_service_status_label, should_keep_service_tray_companion, ApiServiceConfig,
        ApiServiceMode, ApiServiceStatus, ApiServiceStatusKind,
    };
    use crate::service::DesktopServiceConnectionMode;
    use crate::tracking::model::TrackingSource;

    fn sample_config() -> ApiServiceConfig {
        ApiServiceConfig {
            version: 1,
            desktop_connection_mode: DesktopServiceConnectionMode::ManagedLocal,
            desktop_service_url: "http://127.0.0.1:18422".into(),
            desktop_service_auth_token: String::new(),
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
    fn tray_companion_stays_available_when_api_is_off_but_keep_running_is_enabled() {
        let config = ApiServiceConfig {
            enabled: false,
            keep_running_in_tray: true,
            ..sample_config()
        };

        assert!(should_keep_service_tray_companion(&config));
    }

    #[test]
    fn tray_companion_stops_when_keep_running_is_disabled() {
        let config = ApiServiceConfig {
            keep_running_in_tray: false,
            ..sample_config()
        };

        assert!(!should_keep_service_tray_companion(&config));
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
    fn service_settings_command_line_rejects_background_service_flags() {
        assert!(command_line_matches_service_settings_process(
            r#""C:\Program Files\ShipFlow Service\shipflow-service.exe""#
        ));
        assert!(command_line_matches_service_settings_process(
            r#""C:\Program Files\ShipFlow Service\shipflow-service.exe" --shipflow-service-open-settings"#
        ));
        assert!(!command_line_matches_service_settings_process(
            r#""C:\Program Files\ShipFlow Service\shipflow-service.exe" --shipflow-service-process"#
        ));
        assert!(!command_line_matches_service_settings_process(
            r#""C:\Program Files\ShipFlow Service\shipflow-service.exe" --shipflow-service-tray"#
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
