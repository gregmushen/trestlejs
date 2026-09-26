import { describe, expect, it } from "vitest";

import { resolveApprovedScript, UnapprovedScriptError } from "./scripts.js";

describe("approved scripts", () => {
  it("runs only registered scripts with validated input passed as one JSON argument", () => {
    expect(resolveApprovedScript({ script: "echo-input", input: { message: "hi" } })).toEqual({ file: "./python/echo_input.py", argument: "{\"message\":\"hi\"}" });
  });

  it("refuses paths, commands, unknown names, and invalid input", () => {
    for (const script of ["../../etc/passwd", "rm -rf /", "echo_input.py", "__proto__", "toString", 42]) {
      expect(() => resolveApprovedScript({ script, input: {} })).toThrow(UnapprovedScriptError);
    }
    expect(() => resolveApprovedScript({ script: "echo-input", input: { message: "hi", command: "id" } })).toThrow("invalid");
  });
});
