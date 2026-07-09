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

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
    System::Threading::CreateMutexW,
};

use super::{
    state_store::{
        claim_service_tray_launch_lock, clear_desktop_activation_request,
        clear_recorded_desktop_pid, clear_recorded_pid, clear_recorded_service_settings_pid,
        clear_recorded_tray_pid, clear_runtime_config, clear_service_settings_activation_request,
        clear_service_tray_launch_lock, desktop_activation_request_exists,
        persist_desktop_activation_request, persist_desktop_pid,
        persist_service_settings_activation_request, persist_service_settings_pid,
        persist_service_tray_pid, read_recorded_desktop_pid, read_recorded_pid,
        read_recorded_service_settings_pid, read_recorded_tray_pid,
        service_settings_activation_request_exists,
    },
    ApiServiceConfig, ApiServiceMode, ApiServiceStatus, ApiServiceStatusKind,
    DesktopActivationRequest, DESKTOP_BINARY_BASENAME, DESKTOP_PRODUCT_BASENAME,
    SERVICE_AUTOSTART_FLAG, SERVICE_COMPANION_BINARY_BASENAME, SERVICE_OPEN_SETTINGS_FLAG,
    SERVICE_PROCESS_FLAG, SERVICE_STATUS_PRODUCT, SERVICE_TRAY_FLAG,
};
use crate::runtime_log::log_runtime_event;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const WINDOWS_SHIPFLOW_ROOT: &str = r"C:\ShipFlow";
#[cfg(target_os = "windows")]
const WINDOWS_SHIPFLOW_REGISTRY_ROOT: &str = r"HKLM\Software\ShipFlow";

const SERVICE_PRODUCT_BASENAME: &str = "ShipFlow Service";
const DESKTOP_BUNDLE_IDENTIFIER: &str = "com.shipflow.desktop";
const SERVICE_BUNDLE_IDENTIFIER: &str = "com.shipflow.service";
const SERVICE_LOGIN_LAUNCH_AGENT_LABEL: &str = "com.shipflow.service-login";
const SERVICE_TRAY_LAUNCH_AGENT_LABEL: &str = "com.shipflow.service-tray";
const SERVICE_LOGIN_AUTOSTART_REGISTRY_VALUE: &str = "ShipFlowService";
const SERVICE_TRAY_LEGACY_AUTOSTART_REGISTRY_VALUE: &str = "ShipFlowServiceTray";
const DESKTOP_UI_MUTEX_NAME: &str = "Local\\ShipFlow.Desktop.UI";
const SERVICE_SETTINGS_UI_MUTEX_NAME: &str = "Local\\ShipFlow.Service.Settings.UI";
const SERVICE_TRAY_UI_MUTEX_NAME: &str = "Local\\ShipFlow.Service.Tray.UI";

#[cfg(target_os = "windows")]
static DESKTOP_UI_MUTEX_GUARD: OnceLock<WindowsNamedMutexGuard> = OnceLock::new();
#[cfg(target_os = "windows")]
static SERVICE_SETTINGS_UI_MUTEX_GUARD: OnceLock<WindowsNamedMutexGuard> = OnceLock::new();
#[cfg(target_os = "windows")]
static SERVICE_TRAY_UI_MUTEX_GUARD: OnceLock<WindowsNamedMutexGuard> = OnceLock::new();

#[cfg(target_os = "windows")]
struct WindowsNamedMutexGuard(HANDLE);

#[cfg(target_os = "windows")]
unsafe impl Send for WindowsNamedMutexGuard {}
#[cfg(target_os = "windows")]
unsafe impl Sync for WindowsNamedMutexGuard {}

#[cfg(target_os = "windows")]
impl Drop for WindowsNamedMutexGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn prepare_background_command(_command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        _command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(unix)]
    {
        _command.process_group(0);
    }
}

#[cfg(target_os = "windows")]
fn claim_windows_named_mutex(
    guard: &'static OnceLock<WindowsNamedMutexGuard>,
    name: &str,
) -> Result<bool, String> {
    if guard.get().is_some() {
        return Ok(true);
    }

    let wide_name = name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide_name.as_ptr()) };
    if handle.is_null() {
        return Err(format!(
            "Unable to create Windows single-instance mutex '{name}': {}",
            std::io::Error::last_os_error()
        ));
    }

    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Ok(false);
    }

    let mutex_guard = WindowsNamedMutexGuard(handle);
    if guard.set(mutex_guard).is_err() {
        return Ok(true);
    }

    Ok(true)
}

pub(super) fn claim_desktop_ui_single_instance() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        claim_windows_named_mutex(&DESKTOP_UI_MUTEX_GUARD, DESKTOP_UI_MUTEX_NAME)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(true)
    }
}

pub(super) fn claim_service_settings_ui_single_instance() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        claim_windows_named_mutex(
            &SERVICE_SETTINGS_UI_MUTEX_GUARD,
            SERVICE_SETTINGS_UI_MUTEX_NAME,
        )
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(true)
    }
}

pub(super) fn claim_service_tray_ui_single_instance() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        claim_windows_named_mutex(&SERVICE_TRAY_UI_MUTEX_GUARD, SERVICE_TRAY_UI_MUTEX_NAME)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(true)
    }
}

pub fn claim_current_service_tray_process() -> Result<bool, String> {
    if read_recorded_tray_pid()
        .is_some_and(|pid| is_expected_service_process(pid, SERVICE_TRAY_FLAG))
    {
        log_runtime_event(
            "INFO",
            "[ShipFlowServiceTray] duplicate tray launch skipped because an existing tray companion is registered",
        );
        return Ok(false);
    }

    if !claim_service_tray_ui_single_instance()? {
        log_runtime_event(
            "INFO",
            "[ShipFlowServiceTray] duplicate tray launch skipped by native single-instance guard",
        );
        return Ok(false);
    }

    persist_service_tray_pid(std::process::id())?;
    Ok(true)
}

