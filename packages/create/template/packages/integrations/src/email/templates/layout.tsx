import React from "react";

export function EmailLayout({ preview, children }: { preview: string; children: React.ReactNode }) {
  return <html><head><title>{preview}</title></head><body style={{ fontFamily: "system-ui, sans-serif", color: "#172033", lineHeight: 1.5 }}><main style={{ maxWidth: 560, margin: "32px auto", padding: 24 }}><p style={{ display: "none", maxHeight: 0, overflow: "hidden" }}>{preview}</p>{children}<hr /><p style={{ color: "#667085", fontSize: 12 }}>Sent by __TRESTLE_PROJECT_NAME__.</p></main></body></html>;
}
