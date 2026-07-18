import { describe, expect, it } from "vitest";
import {
  isRestrictedNetworkAddress,
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

  it("rejects metadata and localhost destinations even with insecure access", async () => {
    await expect(
      validateExternalApiDestination("http://169.254.169.254", true),
    ).rejects.toThrow(/reserved/i);
    await expect(
      validateExternalApiDestination("http://localhost:18422", true),
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
});
