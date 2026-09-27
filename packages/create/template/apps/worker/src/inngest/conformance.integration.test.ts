import { runtimeConformanceSuite } from "../job-conformance-suite.js";
import { inngestHarness } from "./conformance-harness.js";

/** The conformance suite against the real Inngest engine. Enable with TRESTLE_INNGEST_CONFORMANCE=1. */
runtimeConformanceSuite({
  runtime: "inngest",
  connectionString: process.env.TRESTLE_INNGEST_CONFORMANCE === "1" ? process.env.TRESTLE_RLS_TEST_DATABASE_URL : undefined,
  harness: inngestHarness,
  deploy: "new-code",
  timeoutMs: 300_000,
});