pub(super) fn request_desktop_activation_and_wait() -> Result<(), String> {
    persist_desktop_activation_request(&DesktopActivationRequest {
        focus_main_window: true,
    })?;
    request_macos_bundle_activation(DESKTOP_BUNDLE_IDENTIFIER);

    if wait_for_desktop_activation_request_consumed(Duration::from_secs(3)) {
        log_runtime_event(
            "INFO",
            "[ShipFlowDesktopLaunch] activation request consumed by existing desktop process",
        );
    } else {
        clear_desktop_activation_request();
        log_runtime_event(
            "ERROR",
            "[ShipFlowDesktopLaunch] existing desktop process did not consume activation request before timeout",
        );
    }

    Ok(())
}

pub(super) fn request_service_settings_activation_and_wait(
    focus_window: bool,
) -> Result<(), String> {
    persist_service_settings_activation_request(&DesktopActivationRequest {
        focus_main_window: focus_window,
    })?;
    if focus_window {
        request_macos_bundle_activation(SERVICE_BUNDLE_IDENTIFIER);
    }

    if wait_for_service_settings_activation_request_consumed(Duration::from_secs(3)) {
        log_runtime_event(
            "INFO",
            "[ShipFlowServiceLaunch] activation request consumed by existing service settings process",
        );
    } else {
        clear_service_settings_activation_request();
        log_runtime_event(
            "ERROR",
            "[ShipFlowServiceLaunch] existing service settings process did not consume activation request before timeout",
        );
    }

    Ok(())
}

pub fn spawn_service_process(_config: &ApiServiceConfig) -> Result<u32, String> {
    let executable = resolve_service_companion_executable()?;
    let mut command = Command::new(executable);
    prepare_background_command(&mut command);
    let child = command
        .arg(SERVICE_PROCESS_FLAG)
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

    let _launch_guard = match claim_service_tray_launch_lock()? {
        Some(guard) => guard,
        None => {
            if wait_for_service_tray_process_registered(Duration::from_secs(3)).is_some() {
                return Ok(());
            }

            clear_service_tray_launch_lock();
            claim_service_tray_launch_lock()?.ok_or_else(|| {
                "Unable to claim API service tray launch lock after stale lock cleanup.".to_string()
            })?
        }
    };

    if read_recorded_tray_pid()
        .is_some_and(|pid| is_expected_service_process(pid, SERVICE_TRAY_FLAG))
    {
        return Ok(());
    }

    let pid = spawn_service_tray_process()?;
    if wait_for_service_tray_process_registered(Duration::from_secs(3)).is_some() {
        return Ok(());
    }

    if is_expected_service_process(pid, SERVICE_TRAY_FLAG) {
        persist_service_tray_pid(pid)?;
        return Ok(());
    }

    clear_recorded_tray_pid();
    Err("ShipFlow Service tray launched but did not register a tray process before timeout.".into())
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
    if focus_existing_service_settings_process()? {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        match launch_macos_service_settings_bundle_app() {
            Ok(()) => return Ok(()),
            Err(error) => {
                log_runtime_event(
                    "ERROR",
                    format!(
                        "[ShipFlowServiceLaunch] macOS settings LaunchServices launch did not open settings UI; falling back to executable launch: {error}"
                    ),
                );
            }
        }
    }

    let executable = resolve_service_companion_executable()?;
    let mut command = Command::new(executable);
    prepare_background_command(&mut command);
    let child = command
        .arg(SERVICE_OPEN_SETTINGS_FLAG)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch ShipFlow Service: {error}"))?;
    persist_service_settings_pid(child.id())?;
    if wait_for_service_settings_process_registered(Duration::from_secs(3)).is_some()
        || is_expected_service_settings_process(child.id())
    {
        log_runtime_event(
            "INFO",
            format!(
                "[ShipFlowServiceLaunch] launched settings fallback executable pid={}",
                child.id()
            ),
        );
        return Ok(());
    }

    clear_recorded_service_settings_pid();
    Err(
        "ShipFlow Service settings launched but did not register a settings process before timeout."
            .into(),
    )
}

pub fn launch_shipflow_service_app() -> Result<(), String> {
    launch_shipflow_service_settings()
}

pub(super) fn focus_existing_service_settings_process() -> Result<bool, String> {
    let Some(pid) = read_recorded_service_settings_pid() else {
        return Ok(false);
    };

    if !is_expected_service_settings_process(pid) {
        clear_recorded_service_settings_pid();
        return Ok(false);
    }

    persist_service_settings_activation_request(&DesktopActivationRequest {
        focus_main_window: true,
    })?;
    request_macos_bundle_activation(SERVICE_BUNDLE_IDENTIFIER);

    if wait_for_service_settings_activation_request_consumed(Duration::from_secs(3)) {
        log_runtime_event(
            "INFO",
            format!("[ShipFlowServiceLaunch] focused existing service settings process pid={pid}"),
        );
        return Ok(true);
    }

    log_runtime_event(
        "ERROR",
        format!(
            "[ShipFlowServiceLaunch] service settings process pid={pid} did not consume activation request; restarting it"
        ),
    );
    clear_service_settings_activation_request();
    let _ = terminate_process(pid);
    clear_recorded_service_settings_pid();
    Ok(false)
}

pub(super) fn focus_existing_desktop_process() -> Result<bool, String> {
    let Some(pid) = read_recorded_desktop_pid() else {
        return Ok(false);
    };

    if !is_expected_desktop_process(pid) {
        clear_recorded_desktop_pid();
        return Ok(false);
    }

    persist_desktop_activation_request(&DesktopActivationRequest {
        focus_main_window: true,
    })?;
    request_macos_bundle_activation(DESKTOP_BUNDLE_IDENTIFIER);

    if wait_for_desktop_activation_request_consumed(Duration::from_secs(3)) {
        log_runtime_event(
            "INFO",
            format!("[ShipFlowDesktopLaunch] focused existing desktop process pid={pid}"),
        );
        return Ok(true);
    } else {
        log_runtime_event(
            "ERROR",
            format!(
                "[ShipFlowDesktopLaunch] desktop process pid={pid} did not consume activation request; falling back to OS launch"
            ),
        );
        clear_desktop_activation_request();
    }

    Ok(false)
}

