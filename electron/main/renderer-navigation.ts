import path from "node:path";
import { fileURLToPath } from "node:url";

export function isTrustedRendererNavigation(
  targetUrl: string,
  developmentRendererUrl: string | undefined,
  packagedRendererPath: string,
) {
  try {
    const target = new URL(targetUrl);
    if (developmentRendererUrl) {
      const development = new URL(developmentRendererUrl);
      return (
        target.origin === development.origin &&
        target.pathname === development.pathname
      );
    }
    return (
      target.protocol === "file:" &&
      path.resolve(fileURLToPath(target)) === path.resolve(packagedRendererPath)
    );
  } catch {
    return false;
  }
}
