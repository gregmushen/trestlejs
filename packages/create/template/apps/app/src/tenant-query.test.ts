import { describe, expect, it } from "vitest";

import { billingSubscriptionQueryKey } from "./tenant-query.js";

describe("tenant-scoped billing cache", () => {
  it("separates organizations and signed-in users", () => {
    const first = billingSubscriptionQueryKey("user-a", "org-a");
    expect(first).toEqual(["billing-subscription", "user-a", "org-a"]);
    expect(billingSubscriptionQueryKey("user-a", "org-b")).not.toEqual(first);
    expect(billingSubscriptionQueryKey("user-b", "org-a")).not.toEqual(first);
    expect(billingSubscriptionQueryKey(undefined, "org-a")).not.toEqual(first);
    expect(billingSubscriptionQueryKey("user-a", undefined)).not.toEqual(first);
  });
});