#[cfg(target_os = "macos")]
fn request_macos_bundle_activation(bundle_identifier: &str) {
    let status = Command::new("/usr/bin/open")
        .args(macos_bundle_open_args(bundle_identifier, &[]))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    match status {
        Ok(status) if status.success() => {
            log_runtime_event(
                "INFO",
                format!(
                    "[ShipFlowMacOSActivation] requested app activation bundle={bundle_identifier}"
                ),
            );
        }
        Ok(status) => {
            log_runtime_event(
                "ERROR",
                format!(
                    "[ShipFlowMacOSActivation] open -b failed bundle={bundle_identifier} status={status}"
                ),
            );
        }
        Err(error) => {
            log_runtime_event(
                "ERROR",
                format!(
                    "[ShipFlowMacOSActivation] unable to request app activation bundle={bundle_identifier}: {error}"
                ),
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn request_macos_bundle_activation(_bundle_identifier: &str) {}

fn macos_bundle_open_args(bundle_identifier: &str, extra_args: &[&str]) -> Vec<String> {
    let mut args = Vec::new();
    args.extend(["-b".into(), bundle_identifier.into()]);
    if !extra_args.is_empty() {
        args.push("--args".into());
        args.extend(extra_args.iter().map(|arg| (*arg).into()));
    }
    args
}

#[cfg(target_os = "macos")]
fn launch_macos_service_settings_bundle_app() -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .args(macos_bundle_open_args(
            SERVICE_BUNDLE_IDENTIFIER,
            &[SERVICE_OPEN_SETTINGS_FLAG],
        ))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            format!(
                "Unable to launch macOS Service settings bundle through LaunchServices: {error}"
            )
        })?;

    if status.success() {
        if let Some(pid) = wait_for_service_settings_process_registered(Duration::from_secs(3)) {
            log_runtime_event(
                "INFO",
                format!(
                    "[ShipFlowServiceLaunch] launched settings through macOS LaunchServices pid={pid}"
                ),
            );
            return Ok(());
        } else {
            log_runtime_event(
                "ERROR",
                "[ShipFlowServiceLaunch] macOS settings LaunchServices activation accepted but settings process did not register before timeout",
            );
        }

        return Err(
            "macOS Service settings LaunchServices activation did not register a settings process."
                .into(),
        );
    }

    Err(format!(
        "Unable to launch macOS Service settings bundle through LaunchServices: {status}"
    ))
}

#[cfg(target_os = "macos")]
fn launch_macos_bundle_app(bundle_identifier: &str, extra_args: &[&str]) -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .args(macos_bundle_open_args(bundle_identifier, extra_args))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            format!(
                "Unable to launch macOS app bundle '{bundle_identifier}' through LaunchServices: {error}"
            )
        })?;

    if status.success() {
        log_runtime_event(
            "INFO",
            format!("[ShipFlowMacOSActivation] launched app bundle={bundle_identifier}"),
        );
        return Ok(());
    }

    log_runtime_event(
        "ERROR",
        format!(
            "[ShipFlowMacOSActivation] open -b launch failed bundle={bundle_identifier} status={status}; falling back to executable launch"
        ),
    );
    Err(format!(
        "Unable to launch macOS app bundle '{bundle_identifier}' through LaunchServices: {status}"
    ))
}

fn wait_for_desktop_activation_request_consumed(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !desktop_activation_request_exists() {
            return true;
        }
        thread::sleep(Duration::from_millis(75));
    }

    false
}

fn wait_for_service_settings_activation_request_consumed(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !service_settings_activation_request_exists() {
            return true;
        }
        thread::sleep(Duration::from_millis(75));
    }

    false
}

fn wait_for_service_tray_process_registered(timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(pid) = read_recorded_tray_pid() {
            if is_expected_service_process(pid, SERVICE_TRAY_FLAG) {
                return Some(pid);
            }
        }
        thread::sleep(Duration::from_millis(75));
    }

    None
}

fn wait_for_service_settings_process_registered(timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(pid) = read_recorded_service_settings_pid() {
            if is_expected_service_settings_process(pid) {
                return Some(pid);
            }
        }
        thread::sleep(Duration::from_millis(75));
    }

    None
}

fn wait_for_desktop_process_registered(timeout: Duration) -> Option<u32> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(pid) = read_recorded_desktop_pid() {
            if is_expected_desktop_process(pid) {
                return Some(pid);
            }
        }
        thread::sleep(Duration::from_millis(75));
    }

    None
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
        candidates.extend(installed_service_companion_candidates(current_executable));
        candidates.push(parent_dir.join(format!("{SERVICE_COMPANION_BINARY_BASENAME}.exe")));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(parent_dir.join(SERVICE_COMPANION_BINARY_BASENAME));
        candidates.extend(installed_service_companion_candidates(current_executable));
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
        candidates.extend(installed_desktop_companion_candidates(current_executable));
        candidates.push(parent_dir.join(format!("{DESKTOP_BINARY_BASENAME}.exe")));
        candidates.push(parent_dir.join(format!("{DESKTOP_PRODUCT_BASENAME}.exe")));
    }

    #[cfg(not(target_os = "windows"))]
    {
        candidates.push(parent_dir.join(DESKTOP_BINARY_BASENAME));
        candidates.push(parent_dir.join(DESKTOP_PRODUCT_BASENAME));
        candidates.extend(installed_desktop_companion_candidates(current_executable));
    }

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
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let _ = product_name;

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
        if let Some(executable_path) = windows_registry_executable_path(product_name) {
            candidates.push(executable_path);
        }

        if let Some(install_dir) = windows_registry_install_dir(product_name) {
            for binary_name in binary_names {
                candidates.push(install_dir.join(format!("{binary_name}.exe")));
            }
        }

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

    if let Some(shipflow_dir) = windows_shipflow_install_dir(product_name) {
        dirs.push(shipflow_dir);
    }

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

#[cfg(target_os = "windows")]
fn windows_registry_executable_path(product_name: &str) -> Option<PathBuf> {
    windows_registry_app_value(product_name, "ExecutablePath").map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn windows_registry_install_dir(product_name: &str) -> Option<PathBuf> {
    windows_registry_app_value(product_name, "InstallLocation").map(PathBuf::from)
}

#[cfg(target_os = "windows")]
fn windows_registry_app_value(product_name: &str, value_name: &str) -> Option<String> {
    let app_key = match product_name {
        SERVICE_PRODUCT_BASENAME => "Service",
        DESKTOP_PRODUCT_BASENAME => "Desktop",
        _ => return None,
    };
    let key = format!("{WINDOWS_SHIPFLOW_REGISTRY_ROOT}\\{app_key}");
    let reg_exe = windows_reg_exe();

    for registry_view in [Some("/reg:64"), Some("/reg:32"), None] {
        let output = match Command::new(&reg_exe)
            .args(windows_registry_query_args(&key, value_name, registry_view))
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(output) => output,
            Err(_) => continue,
        };

        if !output.status.success() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(value) = parse_windows_reg_sz_value(&stdout, value_name) {
            return Some(value);
        }
    }

    None
}

