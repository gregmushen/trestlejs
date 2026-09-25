import { describe, expect, it } from "vitest";

import { statusVariant } from "./ui";
import { sanitizeSearch } from "./url-state";

describe("Trestle Kumo adapters", () => {
  it("maps domain states to semantic status variants", () => {
    expect(["active", "succeeded", "sent", "healthy", "in_sync"].map(statusVariant)).toEqual(["success", "success", "success", "success", "success"]);
    expect(["pending", "paused", "grandfathered", "draft"].map(statusVariant)).toEqual(["warning", "warning", "warning", "warning"]);
    expect(["failed", "revoked", "suspended", "disabled", "expired"].map(statusVariant)).toEqual(["destructive", "destructive", "destructive", "destructive", "destructive"]);
    expect(statusVariant("something-new")).toBe("neutral");
    expect(statusVariant(undefined)).toBe("neutral");
  });

  it("keeps URL state to short, safe tokens so links never carry secrets or markup", () => {
    expect(sanitizeSearch({ selected: "org_123", q: "Acme Inc", page: 2, empty: "", nested: { a: 1 } })).toEqual({ selected: "org_123", q: "Acme Inc", page: "2" });
    expect(sanitizeSearch({ token: "tr_live_abc/def+ghi=", html: "<script>" })).toEqual({});
    expect(sanitizeSearch({ long: "x".repeat(201) })).toEqual({});
    expect(sanitizeSearch(null)).toEqual({});
  });
});
