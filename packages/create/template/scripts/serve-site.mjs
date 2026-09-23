import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/site/dist");
const mimeTypes = new Map([
  [".css", "text/css"], [".html", "text/html"], [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".js", "text/javascript"],
  [".json", "application/json"], [".png", "image/png"], [".svg", "image/svg+xml"],
  [".txt", "text/plain"], [".webp", "image/webp"], [".woff2", "font/woff2"],
  [".xml", "application/xml"],
]);

export function resolveSitePath(root, requestPath) {
  let pathname;
  try { pathname = decodeURIComponent(requestPath.split("?", 1)[0] ?? ""); }
  catch { return null; }
  if (!pathname.startsWith("/") || pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) return null;
  const target = path.resolve(root, `.${pathname}`);
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? null : target;
}

export function contentType(filePath) {
  return `${mimeTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream"}${[".css", ".html", ".js", ".json", ".svg", ".txt", ".xml"].includes(path.extname(filePath).toLowerCase()) ? "; charset=utf-8" : ""}`;
}

export function createSiteServer(root = siteRoot) {
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
    const target = resolveSitePath(root, request.url ?? "/");
    if (!target) { response.writeHead(400); response.end(); return; }
    let filePath = target;
    try {
      const details = await stat(target);
      if (details.isDirectory()) filePath = path.join(target, "index.html");
      const file = await stat(filePath);
      if (!file.isFile()) throw new Error("Not a file");
      response.writeHead(200, { "Content-Type": contentType(filePath), "Content-Length": file.size, "Cache-Control": "no-store" });
      if (request.method === "HEAD") { response.end(); return; }
      createReadStream(filePath).pipe(response);
    } catch { response.writeHead(404); response.end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 42068);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Site preview port is invalid");
  await stat(path.join(siteRoot, "index.html"));
  createSiteServer().listen(port, () => process.stdout.write(`Built site ready at http://localhost:${port}\n`));
}
