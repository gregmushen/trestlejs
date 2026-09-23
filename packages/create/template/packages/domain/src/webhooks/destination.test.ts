import { describe, expect, it } from "vitest";

import { isPrivateAddress, publicDestinationGuard, validateEndpointUrl } from "./model.js";

const dns = (answers: Record<string, string[]>) => async (url: string) => {
  const parsed = new URL(url);
  const data = answers[`${parsed.searchParams.get("name")}/${parsed.searchParams.get("type")}`] ?? [];
  return new Response(JSON.stringify({ Answer: data.map((value) => ({ type: parsed.searchParams.get("type") === "A" ? 1 : 28, data: value })) }));
};

describe("webhook destination defenses", () => {
  it("recognizes private, loopback, metadata, CGNAT, and mapped addresses", () => {
    for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "[::1]"]) expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateAddress(address), address).toBe(false);
  });

  it("refuses private and metadata targets at creation, including disguised forms", () => {
    for (const url of ["https://169.254.169.254/latest/meta-data", "https://metadata.google.internal/", "https://10.1.2.3/hook", "https://2130706433/hook", "https://[::1]/hook", "http://example.com/hook"]) {
      expect(() => validateEndpointUrl(url, "production"), url).toThrow();
    }
    expect(validateEndpointUrl("https://hooks.example.com/in", "production").hostname).toBe("hooks.example.com");
  });

  it("re-resolves at delivery time and blocks a name rebound to a private address", async () => {
    const guard = publicDestinationGuard(dns({ "hooks.example.com/A": ["93.184.216.34"], "rebound.example.com/A": ["93.184.216.34", "10.0.0.5"], "gone.example.com/A": [] }));
    expect(await guard("https://hooks.example.com/in")).toBeNull();
    expect(await guard("https://rebound.example.com/in")).toBe("destination resolves to a private address");
    expect(await guard("https://gone.example.com/in")).toBe("destination does not resolve");
    expect(await guard("https://127.0.0.1/in")).toBe("destination is a private address");
  });
});
