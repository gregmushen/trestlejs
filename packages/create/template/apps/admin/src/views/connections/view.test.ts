import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConnectionBackendJson } from "../../api";
import { ConnectionBackendSummary, QuarantinedCallbacks, quarantineExplanation } from "./view";

const counts = { connected: 3, reauthorization_required: 1, degraded: 0, authorizing: 0, disconnected: 0, revoked: 2 };
const render = (backend: ConnectionBackendJson | null) => renderToStaticMarkup(createElement(ConnectionBackendSummary, { backend, counts }));

describe("platform Connections view", () => {
  it("shows the selected backend, its safe detail, callback verification, and counts by state", () => {
    const html = render({ name: "nango", configured: true, detail: "Nango Cloud", webhookForwarding: "available", inboundVerification: true });
    expect(html).toContain("nango");
    expect(html).toContain("Nango Cloud");
    expect(html).toContain("signed callbacks verified");
    expect(html).toContain("reauthorization required: 1");
    expect(html).toContain("connected: 3");
    expect(html).not.toContain("not configured");
    expect(html).toContain("Experimental");
  });

  it("explains a disabled, unconfigured, or unreported backend", () => {
    expect(render({ name: "none", configured: false, detail: "tenant Connections are disabled", webhookForwarding: "unavailable", inboundVerification: false })).toContain("trestle integrations use nango --experimental");
    const unconfigured = render({ name: "nango", configured: false, detail: "NANGO_SECRET_KEY is not set; tenant Connections are unavailable", webhookForwarding: "unknown", inboundVerification: false });
    expect(unconfigured).toContain("nango is not configured");
    expect(unconfigured).toContain("depends on the Nango plan");
    expect(unconfigured).toContain("callbacks refused");
    expect(render(null)).toContain("Backend status unavailable");
  });

  // The table itself needs the router; its rows use these explanations.
  it("explains each quarantine reason and shows an empty state", () => {
    expect(quarantineExplanation("unknown_attempt")).toBe("The attempt does not exist in this environment");
    expect(quarantineExplanation("unbound")).toContain("not started from this application");
    expect(quarantineExplanation(null)).toBe("unknown reason");
    expect(renderToStaticMarkup(createElement(QuarantinedCallbacks, { rows: [] }))).toContain("No quarantined callbacks");
    expect(quarantineExplanation("something_new")).toBe("something_new");
  });
});
