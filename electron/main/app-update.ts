type UpdateCheckResultLike = {
  isUpdateAvailable: boolean;
  updateInfo?: {
    version?: string;
    releaseNotes?: unknown;
  };
} | null;

export function appUpdateStatus(
  result: UpdateCheckResultLike,
  currentVersion: string,
) {
  const available = Boolean(result?.isUpdateAvailable);
  const info = result?.updateInfo;
  return {
    available,
    currentVersion,
    version: available ? info?.version ?? null : null,
    body:
      available && typeof info?.releaseNotes === "string"
        ? info.releaseNotes
        : null,
    downloadUrl: null,
  };
}
