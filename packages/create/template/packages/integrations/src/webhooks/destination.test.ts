import { describe, expect, it } from "vitest";

import { isPublicWebhookAddress, parseNativeWebhookDestination, resolveNativeWebhookDestination } from "./destination.js";

describe("native webhook destination policy", () => {
  it.each([
    "0.0.0.0", "10.2.3.4", "100.100.100.200", "127.0.0.1", "169.254.169.254",
    "172.20.1.2", "192.0.0.5", "192.0.2.1", "192.168.1.1", "198.18.0.1",
    "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
    "2001::1", "2001:10::1", "2002:0a00:0001::1", "3fff::1",
    "not-an-ip", "2001:::1", "1.2.3.999",
  ])("rejects non-public address %s", (address) => {
    expect(isPublicWebhookAddress(address)).toBe(false);
  });

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts public address %s", (address) => {
    expect(isPublicWebhookAddress(address)).toBe(true);
  });

  it.each([
    "http://example.com/hook", "https://user:pass@example.com/hook", "https://example.com/hook#token",
    "https://localhost/hook", "https://api.local/hook", "https://metadata.google.internal/",
    "https://127.1/hook", "https://2130706433/hook", "https://[::1]/hook",
    "https://169.254.169.254/latest/meta-data/", "https://example.test/hook", "https://example.com\n/hook",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => parseNativeWebhookDestination(url)).toThrow();
  });

  it("normalizes a public HTTPS URL and rejects a private answer in a mixed DNS set", async () => {
    expect(parseNativeWebhookDestination("https://Hooks.Example.COM.:8443/receive?tenant=a")).toEqual({
      url: "https://hooks.example.com:8443/receive?tenant=a", hostname: "hooks.example.com", port: 8443,
    });
    await expect(resolveNativeWebhookDestination("https://hooks.example.com/", { resolveAll: async () => ["1.1.1.1", "10.0.0.1"] })).rejects.toThrow("exclusively to public");
    await expect(resolveNativeWebhookDestination("https://hooks.example.com/", { resolveAll: async () => [] })).rejects.toThrow("exclusively to public");
  });

  it("re-resolves before every attempt and never reuses a previously safe answer", async () => {
    let calls = 0;
    const resolver = { resolveAll: async () => ++calls === 1 ? ["1.1.1.1"] : ["169.254.169.254"] };
    expect(await resolveNativeWebhookDestination("https://hooks.example.com/receive", resolver)).toMatchObject({ approvedAddress: "1.1.1.1", hostname: "hooks.example.com" });
    await expect(resolveNativeWebhookDestination("https://hooks.example.com/receive", resolver)).rejects.toThrow("exclusively to public");
    expect(calls).toBe(2);
  });

  it("uses a public literal directly without asking DNS", async () => {
    const resolver = { resolveAll: async () => { throw new Error("DNS must not be called for a literal"); } };
    expect(await resolveNativeWebhookDestination("https://8.8.8.8/hook", resolver)).toMatchObject({ approvedAddress: "8.8.8.8" });
    expect(await resolveNativeWebhookDestination("https://[2606:4700:4700::1111]/hook", resolver)).toMatchObject({ approvedAddress: "2606:4700:4700::1111" });
  });
});
