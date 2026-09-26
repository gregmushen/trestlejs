import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReplayCell, replayUnavailableExplanation } from "./replay";

const render = (row: { id: string; replayable?: boolean; replayUnavailableReason?: string | null }, canManage = true) =>
  renderToStaticMarkup(createElement(ReplayCell, { row, canManage, onReplay: () => undefined }));

describe("platform webhook delivery replay action", () => {
  it("disables replay with an explanation once the source event is past the replay window", () => {
    const html = render({ id: "whd_1", replayable: false, replayUnavailableReason: "provenance_expired" });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*Replay[\s\S]*<\/button>/u);
    expect(html).toMatch(/aria-describedby="replay-reason-whd_1"/u);
    expect(html).toContain('id="replay-reason-whd_1"');
    expect(html).toContain(replayUnavailableExplanation("provenance_expired"));
    expect(replayUnavailableExplanation("provenance_expired")).toBe("Source event is outside the 14-day replay window or no longer retained");
  });

  it("enables replay for an eligible delivery and shows only the reason to an operator who cannot manage webhooks", () => {
    const html = render({ id: "whd_2", replayable: true, replayUnavailableReason: null });
    expect(html).toMatch(/<button(?![^>]*disabled="")[^>]*>[\s\S]*Replay[\s\S]*<\/button>/u);
    const readOnly = render({ id: "whd_3", replayable: false, replayUnavailableReason: "provenance_expired" }, false);
    expect(readOnly).not.toContain("<button");
    expect(readOnly).toContain(replayUnavailableExplanation("provenance_expired"));
    expect(replayUnavailableExplanation("payload_expired")).toBe("Payload no longer retained");
    expect(replayUnavailableExplanation("unknown_reason")).toBe("unknown reason");
  });
});
