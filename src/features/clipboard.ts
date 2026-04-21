import { invoke } from "@tauri-apps/api/core";

export async function writeClipboardText(value: string) {
  const text = value.trim();
  if (!text) {
    throw new Error("Clipboard text is required.");
  }

  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the native clipboard bridge below.
    }
  }

  await invoke("copy_to_clipboard", { text });
}
