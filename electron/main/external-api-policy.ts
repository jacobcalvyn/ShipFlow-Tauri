import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

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

export function isRestrictedNetworkAddress(address: string) {
  if (isIP(address) === 4) {
    const octets = parseIpv4(address)!;
    const [first, second] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }

  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isRestrictedNetworkAddress(normalized.slice("::ffff:".length));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }

  return true;
}

type ResolvedExternalApiDestination = {
  address: string;
  baseUrl: string;
  family: 4 | 6;
};

async function resolveExternalApiDestination(
  rawBaseUrl: string,
  allowPrivateOrInsecure: boolean,
): Promise<ResolvedExternalApiDestination> {
  const parsed = new URL(rawBaseUrl.trim().replace(/\/$/, ""));
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("External API URL cannot contain credentials or a fragment.");
  }
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
  if (
    !allowPrivateOrInsecure &&
    addresses.some(({ address }) => isRestrictedNetworkAddress(address))
  ) {
    throw new Error(
      "External API resolves to a private or local address. Enable insecure access only for an intentional trusted LAN deployment.",
    );
  }

  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error("External API hostname did not resolve to a supported address.");
  }

  return {
    address: selected.address,
    baseUrl: parsed.toString().replace(/\/$/, ""),
    family: selected.family,
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
        lookup: (_hostname, _options, callback) => {
          callback(null, destination.address, destination.family);
        },
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
