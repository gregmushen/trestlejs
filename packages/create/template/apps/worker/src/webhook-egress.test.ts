import { describe, expect, it, vi } from "vitest";

import { resolveWebhookDestination, validateWebhookDestination } from "./webhook-egress.js";

const resolver = (ipv4: string[], ipv6: string[] = []) => ({
  resolve4: vi.fn(async () => ipv4),
  resolve6: vi.fn(async () => ipv6),
});

describe("native webhook egress policy", () => {
  it("requires HTTPS and rejects URL credentials, fragments, and trailing-dot names", () => {
    for (const value of ["http://example.com/hook", "https://user:pass@example.com/hook", "https://example.com/hook#token", "https://example.com./hook", "file:///etc/passwd", "not a url"]) {
      expect(() => validateWebhookDestination(value)).toThrow();
    }
    expect(validateWebhookDestination("https://example.com:8443/hook?source=a").pathname).toBe("/hook");
  });

  it("resolves both address families for each attempt and carries the hostname for TLS", async () => {
    const first = resolver(["8.8.8.8"], ["2606:4700:4700::1111"]);
    expect(await resolveWebhookDestination("https://example.com:8443/hook", first)).toMatchObject({
      hostname: "example.com", port: 8443, addresses: ["8.8.8.8", "2606:4700:4700::1111"],
    });
    expect(first.resolve4).toHaveBeenCalledWith("example.com");
    expect(first.resolve6).toHaveBeenCalledWith("example.com");
    const rebound = resolver(["127.0.0.1"]);
    await expect(resolveWebhookDestination("https://example.com/hook", rebound)).rejects.toThrow("non-public");
  });

  it("rejects the whole DNS answer when any address is unsafe", async () => {
    for (const privateAddress of [
      "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1",
      "100.64.0.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "240.0.0.1",
      "::", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1",
    ]) {
      await expect(resolveWebhookDestination("https://example.com/hook", resolver(["8.8.8.8", privateAddress]))).rejects.toThrow("non-public");
    }
  });

  it("rejects unsafe IP literals without consulting DNS", async () => {
    const noDns = resolver([]);
    await expect(resolveWebhookDestination("https://127.0.0.1/hook", noDns)).rejects.toThrow("non-public");
    await expect(resolveWebhookDestination("https://[::1]/hook", noDns)).rejects.toThrow("non-public");
    expect(noDns.resolve4).not.toHaveBeenCalled();
    expect(noDns.resolve6).not.toHaveBeenCalled();
  });

  it("fails closed on missing records, invalid records, and resolver failure", async () => {
    await expect(resolveWebhookDestination("https://example.com", resolver([]))).rejects.toThrow("no resolved addresses");
    await expect(resolveWebhookDestination("https://example.com", resolver(["not-an-ip"]))).rejects.toThrow("invalid address");
    const missingIpv6 = Object.assign(new Error("no IPv6 records"), { code: "ENODATA" });
    expect((await resolveWebhookDestination("https://example.com", {
      resolve4: async () => ["8.8.8.8"], resolve6: async () => { throw missingIpv6; },
    })).addresses).toEqual(["8.8.8.8"]);
    await expect(resolveWebhookDestination("https://example.com", {
      resolve4: async () => ["8.8.8.8"], resolve6: async () => { throw new Error("DNS unavailable"); },
    })).rejects.toThrow("DNS unavailable");
  });
});
