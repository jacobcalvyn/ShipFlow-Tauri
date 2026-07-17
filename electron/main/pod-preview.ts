import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

function isAllowedPodHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "posindonesia.co.id" || normalized.endsWith(".posindonesia.co.id");
}

function isForbiddenIp(address: string) {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    return (
      parts[0] === 0 ||
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] >= 224
    );
  }
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  );
}

function normalizeImageSource(source: string) {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error("Image source is required.");
  }
  if (trimmed.startsWith("data:image/")) {
    if (trimmed.toLowerCase().startsWith("data:image/svg+xml")) {
      throw new Error("SVG POD images are not supported.");
    }
    if (trimmed.length > MAX_IMAGE_BYTES * 2) {
      throw new Error("POD image source is too large to preview safely.");
    }
    return trimmed;
  }
  if (/^[A-Za-z0-9+/=_\s-]+$/.test(trimmed) && trimmed.length > 128) {
    const compact = trimmed.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Buffer.from(compact, "base64");
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new Error("POD image source is too large to preview safely.");
    }
    const mime = compact.startsWith("iVBOR") ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  return new URL(
    trimmed.startsWith("http://") || trimmed.startsWith("https://")
      ? trimmed
      : `https://pid.posindonesia.co.id${trimmed.startsWith("/") ? "" : "/"}${trimmed}`,
  );
}

async function validateRemoteUrl(url: URL) {
  if (url.protocol !== "https:") {
    throw new Error("POD image source must use HTTPS.");
  }
  if (url.username || url.password || !isAllowedPodHostname(url.hostname)) {
    throw new Error("POD image source host is not allowed.");
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isForbiddenIp(address))) {
    throw new Error("POD image source host is not allowed.");
  }
}

export async function resolvePodImage(source: string, depth = 0): Promise<string> {
  if (depth > MAX_REDIRECTS) {
    throw new Error("POD image source redirected too many times.");
  }
  const normalized = normalizeImageSource(source);
  if (typeof normalized === "string") {
    return normalized;
  }
  await validateRemoteUrl(normalized);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(normalized, {
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) {
      throw new Error("POD image redirect is missing location header.");
    }
    return resolvePodImage(new URL(location, normalized).toString(), depth + 1);
  }
  if (!response.ok) {
    throw new Error(`POD image source returned HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error("POD image source is too large to preview safely.");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error("POD image source is too large to preview safely.");
  }
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType?.startsWith("image/") && contentType !== "image/svg+xml") {
    return `data:${contentType};base64,${buffer.toString("base64")}`;
  }
  const body = buffer.toString("utf8").trim();
  const imageMatch = body.match(/<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["']/i);
  if (imageMatch?.[1]) {
    return resolvePodImage(new URL(imageMatch[1], normalized).toString(), depth + 1);
  }
  return resolvePodImage(body, depth + 1);
}
