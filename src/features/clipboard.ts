import { copyToClipboard, readFromClipboard } from "../backend/commands";

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

  await copyToClipboard(text);
}

export async function readClipboardText() {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.readText === "function"
  ) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Fall through to the native clipboard bridge below.
    }
  }

  return readFromClipboard();
}
