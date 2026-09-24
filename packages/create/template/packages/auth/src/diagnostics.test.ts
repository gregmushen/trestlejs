import { describe, expect, it } from "vitest";
import { shouldLogAuthError } from "./index.js";

describe("auth failure diagnostics", () => {
  it("ignores expected denials but reports unexpected failures", () => {
    for (const status of ["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", 400, 401, 403, 404, 409]) {
      expect(shouldLogAuthError({ status })).toBe(false);
    }
    expect(shouldLogAuthError({ status: "INTERNAL_SERVER_ERROR" })).toBe(true);
    expect(shouldLogAuthError(Object.assign(new Error("private"), { code: "ECONNRESET" }))).toBe(true);
    expect(shouldLogAuthError(null)).toBe(true);
    expect(shouldLogAuthError(Object.defineProperty({}, "status", { get: () => { throw new Error("private"); } }))).toBe(true);
  });
});
