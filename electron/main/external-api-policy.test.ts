import { describe, expect, it } from "vitest";
import {
  createPinnedLookup,
  createPinnedLookupForAddresses,
  isForbiddenNetworkAddress,
  isRestrictedNetworkAddress,
  normalizeExternalApiBaseUrl,
  validateExternalApiDestination,
} from "./external-api-policy";

describe("external API destination policy", () => {
  it("rejects reserved IP ranges", () => {
    expect(isRestrictedNetworkAddress("127.0.0.1")).toBe(true);
    expect(isRestrictedNetworkAddress("169.254.169.254")).toBe(true);
    expect(isRestrictedNetworkAddress("10.1.2.3")).toBe(true);
    expect(isRestrictedNetworkAddress("::1")).toBe(true);
    expect(isRestrictedNetworkAddress("8.8.8.8")).toBe(false);
  });

  it("keeps forbidden destinations blocked when trusted LAN access is enabled", () => {
    expect(isForbiddenNetworkAddress("127.0.0.1")).toBe(true);
    expect(isForbiddenNetworkAddress("169.254.169.254")).toBe(true);
    expect(isForbiddenNetworkAddress("192.168.1.20")).toBe(false);
  });

  it("rejects metadata and localhost destinations even with insecure access", async () => {
    await expect(
      validateExternalApiDestination("http://169.254.169.254", true),
    ).rejects.toThrow(/reserved/i);
    await expect(
      validateExternalApiDestination("http://localhost:18422", true),
    ).rejects.toThrow(/reserved/i);
    await expect(
      validateExternalApiDestination("http://127.0.0.1:18422", true),
    ).rejects.toThrow(/reserved/i);
  });

  it("allows an explicitly trusted private IP without DNS lookup", async () => {
    await expect(
      validateExternalApiDestination("http://192.168.1.20:18422", true),
    ).resolves.toBe("http://192.168.1.20:18422");
  });

  it("rejects private IPs without explicit insecure access", async () => {
    await expect(
      validateExternalApiDestination("https://10.0.0.2", false),
    ).rejects.toThrow(/private or local/i);
  });

  it("returns a single pinned address for standard Node lookups", async () => {
    const pinnedLookup = createPinnedLookup("203.0.113.10", 4);
    await expect(
      new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
        pinnedLookup("external.example", { all: false }, (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ address, family });
        });
      }),
    ).resolves.toEqual({
      address: "203.0.113.10",
      family: 4,
    });
  });

  it("returns an address array when Node requests all lookup results", async () => {
    const pinnedLookup = createPinnedLookup("2001:db8::10", 6);
    await expect(
      new Promise<unknown>((resolve, reject) => {
        pinnedLookup("external.example", { all: true }, (error, addresses) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(addresses);
        });
      }),
    ).resolves.toEqual([
      {
        address: "2001:db8::10",
        family: 6,
      },
    ]);
  });

  it("returns every validated address when Node requests all lookup results", async () => {
    const pinnedLookup = createPinnedLookupForAddresses([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ]);
    await expect(
      new Promise<unknown>((resolve, reject) => {
        pinnedLookup("external.example", { all: true }, (error, addresses) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(addresses);
        });
      }),
    ).resolves.toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ]);
  });

  it.each([
    ["https://api.example.test", "https://api.example.test/"],
    ["https://api.example.test/v1", "https://api.example.test/"],
    ["https://api.example.test/V1", "https://api.example.test/"],
    [
      "https://api.example.test/v1/openapi.json",
      "https://api.example.test/",
    ],
    [
      "https://api.example.test/proxy/v1",
      "https://api.example.test/proxy/",
    ],
    ["https://api.example.test./v1", "https://api.example.test/"],
  ])("normalizes supported API base URL forms", (input, expected) => {
    expect(normalizeExternalApiBaseUrl(input).toString()).toBe(expected);
  });
});