fn windows_registry_query_args<'a>(
    key: &'a str,
    value_name: &'a str,
    registry_view: Option<&'a str>,
) -> Vec<&'a str> {
    let mut args = vec!["query", key, "/v", value_name];
    if let Some(registry_view) = registry_view {
        args.push(registry_view);
    }
    args
}

#[cfg(target_os = "windows")]
fn windows_reg_exe() -> PathBuf {
    env::var_os("WINDIR")
        .map(PathBuf::from)
        .map(|windows_dir| windows_dir.join("System32").join("reg.exe"))
        .unwrap_or_else(|| PathBuf::from("reg.exe"))
}

fn parse_windows_reg_sz_value(output: &str, value_name: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let mut parts = trimmed.split_whitespace();
        if !parts
            .next()
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(value_name))
        {
            return None;
        }

        if !parts
            .next()
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case("REG_SZ"))
        {
            return None;
        }

        let value = parts.collect::<Vec<_>>().join(" ");
        if value.trim().is_empty() {
            None
        } else {
            Some(value)
        }
    })
}

#[cfg(target_os = "windows")]
fn windows_shipflow_install_dir(product_name: &str) -> Option<PathBuf> {
    let app_dir = match product_name {
        SERVICE_PRODUCT_BASENAME => "Service",
        DESKTOP_PRODUCT_BASENAME => "Desktop",
        _ => return None,
    };

    Some(PathBuf::from(WINDOWS_SHIPFLOW_ROOT).join(app_dir))
}

fn launch_shipflow_desktop() -> Result<(), String> {
    if focus_existing_desktop_process()? {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        match launch_macos_desktop_bundle_app() {
            Ok(()) => return Ok(()),
            Err(error) => {
                log_runtime_event(
                    "ERROR",
                    format!(
                        "[ShipFlowDesktopLaunch] macOS Desktop LaunchServices launch did not open Desktop UI; falling back to executable launch: {error}"
                    ),
                );
            }
        }
    }

    let executable = resolve_desktop_companion_executable()?;
    let mut command = Command::new(executable);
    prepare_background_command(&mut command);
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Unable to launch ShipFlow Desktop: {error}"))?;
    persist_desktop_pid(child.id())?;
    if wait_for_desktop_process_registered(Duration::from_secs(3)).is_some()
        || is_expected_desktop_process(child.id())
    {
        log_runtime_event(
            "INFO",
            format!(
                "[ShipFlowDesktopLaunch] launched desktop fallback executable pid={}",
                child.id()
            ),
        );
        return Ok(());
    }

    clear_recorded_desktop_pid();
    Err("ShipFlow Desktop launched but did not register a desktop process before timeout.".into())
}

#[cfg(target_os = "macos")]
fn launch_macos_desktop_bundle_app() -> Result<(), String> {
    let status = Command::new("/usr/bin/open")
        .args(macos_bundle_open_args(DESKTOP_BUNDLE_IDENTIFIER, &[]))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            format!("Unable to launch macOS Desktop bundle through LaunchServices: {error}")
        })?;

    if status.success() {
        if let Some(pid) = wait_for_desktop_process_registered(Duration::from_secs(3)) {
            log_runtime_event(
                "INFO",
                format!("[ShipFlowDesktopLaunch] launched Desktop through macOS LaunchServices pid={pid}"),
            );
            return Ok(());
        } else {
            log_runtime_event(
                "ERROR",
                "[ShipFlowDesktopLaunch] macOS Desktop LaunchServices activation accepted but desktop process did not register before timeout",
            );
        }

        return Err(
            "macOS Desktop LaunchServices activation did not register a desktop process.".into(),
        );
    }

    Err(format!(
        "Unable to launch macOS Desktop bundle through LaunchServices: {status}"
    ))
}

#[cfg(target_os = "windows")]
fn service_login_autostart_command() -> Result<String, String> {
    let executable = resolve_service_companion_executable()?;
    Ok(format!(
        "\"{}\" {}",
        executable.to_string_lossy(),
        SERVICE_AUTOSTART_FLAG
    ))
}

#[cfg(target_os = "windows")]
fn delete_windows_autostart_registry_value(value_name: &str) -> Result<(), String> {
    let mut registry_command = Command::new("reg");
    prepare_background_command(&mut registry_command);
    let status = registry_command
        .args([
            "delete",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            value_name,
            "/f",
        ])
        .status()
        .map_err(|error| format!("Unable to delete Windows autostart value: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Windows autostart value delete failed for {value_name}."
        ))
    }
}

fn sync_service_login_autostart(config: &ApiServiceConfig) -> Result<(), String> {
    if should_enable_service_login_autostart(config) {
        enable_service_login_autostart()
    } else {
        disable_service_login_autostart()
    }
}

fn should_enable_service_login_autostart(config: &ApiServiceConfig) -> bool {
    config.start_at_login && !config.uses_custom_desktop_service_connection()
}

fn macos_service_login_launch_agent_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-b</string>
    <string>{}</string>
    <string>--args</string>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#,
        xml_escape(SERVICE_LOGIN_LAUNCH_AGENT_LABEL),
        xml_escape(SERVICE_BUNDLE_IDENTIFIER),
        xml_escape(SERVICE_AUTOSTART_FLAG)
    )
}

#[cfg(target_os = "macos")]
fn macos_launchctl_user_domain() -> Result<String, String> {
    let output = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|error| format!("Unable to resolve macOS user id for launchctl: {error}"))?;

    if !output.status.success() {
        return Err("Unable to resolve macOS user id for launchctl.".into());
    }

    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() {
        return Err("macOS user id for launchctl is empty.".into());
    }

    Ok(format!("gui/{uid}"))
}

