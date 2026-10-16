import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensurePrivateProjectsWorkspace } from "../src/infra/doctor.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function project() { const root = await mkdtemp(path.join(tmpdir(), "trestle-workspace-")); roots.push(root); await mkdir(path.join(root, ".trestle")); return root; }

it("creates and reuses caller-owned private Projects workspaces", async () => {
  const root = await project();
  const workspace = await ensurePrivateProjectsWorkspace(root, "production");
  expect((await lstat(workspace)).mode & 0o777).toBe(0o700);
  expect(await ensurePrivateProjectsWorkspace(root, "production")).toBe(workspace);
});

it("refuses symlinked or world-readable private workspace parents", async () => {
  const root = await project();
  const other = await project();
  const local = path.join(root, ".trestle/infrastructure.local");
  await symlink(other, local);
  await expect(ensurePrivateProjectsWorkspace(root, "production")).rejects.toThrow(/symlinks/);
  await rm(local);
  await mkdir(local);
  await chmod(local, 0o755);
  await expect(ensurePrivateProjectsWorkspace(root, "production")).rejects.toThrow(/private/);
});
