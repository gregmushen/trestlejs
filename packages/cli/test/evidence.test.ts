import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { evidenceReport, readLedger, recordEvidence, starterLedger, writeLedger } from "../src/evidence.js";

const roots: string[] = [];
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-evidence-"));
  roots.push(root);
  await mkdir(path.join(root, ".trestle"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "evidence@example.test");
  git("config", "user.name", "Evidence");
  await writeLedger(root, starterLedger());
  git("add", "-A");
  git("commit", "-qm", "ledger");
  const commit = (message: string) => { git("add", "-A"); git("commit", "-qm", message); };
  return { root, commit };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("evidence ledger", () => {
  it("verifies a local claim only from a passing command on a clean tree", async () => {
    const { root, commit } = await repository();
    await expect(recordEvidence(root, "local-canary", { environment: "local", command: "exit 3" })).rejects.toThrow("the command exited 3");
    expect((await readLedger(root))!.claims["local-canary"]!.status).toBe("in-progress");
    commit("record failure");
    await writeFile(path.join(root, "scratch.txt"), "uncommitted");
    await expect(recordEvidence(root, "local-canary", { environment: "local", command: "true" })).rejects.toThrow("uncommitted changes");
    await rm(path.join(root, "scratch.txt"));
    commit("record dirty attempt");
    expect((await recordEvidence(root, "local-canary", { environment: "local", command: "true" })).status).toBe("verified");
  });

  it("never lets local success establish a deployed claim, and requires dependencies first", async () => {
    const { root, commit } = await repository();
    await expect(recordEvidence(root, "staging-canary", { environment: "local", command: "true" })).rejects.toThrow("local success cannot establish it");
    await expect(recordEvidence(root, "staging-canary", { environment: "staging", url: "https://ci.example/runs/1" })).rejects.toThrow("dependencies are not verified: local-canary");
    commit("attempt");
    await recordEvidence(root, "local-canary", { environment: "local", command: "true" });
    commit("local verified");
    expect((await recordEvidence(root, "staging-canary", { environment: "staging", url: "https://ci.example/runs/2" })).status).toBe("verified");
  });

  it("records several claims in a row without the ledger's own changes counting as uncommitted work", async () => {
    const { root } = await repository();
    await recordEvidence(root, "local-canary", { environment: "local", command: "true" });
    expect((await recordEvidence(root, "staging-canary", { environment: "staging", url: "https://ci.example/runs/3" })).status).toBe("verified");
  });

  it("reports proof from an older revision as stale", async () => {
    const { root, commit } = await repository();
    await recordEvidence(root, "local-canary", { environment: "local", command: "true" });
    expect((await evidenceReport(root)).claims.find((claim) => claim.id === "local-canary")).toMatchObject({ status: "verified", stale: false });
    await writeFile(path.join(root, "feature.txt"), "change");
    commit("new work");
    expect((await evidenceReport(root)).claims.find((claim) => claim.id === "local-canary")).toMatchObject({ status: "verified", stale: true });
  });

  it("rejects dependencies on unknown claims", async () => {
    const { root } = await repository();
    const ledger = starterLedger();
    ledger.claims["staging-canary"]!.dependsOn = ["missing"];
    await expect(writeLedger(root, ledger)).rejects.toThrow("depends on unknown claims: missing");
  });
});
