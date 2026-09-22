const apiKey = process.env.NEON_API_KEY ?? "";
const projectId = process.env.NEON_PROJECT_ID ?? "";
const apiBase = (process.env.NEON_API_BASE ?? "https://console.neon.tech/api/v2").replace(/\/$/u, "");

if (!apiKey) throw new Error("NEON_API_KEY is required");
if (!/^[a-z0-9-]{1,60}$/u.test(projectId)) throw new Error("NEON_PROJECT_ID is required");

const response = await fetch(`${apiBase}/projects/${encodeURIComponent(projectId)}`, {
  headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
});
if (response.status === 401 || response.status === 403) {
  throw new Error(`Neon project access rejected the configured key (HTTP ${response.status}); replace the preview NEON_API_KEY credential`);
}
if (!response.ok) throw new Error(`Neon project access failed with HTTP ${response.status}`);
const body = await response.json();
if (body.project?.id !== projectId) throw new Error("Neon project access did not return the configured project");
process.stdout.write("Neon project access verified; credential values were not printed.\n");