#[cfg(target_os = "macos")]
fn macos_launchctl_bootstrap_args(domain: &str, plist_path: &FsPath) -> Vec<String> {
    vec![
        "bootstrap".into(),
        domain.into(),
        plist_path.to_string_lossy().into_owned(),
    ]
}

#[cfg(target_os = "macos")]
fn macos_launchctl_bootout_args(domain: &str, label: &str) -> Vec<String> {
    vec!["bootout".into(), format!("{domain}/{label}")]
}

#[cfg(target_os = "macos")]
fn macos_launchctl_kickstart_args(domain: &str) -> Vec<String> {
    vec![
        "kickstart".into(),
        "-k".into(),
        format!("{domain}/{SERVICE_LOGIN_LAUNCH_AGENT_LABEL}"),
    ]
}

#[cfg(target_os = "macos")]
fn run_macos_launchctl(args: &[String], action: &str) -> Result<(), String> {
    let status = Command::new("/bin/launchctl")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Unable to run launchctl {action}: {error}"))?;

    if !status.success() {
        return Err(format!("launchctl {action} failed: {status}"));
    }

    Ok(())
}

fn enable_service_login_autostart() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let launch_agents_dir = home_dir.join("Library/LaunchAgents");
        fs::create_dir_all(&launch_agents_dir)
            .map_err(|error| format!("Unable to create LaunchAgents directory: {error}"))?;
        let plist_path = launch_agents_dir.join("com.shipflow.service-login.plist");
        let legacy_plist_path = launch_agents_dir.join("com.shipflow.service-tray.plist");
        let plist = macos_service_login_launch_agent_plist();
        fs::write(&plist_path, plist)
            .map_err(|error| format!("Unable to write LaunchAgent plist: {error}"))?;
        let domain = macos_launchctl_user_domain()?;
        let _ = run_macos_launchctl(
            &macos_launchctl_bootout_args(&domain, SERVICE_TRAY_LAUNCH_AGENT_LABEL),
            "bootout legacy tray autostart",
        );
        if legacy_plist_path.exists() {
            let _ = fs::remove_file(legacy_plist_path);
        }
        let _ = run_macos_launchctl(
            &macos_launchctl_bootout_args(&domain, SERVICE_LOGIN_LAUNCH_AGENT_LABEL),
            "bootout login autostart",
        );
        run_macos_launchctl(
            &macos_launchctl_bootstrap_args(&domain, &plist_path),
            "bootstrap",
        )?;
        run_macos_launchctl(&macos_launchctl_kickstart_args(&domain), "kickstart")?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let command = service_login_autostart_command()?;
        let mut registry_command = Command::new("reg");
        prepare_background_command(&mut registry_command);
        let status = registry_command
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                SERVICE_LOGIN_AUTOSTART_REGISTRY_VALUE,
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
        let _ =
            delete_windows_autostart_registry_value(SERVICE_TRAY_LEGACY_AUTOSTART_REGISTRY_VALUE);
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
        let desktop_path = autostart_dir.join("shipflow-service.desktop");
        let legacy_desktop_path = autostart_dir.join("shipflow-service-tray.desktop");
        let executable = resolve_service_companion_executable()?;
        let desktop_file = format!(
            "[Desktop Entry]\nType=Application\nName=ShipFlow Service\nExec=\"{}\" {}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n",
            executable.to_string_lossy(),
            SERVICE_AUTOSTART_FLAG
        );
        fs::write(desktop_path, desktop_file)
            .map_err(|error| format!("Unable to write autostart desktop entry: {error}"))?;
        if legacy_desktop_path.exists() {
            let _ = fs::remove_file(legacy_desktop_path);
        }
        return Ok(());
    }

    #[allow(unreachable_code)]
    Ok(())
}

