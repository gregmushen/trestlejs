import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertSafeArguments, nodeProcessRunner, ProcessSpecError } from "../src/infra/process.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function script(body: string): Promise<{ executable: string; cwd: string }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "trestle-process-"));
  directories.push(cwd);
  const executable = path.join(cwd, "tool");
  await writeFile(executable, `#!${process.execPath}\n${body}`);
  await chmod(executable, 0o755);
  return { executable, cwd };
}

const spec = (executable: string, cwd: string, args: string[] = []) => ({ executable, args, cwd, env: { PATH: "/usr/bin:/bin" }, timeoutMs: 5000, maxOutputBytes: 10_000 });

describe("trusted process runner", () => {
  it("rejects shell syntax, whitespace and control characters before spawning", async () => {
    const { executable, cwd } = await script("require('fs').writeFileSync('spawned', '1')");
    for (const hostile of ["db; rm -rf /", "$(id)", "`id`", "a b", "line\nbreak", "x|y", "a&b", "", "quote'd", "dollar$HOME"]) {
      expect(() => assertSafeArguments([hostile]), hostile).toThrow(ProcessSpecError);
      await expect(nodeProcessRunner.run(spec(executable, cwd, [hostile]))).rejects.toThrow(ProcessSpecError);
    }
    await expect(import("node:fs/promises").then((fs) => fs.stat(path.join(cwd, "spawned")))).rejects.toThrow();
  });

  it("refuses PATH lookup of executables", async () => {
    await expect(nodeProcessRunner.run(spec("stripe", os.tmpdir()))).rejects.toThrow(/absolute paths/u);
  });

  it("passes only the supplied environment", async () => {
    const { executable, cwd } = await script("process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))");
    process.env.TRESTLE_PROCESS_TEST_SECRET = "should-not-leak";
    try {
      const result = await nodeProcessRunner.run(spec(executable, cwd));
      expect(JSON.parse(result.stdout).filter((key: string) => key !== "__CF_USER_TEXT_ENCODING")).toEqual(["PATH"]);
    } finally {
      delete process.env.TRESTLE_PROCESS_TEST_SECRET;
    }
  });

  it("kills a process that exceeds its time bound", async () => {
    const { executable, cwd } = await script("setTimeout(() => {}, 1e9)");
    const result = await nodeProcessRunner.run({ ...spec(executable, cwd), timeoutMs: 200 });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
  });

  it("stops reading and kills a process that exceeds its output bound", async () => {
    const { executable, cwd } = await script("process.stdout.write('x'.repeat(100000)); setTimeout(() => {}, 1e9)");
    const result = await nodeProcessRunner.run({ ...spec(executable, cwd), maxOutputBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });
});
