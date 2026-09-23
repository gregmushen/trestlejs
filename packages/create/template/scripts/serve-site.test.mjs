import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSiteServer, resolveSitePath } from "./serve-site.mjs";

test("built site preview serves routes and assets without escaping its root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trestle-site-preview-"));
  const server = createSiteServer(root);
  try {
    await mkdir(path.join(root, "pricing"));
    await writeFile(path.join(root, "index.html"), "<h1>Home</h1>");
    await writeFile(path.join(root, "pricing", "index.html"), "<h1>Pricing</h1>");
    await writeFile(path.join(root, "app.css"), "body { color: blue; }");
    server.listen(0);
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://localhost:${address.port}`;
    assert.match(await (await fetch(origin)).text(), /Home/u);
    assert.match(await (await fetch(`${origin}/pricing/`)).text(), /Pricing/u);
    assert.match((await fetch(`${origin}/app.css`)).headers.get("content-type") ?? "", /text\/css/u);
    assert.equal((await fetch(`${origin}/missing`)).status, 404);
    assert.equal((await fetch(origin, { method: "POST" })).status, 405);
    assert.equal(resolveSitePath(root, "/%2e%2e/%2e%2e/private"), null);
    assert.equal(resolveSitePath(root, "/%5cprivate"), null);
  } finally {
    server.close();
    await rm(root, { recursive: true });
  }
});
