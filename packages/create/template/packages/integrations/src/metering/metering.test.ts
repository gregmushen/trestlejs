import { describe, expect, it } from "vitest";

import { meterFor, usageDrift, validateMeterMappings } from "./types.js";

describe("metering port", () => {
  it("maps each stable feature code to exactly one provider meter", () => {
    const mappings = [{ featureCode: "api.requests", meter: "api_requests" }, { featureCode: "exports.generated", meter: "exports" }];
    expect(validateMeterMappings(mappings, ["api.requests", "exports.generated"])).toEqual([]);
    expect(validateMeterMappings([...mappings, { featureCode: "api.requests", meter: "other" }], ["api.requests", "exports.generated"])).toEqual(["api.requests is mapped more than once"]);
    expect(validateMeterMappings([{ featureCode: "seats", meter: "api_requests" }, { featureCode: "api.requests", meter: "api_requests" }], ["api.requests"]))
      .toEqual(["seats is not a metered feature", "meter api_requests is mapped to more than one feature"]);
    expect(meterFor(mappings, "exports.generated")).toBe("exports");
    expect(meterFor(mappings, "seats")).toBeNull();
  });

  it("explains drift between the local projection and the provider", () => {
    expect(usageDrift("api.requests", 10, 10).outcome).toBe("in_sync");
    expect(usageDrift("api.requests", 10, 7)).toEqual({ featureCode: "api.requests", local: 10, provider: 7, difference: -3, outcome: "provider_behind" });
    expect(usageDrift("api.requests", 10, 12).outcome).toBe("provider_ahead");
  });
});
