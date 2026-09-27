import { cloudflareHarness } from "./job-conformance-cloudflare.js";
import { runtimeConformanceSuite } from "./job-conformance-suite.js";

runtimeConformanceSuite({ runtime: "cloudflare", connectionString: process.env.TRESTLE_RLS_TEST_DATABASE_URL, harness: async (connectionString) => cloudflareHarness(connectionString) });
