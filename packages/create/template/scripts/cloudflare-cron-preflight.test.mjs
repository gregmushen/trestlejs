import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyCronCapacity } from "./cloudflare-cron-preflight.mjs";
import { FRAMEWORK_CRONS } from "./queue-config.mjs";

const accountId = "a".repeat(32);

async function fixture(work, crons = [...FRAMEWORK_CRONS]) {
  const dir = await mkdtemp(join(tmpdir(), "trestle-cron-"));
  const configPath = join(dir, "wrangler.jsonc");
  await writeFile(configPath, JSON.stringify({ env: { staging: { name: "new-worker", triggers: { crons } } } }));
  try { return await work(configPath); } finally { await rm(dir, { recursive: true, force: true }); }
}

function api(scheduleCounts, seen) {
  return async (url, options) => {
    seen.push({ path: new URL(url).pathname, authorization: options.headers.authorization });
    const path = new URL(url).pathname;
    const result = path.endsWith("/workers/scripts") ? Object.keys(scheduleCounts).map((id) => ({ id })) :
      { schedules: Array.from({ length: scheduleCounts[decodeURIComponent(path.split("/").at(-2))] ?? 0 }, () => ({ cron: "* * * * *" })) };
    return { ok: true, status: 200, json: async () => ({ success: true, result, result_info: { total_pages: 1 } }) };
  };
}

test("cron preflight blocks a full Free account without mutating it or leaking credentials", async () => {
  await fixture(async (configPath) => {
    const seen = [];
    await assert.rejects(verifyCronCapacity({ token: "secret-token", accountId, configPath, environment: "staging", request: api({ tidal: 5 }, seen) }), /5\/5 triggers used.*stopped before remote changes/u);
    assert.ok(seen.every(({ authorization }) => authorization === "Bearer secret-token"));
    assert.ok(seen.every(({ path }) => path.includes("/workers/scripts")));
  });
});

test("cron preflight credits existing target schedules when redeploying", async () => {
  await fixture(async (configPath) => {
    const result = await verifyCronCapacity({ token: "secret-token", accountId, configPath, environment: "staging", request: api({ tidal: 3, "new-worker": 2 }, []) });
    assert.deepEqual({ used: result.used, projected: result.projected, limit: result.limit }, { used: 5, projected: 5, limit: 5 });
  });
});

test("paid cron capacity requires an explicit plan declaration", async () => {
  await fixture(async (configPath) => {
    const options = { token: "secret-token", accountId, configPath, environment: "staging", request: api({ tidal: 5 }, []) };
    await assert.rejects(verifyCronCapacity(options), /capacity insufficient/u);
    const result = await verifyCronCapacity({ ...options, plan: "paid" });
    assert.equal(result.limit, 250);
    assert.equal(result.projected, 5 + FRAMEWORK_CRONS.length);
    await assert.rejects(verifyCronCapacity({ ...options, plan: "unknown" }), /must be free or paid/u);
  });
});

test("no requested cron skips account-wide schedule inspection", async () => {
  await fixture(async (configPath) => {
    const result = await verifyCronCapacity({ token: "secret-token", accountId, configPath, environment: "staging", request: () => { throw new Error("unexpected request"); } });
    assert.equal(result.skipped, true);
  }, []);
});

test("cron preflight fails closed on schedule API errors", async () => {
  await fixture(async (configPath) => {
    const seen = [];
    const request = async (url, options) => {
      const response = await api({ tidal: 1 }, seen)(url, options);
      return new URL(url).pathname.endsWith("/schedules") ? { ok: false, status: 403 } : response;
    };
    await assert.rejects(verifyCronCapacity({ token: "secret-token", accountId, configPath, environment: "staging", request }), /schedules failed with HTTP 403/u);
  });
});

test("cron preflight includes every page of Workers in the account total", async () => {
  await fixture(async (configPath) => {
    const pages = [];
    const request = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/workers/scripts")) {
        const page = Number(parsed.searchParams.get("page"));
        pages.push(page);
        return { ok: true, json: async () => ({ success: true, result: [{ id: `worker-${page}` }], result_info: { total_pages: 2 } }) };
      }
      return { ok: true, json: async () => ({ success: true, result: { schedules: [{ cron: "* * * * *" }] } }) };
    };
    const result = await verifyCronCapacity({ token: "secret-token", accountId, configPath, environment: "staging", request });
    assert.deepEqual(pages, [1, 2]);
    assert.equal(result.used, 2);
    assert.equal(result.projected, 2 + FRAMEWORK_CRONS.length);
  });
});

test("the framework's two crons fit staging and production on a Free account, with one trigger to spare", async () => {
  assert.equal(FRAMEWORK_CRONS.length, 2);
  await fixture(async (configPath) => {
    // Production already holds its two framework crons; staging adds two more.
    const result = await verifyCronCapacity({ token: "secret-token", accountId, configPath, environment: "staging", request: api({ "example-worker": 2 }, []) });
    assert.deepEqual({ desired: result.desired, projected: result.projected, limit: result.limit }, { desired: 2, projected: 4, limit: 5 });
    // Two application crons on top no longer fit.
    await assert.rejects(verifyCronCapacity({ token: "secret-token", accountId, configPath, environment: "staging", request: api({ "example-worker": 4 }, []) }), /capacity insufficient/u);
  });
});
