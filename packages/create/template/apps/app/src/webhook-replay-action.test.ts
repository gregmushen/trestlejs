import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeliveryReplayAction, type ReplayEligibility } from "./webhook-replay-action.js";

const render = (delivery: ReplayEligibility, pending = false) =>
  renderToStaticMarkup(createElement(DeliveryReplayAction, { delivery, pending, onReplay: () => undefined }));

describe("customer webhook delivery replay action", () => {
  it("disables replay with an explanation once the source event is past the replay window", () => {
    const html = render({ id: "whd_1", replayable: false, replayUnavailableReason: "provenance_expired" });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Replay failed delivery<\/button>/u);
    expect(html).toMatch(/aria-describedby="replay-reason-whd_1"/u);
    expect(html).toContain('id="replay-reason-whd_1"');
    expect(html).toContain("The source event is older than the 14-day replay window or is no longer retained, so this delivery cannot be replayed.");
  });

  it("disables replay with the matching explanation for every other refusal", () => {
    for (const [reason, text] of [
      ["payload_expired", "The payload is no longer retained"],
      ["endpoint_inactive", "Activate this endpoint before replaying."],
      ["provider_unavailable", "Webhook delivery is unavailable in this environment."],
      ["replay_pending", "A replay is already queued."],
      ["resolved", "A replay of this message has succeeded."],
    ] as const) {
      const html = render({ id: "whd_2", replayable: false, replayUnavailableReason: reason });
      expect(html, reason).toMatch(/<button[^>]*disabled=""/u);
      expect(html, reason).toContain(text);
    }
  });

  it("enables replay for an eligible failed delivery and offers nothing for one that has not failed", () => {
    const html = render({ id: "whd_3", replayable: true, replayUnavailableReason: null });
    expect(html).toContain(">Replay failed delivery</button>");
    expect(html).not.toContain('disabled=""');
    expect(render({ id: "whd_3", replayable: true, replayUnavailableReason: null }, true)).toMatch(/<button[^>]*disabled=""[^>]*>Queuing replay…<\/button>/u);
    expect(render({ id: "whd_4", replayable: false, replayUnavailableReason: "not_failed" })).toBe("");
  });
});
