import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { customerOpenApi } from "../apps/worker/src/openapi.js";

/**
 * Writes or checks the customer API document (`trestle api spec`).
 * TRESTLE_OPENAPI_OUT: the file to write or compare; TRESTLE_OPENAPI_CHECK=1 fails on drift.
 * TRESTLE_OPENAPI_EXPOSURE=published documents only public and machine routes.
 */
const result = customerOpenApi(process.env.TRESTLE_OPENAPI_EXPOSURE === "published" ? "production" : "local");
const text = `${JSON.stringify(result.document, null, 2)}\n`;
const out = process.env.TRESTLE_OPENAPI_OUT;
const report = { undocumented: result.undocumented, excluded: result.excluded, orphaned: result.orphaned };
if (result.orphaned.length) {
  process.stderr.write(`Operation contracts without a route policy:\n${result.orphaned.map((entry) => `  ${entry.method} ${entry.path}: ${entry.reason}`).join("\n")}\n`);
  process.exitCode = 1;
}
if (!out) {
  process.stdout.write(process.env.TRESTLE_OPENAPI_REPORT === "1" ? `${JSON.stringify(report, null, 2)}\n` : text);
} else if (process.env.TRESTLE_OPENAPI_CHECK === "1") {
  const current = await readFile(out, "utf8").catch(() => "");
  if (current !== text) {
    process.stderr.write(`${out} is out of date with the route contracts; run trestle api spec --out ${out}\n`);
    process.exitCode = 1;
  }
} else {
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, text, "utf8");
  process.stderr.write(`Wrote ${out}: ${Object.keys(result.document.paths as object).length} paths; ${result.undocumented.length} routes without schemas, ${result.excluded.length} excluded.\n`);
}
