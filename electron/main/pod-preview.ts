import { promises as dns } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  createPinnedLookupForAddresses,
  isRestrictedNetworkAddress,
  type ResolvedNetworkAddress,
} from "./external-api-policy";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

type PodSourceResponse = {
  body: Buffer;
  headers: IncomingHttpHeaders;
  status: number;
};

function isAllowedPodHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "posindonesia.co.id" || normalized.endsWith(".posindonesia.co.id");
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

async function resolveRemoteAddresses(url: URL): Promise<ResolvedNetworkAddress[]> {
  if (url.protocol !== "https:") {
    throw new Error("POD image source must use HTTPS.");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    !isAllowedPodHostname(url.hostname)
  ) {
    throw new Error("POD image source host is not allowed.");
  }

  const literalFamily = isIP(url.hostname);
  const addresses: ResolvedNetworkAddress[] = literalFamily
    ? [{ address: url.hostname, family: literalFamily as 4 | 6 }]
    : (await dns.lookup(url.hostname, { all: true, verbatim: true })).filter(
        (entry): entry is ResolvedNetworkAddress =>
          entry.family === 4 || entry.family === 6,
      );
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isRestrictedNetworkAddress(address))
  ) {
    throw new Error("POD image source host is not allowed.");
  }
  return addresses;
}

export async function readStreamLimited(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number,
) {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new Error("POD image source is too large to preview safely.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes);
}

async function requestPodSource(
  url: URL,
  addresses: ResolvedNetworkAddress[],
): Promise<PodSourceResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, response?: PodSourceResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(response!);
      }
    };
    const outgoing = httpsRequest(
      url,
      {
        lookup: createPinnedLookupForAddresses(addresses),
        method: "GET",
      },
      (response) => {
        const contentLength = Number(response.headers["content-length"] || 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
          response.destroy();
          finish(new Error("POD image source is too large to preview safely."));
          return;
        }
        void readStreamLimited(response, MAX_IMAGE_BYTES)
          .then((body) => {
            finish(undefined, {
              body,
              headers: response.headers,
              status: response.statusCode ?? 0,
            });
          })
          .catch((error) => {
            response.destroy();
            finish(error instanceof Error ? error : new Error(String(error)));
          });
      },
    );
    outgoing.setTimeout(REQUEST_TIMEOUT_MS, () => {
      outgoing.destroy(new Error("POD image source request timed out."));
    });
    outgoing.once("error", (error) => finish(error));
    outgoing.end();
  });
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export async function resolvePodImage(source: string, depth = 0): Promise<string> {
  if (depth > MAX_REDIRECTS) {
    throw new Error("POD image source redirected too many times.");
  }
  const normalized = normalizeImageSource(source);
  if (typeof normalized === "string") {
    return normalized;
  }
  const addresses = await resolveRemoteAddresses(normalized);
  const response = await requestPodSource(normalized, addresses);
  if (response.status >= 300 && response.status < 400) {
    const location = firstHeaderValue(response.headers.location);
    if (!location) {
      throw new Error("POD image redirect is missing location header.");
    }
    return resolvePodImage(new URL(location, normalized).toString(), depth + 1);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`POD image source returned HTTP ${response.status}.`);
  }

  const contentType = firstHeaderValue(response.headers["content-type"])
    ?.split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType?.startsWith("image/") && contentType !== "image/svg+xml") {
    return `data:${contentType};base64,${response.body.toString("base64")}`;
  }
  const body = response.body.toString("utf8").trim();
  const imageMatch = body.match(/<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["']/i);
  if (imageMatch?.[1]) {
    return resolvePodImage(new URL(imageMatch[1], normalized).toString(), depth + 1);
  }
  return resolvePodImage(body, depth + 1);
}
