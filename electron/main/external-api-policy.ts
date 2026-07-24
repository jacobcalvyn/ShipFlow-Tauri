import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata.google",
]);

function parseIpv4(address: string) {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet))
    ? octets
    : null;
}

export function isForbiddenNetworkAddress(address: string) {
  if (isIP(address) === 4) {
    const [first, second] = parseIpv4(address)!;
    return (
      first === 0 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      first >= 224
    );
  }

  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isForbiddenNetworkAddress(normalized.slice("::ffff:".length));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }

  return true;
}

export function isRestrictedNetworkAddress(address: string) {
  if (isForbiddenNetworkAddress(address)) {
    return true;
  }
  if (isIP(address) === 4) {
    const octets = parseIpv4(address)!;
    const [first, second] = octets;
    return (
      first === 10 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19))
    );
  }

  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isRestrictedNetworkAddress(normalized.slice("::ffff:".length));
    }
    return (
      normalized.startsWith("fc") ||
      normalized.startsWith("fd")
    );
  }

  return true;
}

export type ResolvedNetworkAddress = {
  address: string;
  family: 4 | 6;
};

type ResolvedExternalApiDestination = {
  addresses: ResolvedNetworkAddress[];
  baseUrl: string;
};

export function createPinnedLookupForAddresses(
  addresses: ResolvedNetworkAddress[],
): LookupFunction {
  if (addresses.length === 0) {
    throw new Error("At least one pinned network address is required.");
  }
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const selected = addresses[0]!;
    callback(null, selected.address, selected.family);
  };
}

export function createPinnedLookup(
  address: string,
  family: 4 | 6,
): LookupFunction {
  return createPinnedLookupForAddresses([{ address, family }]);
}

export function normalizeExternalApiBaseUrl(rawBaseUrl: string) {
  const parsed = new URL(rawBaseUrl.trim());
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("External API URL cannot contain credentials or a fragment.");
  }
  parsed.hostname = parsed.hostname.replace(/\.$/, "");

  const pathSegments = parsed.pathname
    .split("/")
    .filter(Boolean);
  const finalSegment = pathSegments.at(-1)?.toLowerCase();
  const previousSegment = pathSegments.at(-2)?.toLowerCase();
  if (previousSegment === "v1" && finalSegment === "openapi.json") {
    pathSegments.splice(-2);
  } else if (finalSegment === "v1") {
    pathSegments.pop();
  }
  parsed.pathname = pathSegments.length === 0 ? "/" : `/${pathSegments.join("/")}/`;
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

async function resolveExternalApiDestination(
  rawBaseUrl: string,
  allowPrivateOrInsecure: boolean,
): Promise<ResolvedExternalApiDestination> {
  const parsed = normalizeExternalApiBaseUrl(rawBaseUrl);
  if (
    parsed.protocol !== "https:" &&
    !(allowPrivateOrInsecure && parsed.protocol === "http:")
  ) {
    throw new Error("External API must use HTTPS unless insecure access is explicitly enabled.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname === "169.254.169.254"
  ) {
    throw new Error("External API destination is reserved and cannot be used.");
  }

  const literalFamily = isIP(hostname);
  const addresses: Array<{ address: string; family: 4 | 6 }> = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : (await lookup(hostname, { all: true, verbatim: true })).filter(
        (entry): entry is { address: string; family: 4 | 6 } =>
          entry.family === 4 || entry.family === 6,
      );
  if (addresses.length === 0) {
    throw new Error("External API hostname did not resolve to an address.");
  }
  if (addresses.some(({ address }) => isForbiddenNetworkAddress(address))) {
    throw new Error("External API destination is reserved and cannot be used.");
  }
  if (
    !allowPrivateOrInsecure &&
    addresses.some(({ address }) => isRestrictedNetworkAddress(address))
  ) {
    throw new Error(
      "External API resolves to a private or local address. Enable insecure access only for an intentional trusted LAN deployment.",
    );
  }

  return {
    addresses,
    baseUrl: parsed.toString().replace(/\/$/, ""),
  };
}

export async function validateExternalApiDestination(
  rawBaseUrl: string,
  allowPrivateOrInsecure: boolean,
) {
  return (await resolveExternalApiDestination(rawBaseUrl, allowPrivateOrInsecure)).baseUrl;
}

export async function probeExternalApiAuth(
  rawBaseUrl: string,
  allowPrivateOrInsecure: boolean,
  authToken: string,
  timeoutMs = 10_000,
) {
  const destination = await resolveExternalApiDestination(
    rawBaseUrl,
    allowPrivateOrInsecure,
  );
  const url = new URL(`${destination.baseUrl}/v1/auth/check`);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;

  await new Promise<void>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        headers: { Authorization: `Bearer ${authToken}` },
        lookup: createPinnedLookupForAddresses(destination.addresses),
        method: "GET",
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            reject(new Error("External ShipFlow API redirects are not allowed."));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new Error(`External ShipFlow API returned HTTP ${status}.`));
            return;
          }
          resolve();
        });
      },
    );
    outgoing.setTimeout(timeoutMs, () => {
      outgoing.destroy(new Error("External ShipFlow API request timed out."));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });

  return destination.baseUrl;
}
