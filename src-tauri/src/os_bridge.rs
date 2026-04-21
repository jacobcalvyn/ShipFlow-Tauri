use std::io::Write;
use std::process::Command;
use std::process::Stdio;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn prepare_platform_command(_command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn run_clipboard_command(mut command: Command, text: &str) -> Result<(), String> {
    prepare_platform_command(&mut command);
    let mut child = command
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start clipboard command: {error}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("Unable to write clipboard payload: {error}"))?;
    } else {
        return Err("Clipboard command stdin is unavailable.".into());
    }

    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for clipboard command: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Clipboard command exited with status {status}."))
    }
}

pub(crate) fn copy_text_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return run_clipboard_command(Command::new("pbcopy"), text);
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "clip"]);
        return run_clipboard_command(command, text);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let candidates = [
            ("wl-copy", Vec::<&str>::new()),
            ("xclip", vec!["-selection", "clipboard"]),
            ("xsel", vec!["--clipboard", "--input"]),
        ];

        let mut last_error = None;
        for (program, args) in candidates {
            let mut command = Command::new(program);
            command.args(args);

            match run_clipboard_command(command, text) {
                Ok(()) => return Ok(()),
                Err(error) => last_error = Some(error),
            }
        }

        return Err(
            last_error.unwrap_or_else(|| "No supported clipboard command is available.".into())
        );
    }

    #[allow(unreachable_code)]
    Err("Clipboard copy is not supported on this platform.".into())
}

#[cfg(target_os = "macos")]
fn pick_workspace_document_path_macos(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    let script = match mode {
        "open" => {
            r#"set chosenFile to choose file with prompt "Buka workspace ShipFlow" of type {"shipflow"}
POSIX path of chosenFile"#
                .to_string()
        }
        "save" => {
            let default_name = suggested_name.unwrap_or("Untitled.shipflow");
            format!(
                r#"set chosenFile to choose file name with prompt "Simpan workspace ShipFlow" default name "{}"
POSIX path of chosenFile"#,
                default_name.replace('"', "\\\"")
            )
        }
        _ => return Err("Unsupported workspace picker mode.".into()),
    };

    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("Unable to open native file picker: {error}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
        if stderr.contains("user canceled") || stderr.contains("cancelled") {
            Ok(None)
        } else {
            Err(format!(
                "Native file picker failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

#[cfg(target_os = "windows")]
fn pick_workspace_document_path_windows(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    let dialog_type = if mode == "open" {
        "OpenFileDialog"
    } else {
        "SaveFileDialog"
    };
    let file_name_line = suggested_name
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("$dialog.FileName = '{}';", value.replace('\'', "''")))
        .unwrap_or_default();
    let powershell = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         $dialog = New-Object System.Windows.Forms.{dialog_type}; \
         $dialog.Filter = 'ShipFlow Workspace (*.shipflow)|*.shipflow|All files (*.*)|*.*'; \
         {file_name_line} \
         if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $dialog.FileName }}"
    );

    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-Command", &powershell]);
    prepare_platform_command(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("Unable to open native file picker: {error}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Err(format!(
            "Native file picker failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_workspace_document_path_linux(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    let mut command = Command::new("zenity");
    command.arg("--file-selection");

    if mode == "save" {
        command.arg("--save");
        command.arg("--confirm-overwrite");
        if let Some(name) = suggested_name.filter(|value| !value.trim().is_empty()) {
            command.arg(format!("--filename={name}"));
        }
    }

    let output = command
        .output()
        .map_err(|error| format!("Unable to open native file picker: {error}"))?;

    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            Ok(None)
        } else {
            Ok(Some(path))
        }
    } else {
        Ok(None)
    }
}

fn pick_workspace_document_path_native(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        return pick_workspace_document_path_macos(mode, suggested_name);
    }

    #[cfg(target_os = "windows")]
    {
        return pick_workspace_document_path_windows(mode, suggested_name);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return pick_workspace_document_path_linux(mode, suggested_name);
    }

    #[allow(unreachable_code)]
    Err("Native file picker is not supported on this platform.".into())
}

pub(crate) fn pick_workspace_document_path_runtime(
    mode: &str,
    suggested_name: Option<&str>,
) -> Result<Option<String>, String> {
    match mode {
        "open" => pick_workspace_document_path_native("open", suggested_name),
        "save" | "saveas" => pick_workspace_document_path_native("save", suggested_name),
        _ => Err("Unsupported workspace picker mode.".into()),
    }
}

pub(crate) fn open_external_url_runtime(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("External URL is required.".into());
    }

    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Only HTTP(S) URLs can be opened.".into());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(trimmed);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", trimmed]);
        command
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(trimmed);
        command
    };

    prepare_platform_command(&mut command);
    command
        .spawn()
        .map_err(|error| format!("Unable to open external URL: {error}"))?;

    Ok(())
}
