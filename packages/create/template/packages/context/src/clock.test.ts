import { describe, expect, it } from "vitest";
import { createTestClock } from "./index.js";

describe("fixed test clock", () => {
  it("advances business time without sleeping", () => {
    const clock = createTestClock("2026-09-22T09:00:00.000Z");
    expect(clock.advance({ days: 1, hours: 2 }).toISOString()).toBe("2026-09-23T11:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-09-23T11:00:00.000Z");
  });

  it("returns defensive Date copies and rejects time travel", () => {
    const clock = createTestClock();
    clock.now().setUTCFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
    expect(() => clock.advance({ seconds: -1 })).toThrow("non-negative");
  });
});