fn disable_service_login_autostart() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        let domain = macos_launchctl_user_domain()?;
        for label in [
            SERVICE_LOGIN_LAUNCH_AGENT_LABEL,
            SERVICE_TRAY_LAUNCH_AGENT_LABEL,
        ] {
            let _ = run_macos_launchctl(&macos_launchctl_bootout_args(&domain, label), "bootout");
        }
        for plist_path in [
            home_dir.join("Library/LaunchAgents/com.shipflow.service-login.plist"),
            home_dir.join("Library/LaunchAgents/com.shipflow.service-tray.plist"),
        ] {
            if plist_path.exists() {
                fs::remove_file(plist_path)
                    .map_err(|error| format!("Unable to remove LaunchAgent plist: {error}"))?;
            }
        }
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = delete_windows_autostart_registry_value(SERVICE_LOGIN_AUTOSTART_REGISTRY_VALUE);
        let _ =
            delete_windows_autostart_registry_value(SERVICE_TRAY_LEGACY_AUTOSTART_REGISTRY_VALUE);
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home_dir = env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve HOME directory for autostart.".to_string())?;
        for desktop_path in [
            home_dir.join(".config/autostart/shipflow-service.desktop"),
            home_dir.join(".config/autostart/shipflow-service-tray.desktop"),
        ] {
            if desktop_path.exists() {
                fs::remove_file(desktop_path).map_err(|error| {
                    format!("Unable to remove autostart desktop entry: {error}")
                })?;
            }
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

pub fn stop_service_settings_process() {
    if let Some(pid) = read_recorded_service_settings_pid() {
        if is_expected_service_settings_process(pid) {
            let _ = terminate_process(pid);
        }
    }

    clear_service_settings_activation_request();
    clear_recorded_service_settings_pid();
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
    command_line_matches_service_binary(command_line) && command_line.contains(required_flag)
}

fn command_line_matches_service_settings_process(command_line: &str) -> bool {
    command_line_matches_service_binary(command_line)
        && !command_line.contains(SERVICE_AUTOSTART_FLAG)
        && !command_line.contains(SERVICE_PROCESS_FLAG)
        && !command_line.contains(SERVICE_TRAY_FLAG)
}

fn command_line_matches_desktop_process(command_line: &str) -> bool {
    command_line_matches_desktop_binary(command_line)
        && !command_line.contains(SERVICE_AUTOSTART_FLAG)
        && !command_line.contains(SERVICE_PROCESS_FLAG)
        && !command_line.contains(SERVICE_TRAY_FLAG)
        && !command_line.contains(SERVICE_OPEN_SETTINGS_FLAG)
}

fn command_line_matches_service_binary(command_line: &str) -> bool {
    let normalized = command_line.to_ascii_lowercase();
    command_line_contains_binary(&normalized, SERVICE_COMPANION_BINARY_BASENAME)
        || command_line_contains_binary(&normalized, SERVICE_PRODUCT_BASENAME)
}

fn command_line_matches_desktop_binary(command_line: &str) -> bool {
    let normalized = command_line.to_ascii_lowercase();
    command_line_contains_binary(&normalized, DESKTOP_BINARY_BASENAME)
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

pub fn is_expected_desktop_process(pid: u32) -> bool {
    is_process_alive(pid)
        && process_command_line(pid)
            .as_deref()
            .is_some_and(command_line_matches_desktop_process)
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
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Unable to terminate API service companion: {error}"))?;

        if !status.success() {
            if !is_process_alive(pid) {
                return Ok(());
            }
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
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Unable to force-stop API service companion: {error}"))?;

        if !force_status.success() {
            if !is_process_alive(pid) {
                return Ok(());
            }
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
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }
}

fn service_probe_socket_addr(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

fn read_service_probe_response(
    port: u16,
    path: &str,
    auth_token: Option<&str>,
    timeout: Duration,
) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(&service_probe_socket_addr(port), timeout)
        .map_err(|error| {
            format!("Unable to connect to ShipFlow Service status endpoint: {error}")
        })?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let auth_header = auth_token
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(|token| format!("Authorization: Bearer {token}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth_header}Accept: application/json\r\nConnection: close\r\n\r\n"
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

fn split_http_probe_response(response: &str) -> Option<(&str, &str)> {
    let mut parts = response.splitn(2, "\r\n\r\n");
    let headers = parts.next().unwrap_or_default();
    let body = parts.next().unwrap_or_default().trim();

    if http_probe_status_code(response) != Some(200) {
        return None;
    }

    Some((headers, body))
}

fn http_probe_status_code(response: &str) -> Option<u16> {
    let status_line = response.lines().next().unwrap_or_default();
    let mut parts = status_line.split_whitespace();
    let protocol = parts.next()?;
    if !protocol.starts_with("HTTP/") {
        return None;
    }

    parts.next()?.parse().ok()
}

fn http_probe_body(response: &str) -> &str {
    response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.trim())
        .unwrap_or_default()
}

fn service_status_identity_is_valid(response: &str) -> bool {
    let Some((_, body)) = split_http_probe_response(response) else {
        return false;
    };

    let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };

    let data = payload.get("data").unwrap_or(&payload);

    data.get("service").and_then(|value| value.as_str()) == Some("running")
        && data.get("product").and_then(|value| value.as_str()) == Some(SERVICE_STATUS_PRODUCT)
}

fn service_auth_check_is_valid(response: &str) -> bool {
    let Some((_, body)) = split_http_probe_response(response) else {
        return false;
    };

    let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };

    let data = payload.get("data").unwrap_or(&payload);

    data.get("product").and_then(|value| value.as_str()) == Some(SERVICE_STATUS_PRODUCT)
        && data.get("status").and_then(|value| value.as_str()) == Some("ok")
}

pub fn is_service_runtime_ready(config: &ApiServiceConfig, timeout: Duration) -> bool {
    let status_ok = read_service_probe_response(config.port, "/v1/status", None, timeout)
        .map(|response| service_status_identity_is_valid(&response))
        .unwrap_or(false);
    if !status_ok {
        return false;
    }

    read_service_probe_response(
        config.port,
        "/v1/auth/check",
        Some(&config.auth_token),
        timeout,
    )
    .map(|response| service_auth_check_is_valid(&response))
    .unwrap_or(false)
}

pub fn service_runtime_readiness_failure_hint(
    config: &ApiServiceConfig,
    timeout: Duration,
) -> Option<String> {
    let status_response =
        match read_service_probe_response(config.port, "/v1/status", None, timeout) {
            Ok(response) => response,
            Err(error) => {
                return Some(format!(
                    "API service is not reachable on port {}: {error}",
                    config.port
                ));
            }
        };

    match http_probe_status_code(&status_response) {
        Some(200) => {
            if !service_status_identity_is_valid(&status_response) {
                return Some(
                    "A service responded on the configured port, but it is not a compatible ShipFlow Service API."
                        .into(),
                );
            }
        }
        Some(401) if http_probe_body(&status_response).contains("Authorization header") => {
            return Some(
                "An older ShipFlow Service API is still running on the configured port. Quit or reinstall ShipFlow Service so /v1/status is public and /v1/auth/check is available."
                    .into(),
            );
        }
        Some(status_code) => {
            return Some(format!(
                "ShipFlow Service status probe returned HTTP {status_code}; the service is not ready."
            ));
        }
        None => {
            return Some("ShipFlow Service status probe returned an invalid HTTP response.".into());
        }
    }

    let auth_response = match read_service_probe_response(
        config.port,
        "/v1/auth/check",
        Some(&config.auth_token),
        timeout,
    ) {
        Ok(response) => response,
        Err(error) => {
            return Some(format!(
                "Unable to verify ShipFlow Service bearer token on port {}: {error}",
                config.port
            ));
        }
    };

    if service_auth_check_is_valid(&auth_response) {
        return None;
    }

    match http_probe_status_code(&auth_response) {
        Some(401) => Some("ShipFlow Service rejected the configured bearer token.".into()),
        Some(404) => Some(
            "The ShipFlow Service API on the configured port does not expose /v1/auth/check; an older Service binary is likely still running."
                .into(),
        ),
        Some(status_code) => Some(format!(
            "ShipFlow Service auth check returned HTTP {status_code}; the service is not ready."
        )),
        None => Some("ShipFlow Service auth check returned an invalid HTTP response.".into()),
    }
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
    sync_service_login_autostart(config)?;

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
    #[cfg(target_os = "macos")]
    use std::path::PathBuf;

    use super::{
        build_service_endpoint, command_line_matches_desktop_process,
        command_line_matches_service_process, command_line_matches_service_settings_process,
        format_service_status_label, http_probe_body, http_probe_status_code,
        service_auth_check_is_valid, service_status_identity_is_valid,
        should_keep_service_tray_companion, ApiServiceConfig, ApiServiceMode, ApiServiceStatus,
        ApiServiceStatusKind,
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
            start_at_login: true,
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
    fn tray_companion_can_stay_available_without_autostart() {
        let config = ApiServiceConfig {
            keep_running_in_tray: true,
            start_at_login: false,
            ..sample_config()
        };

        assert!(should_keep_service_tray_companion(&config));
    }

    #[test]
    fn autostart_is_controlled_by_start_at_login_not_current_session_tray() {
        let config = ApiServiceConfig {
            keep_running_in_tray: false,
            start_at_login: true,
            ..sample_config()
        };

        assert!(super::should_enable_service_login_autostart(&config));
    }

    #[test]
    fn autostart_turns_off_when_start_at_login_is_disabled() {
        let config = ApiServiceConfig {
            keep_running_in_tray: true,
            start_at_login: false,
            ..sample_config()
        };

        assert!(!super::should_enable_service_login_autostart(&config));
    }

    #[test]
    fn autostart_is_disabled_for_custom_desktop_service_connections() {
        let config = ApiServiceConfig {
            desktop_connection_mode: crate::service::DesktopServiceConnectionMode::Custom,
            keep_running_in_tray: true,
            start_at_login: true,
            ..sample_config()
        };

        assert!(!super::should_enable_service_login_autostart(&config));
    }

    #[test]
    fn macos_service_login_launch_agent_uses_launch_services_bundle_activation() {
        let plist = super::macos_service_login_launch_agent_plist();

        assert!(plist.contains("<string>com.shipflow.service-login</string>"));
        assert!(plist.contains("<string>/usr/bin/open</string>"));
        assert!(!plist.contains("<string>-n</string>"));
        assert!(plist.contains("<string>-b</string>"));
        assert!(plist.contains("<string>com.shipflow.service</string>"));
        assert!(plist.contains("<string>--args</string>"));
        assert!(plist.contains("<string>--shipflow-service-autostart</string>"));
        assert!(!plist.contains("<string>--shipflow-service-tray</string>"));
        assert!(!plist.contains("Contents/MacOS"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_launchctl_args_target_service_login_launch_agent() {
        let plist_path = std::path::Path::new(
            "/Users/example/Library/LaunchAgents/com.shipflow.service-login.plist",
        );

        assert_eq!(
            super::macos_launchctl_bootstrap_args("gui/501", plist_path),
            vec![
                "bootstrap",
                "gui/501",
                "/Users/example/Library/LaunchAgents/com.shipflow.service-login.plist",
            ]
        );
        assert_eq!(
            super::macos_launchctl_bootout_args("gui/501", super::SERVICE_LOGIN_LAUNCH_AGENT_LABEL,),
            vec!["bootout", "gui/501/com.shipflow.service-login"]
        );
        assert_eq!(
            super::macos_launchctl_kickstart_args("gui/501"),
            vec!["kickstart", "-k", "gui/501/com.shipflow.service-login"]
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn single_instance_claims_are_noops_off_windows() {
        assert!(super::claim_desktop_ui_single_instance()
            .expect("desktop claim should succeed off Windows"));
        assert!(super::claim_service_settings_ui_single_instance()
            .expect("service settings claim should succeed off Windows"));
        assert!(super::claim_service_tray_ui_single_instance()
            .expect("service tray claim should succeed off Windows"));
    }

    #[test]
    fn macos_bundle_open_args_preserve_service_settings_flag() {
        assert_eq!(
            super::macos_bundle_open_args(
                super::SERVICE_BUNDLE_IDENTIFIER,
                &[super::SERVICE_OPEN_SETTINGS_FLAG],
            ),
            vec![
                "-b",
                "com.shipflow.service",
                "--args",
                "--shipflow-service-open-settings",
            ]
        );
    }

    #[test]
    fn macos_bundle_open_args_do_not_add_args_marker_without_extra_args() {
        assert_eq!(
            super::macos_bundle_open_args(super::DESKTOP_BUNDLE_IDENTIFIER, &[]),
            vec!["-b", "com.shipflow.desktop"]
        );
    }

    #[test]
    fn macos_service_settings_bundle_launch_uses_regular_activation_with_open_settings_flag() {
        assert_eq!(
            super::macos_bundle_open_args(
                super::SERVICE_BUNDLE_IDENTIFIER,
                &[super::SERVICE_OPEN_SETTINGS_FLAG],
            ),
            vec![
                "-b",
                "com.shipflow.service",
                "--args",
                "--shipflow-service-open-settings",
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_sibling_app_dir_resolves_service_next_to_desktop_bundle() {
        let desktop_executable =
            PathBuf::from("/Applications/ShipFlow Desktop.app/Contents/MacOS/shipflow3-tauri");

        assert_eq!(
            super::macos_sibling_app_dir(&desktop_executable, super::SERVICE_PRODUCT_BASENAME),
            Some(PathBuf::from("/Applications/ShipFlow Service.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_sibling_app_dir_resolves_desktop_next_to_service_bundle() {
        let service_executable =
            PathBuf::from("/Applications/ShipFlow Service.app/Contents/MacOS/shipflow-service");

        assert_eq!(
            super::macos_sibling_app_dir(&service_executable, super::DESKTOP_PRODUCT_BASENAME),
            Some(PathBuf::from("/Applications/ShipFlow Desktop.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn service_candidates_include_sibling_macos_service_app() {
        let desktop_executable =
            PathBuf::from("/Applications/ShipFlow Desktop.app/Contents/MacOS/shipflow3-tauri");
        let candidates = super::service_companion_candidates(&desktop_executable);

        assert!(candidates.contains(&PathBuf::from(
            "/Applications/ShipFlow Service.app/Contents/MacOS/shipflow-service"
        )));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn desktop_candidates_include_sibling_macos_desktop_app() {
        let service_executable =
            PathBuf::from("/Applications/ShipFlow Service.app/Contents/MacOS/shipflow-service");
        let candidates = super::desktop_companion_candidates(&service_executable);

        assert!(candidates.contains(&PathBuf::from(
            "/Applications/ShipFlow Desktop.app/Contents/MacOS/shipflow3-tauri"
        )));
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
        assert!(!command_line_matches_service_process(
            r#""C:\Program Files\ShipFlow Desktop\ShipFlow Desktop.exe" --shipflow-service-process"#,
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
            r#""C:\Program Files\ShipFlow Service\shipflow-service.exe" --shipflow-service-autostart"#
        ));
        assert!(!command_line_matches_service_settings_process(
            r#""C:\Program Files\ShipFlow Service\shipflow-service.exe" --shipflow-service-tray"#
        ));
        assert!(!command_line_matches_service_settings_process(
            r#""C:\Program Files\ShipFlow Desktop\ShipFlow Desktop.exe""#
        ));
        assert!(!command_line_matches_service_settings_process(
            r#""C:\Program Files\ShipFlow Desktop\shipflow3-tauri.exe""#
        ));
    }

    #[test]
    fn desktop_command_line_requires_desktop_binary_without_service_flags() {
        assert!(command_line_matches_desktop_process(
            r#""C:\Program Files\ShipFlow Desktop\ShipFlow Desktop.exe""#
        ));
        assert!(command_line_matches_desktop_process(
            "/Applications/ShipFlow Desktop.app/Contents/MacOS/shipflow3-tauri"
        ));
        assert!(!command_line_matches_desktop_process(
            r#""C:\Program Files\ShipFlow Service\shipflow-service.exe""#
        ));
        assert!(!command_line_matches_desktop_process(
            r#""C:\Program Files\ShipFlow Desktop\ShipFlow Desktop.exe" --shipflow-service-process"#
        ));
        assert!(!command_line_matches_desktop_process(
            "/usr/bin/python other.py"
        ));
    }

    #[test]
    fn windows_registry_query_parser_extracts_install_location() {
        let output = r#"
HKEY_LOCAL_MACHINE\Software\ShipFlow\Desktop
    InstallLocation    REG_SZ    C:\ShipFlow\Desktop
    ExecutablePath     REG_SZ    C:\ShipFlow\Desktop\shipflow3-tauri.exe
"#;

        assert_eq!(
            super::parse_windows_reg_sz_value(output, "InstallLocation"),
            Some(r"C:\ShipFlow\Desktop".into())
        );
    }

    #[test]
    fn windows_registry_query_args_use_requested_value_name() {
        assert_eq!(
            super::windows_registry_query_args(
                r"HKLM\Software\ShipFlow\Desktop",
                "ExecutablePath",
                Some("/reg:64")
            ),
            vec![
                "query",
                r"HKLM\Software\ShipFlow\Desktop",
                "/v",
                "ExecutablePath",
                "/reg:64"
            ]
        );
        assert_eq!(
            super::windows_registry_query_args(
                r"HKLM\Software\ShipFlow\Service",
                "InstallLocation",
                Some("/reg:32")
            ),
            vec![
                "query",
                r"HKLM\Software\ShipFlow\Service",
                "/v",
                "InstallLocation",
                "/reg:32"
            ]
        );
        assert_eq!(
            super::windows_registry_query_args(
                r"HKLM\Software\ShipFlow\Service",
                "InstallLocation",
                None
            ),
            vec![
                "query",
                r"HKLM\Software\ShipFlow\Service",
                "/v",
                "InstallLocation"
            ]
        );
    }

    #[test]
    fn windows_registry_query_parser_preserves_executable_path_spaces() {
        let output = r#"
HKEY_LOCAL_MACHINE\Software\ShipFlow\Desktop
    InstallLocation    REG_SZ    C:\Program Files\ShipFlow Desktop
    ExecutablePath     REG_SZ    C:\Program Files\ShipFlow Desktop\shipflow3-tauri.exe
"#;

        assert_eq!(
            super::parse_windows_reg_sz_value(output, "ExecutablePath"),
            Some(r"C:\Program Files\ShipFlow Desktop\shipflow3-tauri.exe".into())
        );
    }

    #[test]
    fn windows_registry_query_parser_preserves_paths_with_spaces() {
        let output = r#"
HKEY_LOCAL_MACHINE\Software\ShipFlow\Service
    InstallLocation    REG_SZ    C:\Program Files\ShipFlow Service
"#;

        assert_eq!(
            super::parse_windows_reg_sz_value(output, "InstallLocation"),
            Some(r"C:\Program Files\ShipFlow Service".into())
        );
    }

    #[test]
    fn windows_registry_query_parser_ignores_wrong_value_or_type() {
        let output = r#"
HKEY_LOCAL_MACHINE\Software\ShipFlow\Service
    InstallLocation    REG_EXPAND_SZ    %ProgramFiles%\ShipFlow Service
    ExecutablePath     REG_SZ           C:\ShipFlow\Service\shipflow-service.exe
"#;

        assert_eq!(
            super::parse_windows_reg_sz_value(output, "InstallLocation"),
            None
        );
    }

    #[test]
    fn service_status_probe_requires_shipflow_identity() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n",
            r#"{"service":"running","product":"shipflow-service","mode":"local","port":18422}"#
        );

        assert!(service_status_identity_is_valid(response));
        assert!(!service_status_identity_is_valid(
            "HTTP/1.1 200 OK\r\n\r\n{\"service\":\"running\"}"
        ));
        assert!(!service_status_identity_is_valid(
            "HTTP/1.1 401 Unauthorized\r\n\r\n{\"error\":\"bad token\"}"
        ));
    }

    #[test]
    fn service_auth_probe_requires_accepted_bearer_token() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n",
            r#"{"data":{"product":"shipflow-service","auth":"bearer","status":"ok"}}"#
        );

        assert!(service_auth_check_is_valid(response));
        assert!(!service_auth_check_is_valid(
            "HTTP/1.1 200 OK\r\n\r\n{\"data\":{\"product\":\"shipflow-service\"}}"
        ));
        assert!(!service_auth_check_is_valid(
            "HTTP/1.1 401 Unauthorized\r\n\r\n{\"error\":{\"message\":\"Bearer token is invalid.\"}}"
        ));
    }

    #[test]
    fn http_probe_helpers_parse_error_status_and_body() {
        let response = concat!(
            "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n\r\n",
            r#"{"error":{"message":"Authorization header is required."}}"#
        );

        assert_eq!(http_probe_status_code(response), Some(401));
        assert!(http_probe_body(response).contains("Authorization header is required"));
        assert_eq!(http_probe_status_code("not http"), None);
    }
}
