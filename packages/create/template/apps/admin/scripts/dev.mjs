// Runs the admin SPA and the separately deployed admin Worker together for `trestle dev`.
import { spawn } from "node:child_process";

const children = [
  spawn("vite", ["--port", "42070", "--strictPort"], { stdio: "inherit", shell: process.platform === "win32" }),
  spawn("wrangler", ["dev", "--port", "8788", "--inspector-port", "9230"], { stdio: "inherit", shell: process.platform === "win32" }),
];
const stop = (signal) => { for (const child of children) child.kill(signal); };
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
for (const child of children) child.once("exit", (code) => { stop("SIGTERM"); process.exitCode = code ?? 1; });
