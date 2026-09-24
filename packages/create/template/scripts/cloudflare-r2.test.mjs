import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { r2Client } from "./cloudflare-r2.mjs";

const accountId = "0123456789abcdef0123456789abcdef";
const bucketName = "example-worker-pr-1-artifacts";

test("R2 bucket provisioning converges by exact name without printing credentials", async () => {
  let exists = false;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method ?? "GET", authorization: options.headers.authorization });
    if (options.method === "POST") { exists = true; return Response.json({ success: true, result: { name: bucketName } }); }
    return exists ? Response.json({ success: true, result: { name: bucketName } }) : Response.json({ success: false }, { status: 404 });
  };
  const client = r2Client({ accountId, token: "private-token", fetcher });
  assert.deepEqual(await client.ensure(bucketName), { name: bucketName, state: "created" });
  assert.deepEqual(await client.ensure(bucketName), { name: bucketName, state: "existing" });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.ok(calls.every((call) => call.authorization === "Bearer private-token"));
});

test("R2 cleanup deletes only the exact empty preview bucket and accepts absence", async () => {
  let exists = true;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, method: options.method ?? "GET" });
    if (options.method === "DELETE") { exists = false; return Response.json({ success: true, result: {} }); }
    return exists ? Response.json({ success: true, result: { name: bucketName } }) : Response.json({ success: false }, { status: 404 });
  };
  const client = r2Client({ accountId, token: "private-token", fetcher });
  assert.deepEqual(await client.remove(bucketName), { name: bucketName, state: "deleted" });
  assert.equal(calls.find((call) => call.method === "DELETE")?.url.endsWith(`/r2/buckets/${bucketName}`), true);
  assert.deepEqual(await client.remove(bucketName), { name: bucketName, state: "absent" });
});

test("R2 verification checks the exact bucket without printing credentials", async () => {
  let result = { name: bucketName };
  const client = r2Client({ accountId, token: "private-token", fetcher: async () => result ? Response.json({ success: true, result }) : Response.json({ success: false }, { status: 404 }) });
  assert.deepEqual(await client.verify(bucketName), { name: bucketName, state: "present" });
  result = { name: "another-bucket" };
  await assert.rejects(client.verify(bucketName), /invalid identity/u);
  result = null;
  await assert.rejects(client.verify(bucketName), (error) => {
    assert.doesNotMatch(error.message, /private-token/u);
    return /missing or has an invalid identity/u.test(error.message);
  });
});

test("R2 failures fail closed and nonempty buckets are never purged", async () => {
  const unauthorized = r2Client({ accountId, token: "private-token", fetcher: async () => Response.json({ success: false }, { status: 403 }) });
  await assert.rejects(unauthorized.ensure(bucketName), /HTTP 403/u);
  const nonempty = r2Client({ accountId, token: "private-token", fetcher: async (_url, options) => options.method === "DELETE" ? Response.json({ success: false }, { status: 409 }) : Response.json({ success: true, result: { name: bucketName } }) });
  await assert.rejects(nonempty.remove(bucketName), /HTTP 409/u);
  const cli = spawnSync(process.execPath, [new URL("./cloudflare-r2.mjs", import.meta.url).pathname, "delete-preview", "example-worker-staging"], { encoding: "utf8" });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /only isolated preview R2 buckets/u);
});

test("disabled R2 capability requires no credentials", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "trestle-disabled-r2-")));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, ".trestle"));
    await copyFile(new URL("./cloudflare-r2.mjs", import.meta.url), join(root, "scripts/cloudflare-r2.mjs"));
    await copyFile(new URL("./queue-config.mjs", import.meta.url), join(root, "scripts/queue-config.mjs"));
    await writeFile(join(root, ".trestle/project.yaml"), "capabilities:\n  queues: false\n  r2: false\n  workflows: false\n");
    for (const operation of ["ensure", "verify"]) {
      const cli = spawnSync(process.execPath, [join(root, "scripts/cloudflare-r2.mjs"), operation, "example-worker-pr-1"], {
        encoding: "utf8", env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
      });
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /R2 disabled; no resources changed/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
