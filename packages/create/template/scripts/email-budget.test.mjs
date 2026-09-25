import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const scripts = JSON.parse(read("../package.json")).scripts;

test("automatic deployed browser gates cannot enable the live-email suites", () => {
  for (const [environment, workflow, productSpec] of [
    ["preview", "../.github/workflows/preview.yml", "preview-product.spec.ts"],
    ["staging", "../.github/workflows/deploy.yml", "deployed-product.spec.ts"],
  ]) {
    const command = scripts[`test:${environment}`];
    assert.match(command, /site-handoff\.spec\.ts/u);
    assert.ok(command.includes(productSpec));
    assert.match(command, /TRESTLE_ALLOW_LIVE_EMAIL_TESTS=0/u);
    const source = read(workflow);
    assert.match(source, new RegExp(`pnpm test:${environment}(?!:live-email)`, "u"));
    assert.doesNotMatch(source, new RegExp(`pnpm test:${environment}:live-email`, "u"));
    assert.doesNotMatch(source, /TRESTLE_ALLOW_LIVE_EMAIL_TESTS=1/u);
  }
});

test("direct execution of a live-email suite also requires explicit opt-in", () => {
  for (const [environment, spec] of [
    ["preview", "../tests/browser/preview-email.spec.ts"],
    ["staging", "../tests/browser/deployed-product.spec.ts"],
  ]) {
    assert.match(scripts[`test:${environment}:live-email`], /TRESTLE_ALLOW_LIVE_EMAIL_TESTS=1/u);
    assert.match(read(spec), /process\.env\.TRESTLE_ALLOW_LIVE_EMAIL_TESTS !== "1"/u);
  }
});

test("automatic preview product verification has a non-sending fixture and cannot silently skip it", () => {
  const workflow = read("../.github/workflows/preview.yml");
  const product = read("../tests/browser/preview-product.spec.ts");
  const fixture = read("../packages/auth/src/preview-fixture.ts");
  assert.match(workflow, /Create verified test account in the isolated preview database without sending email/u);
  assert.match(workflow, /steps\.runtime-role\.outputs\.runtime_url/u);
  assert.ok(workflow.indexOf("Create verified test account") < workflow.indexOf("run: pnpm test:preview"));
  assert.match(product, /TRESTLE_PREVIEW_FIXTURE_EMAIL/u);
  assert.match(product, /throw new Error\("Preview product verification requires a verified preview fixture/u);
  assert.doesNotMatch(product, /RESEND_API_KEY|waitForStagingVerificationLink|\.skip\([^)]*TRESTLE_ALLOW_LIVE_EMAIL_TESTS/u);
  assert.match(fixture, /input\.environment !== "preview"/u);
  assert.match(fixture, /emailVerified: true/u);
  assert.doesNotMatch(fixture, /createEmailService|RESEND_API_KEY/u);
});
