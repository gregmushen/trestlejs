// Runs the customer Worker for `trestle dev` and fires its cron trigger every few
// seconds, so outbox events reach webhooks and notifications without waiting a minute.
import { spawn } from "node:child_process";

const port = 8787;
const worker = spawn("wrangler", ["dev", "--port", String(port), "--test-scheduled"], { stdio: "inherit", shell: process.platform === "win32" });
const timer = setInterval(() => {
  fetch(`http://localhost:${port}/__scheduled?cron=*+*+*+*+*`).catch(() => undefined);
}, Number(process.env.TRESTLE_OUTBOX_INTERVAL_MS ?? 3000));
const stop = (signal) => { clearInterval(timer); worker.kill(signal); };
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
worker.once("exit", (code) => { clearInterval(timer); process.exitCode = code ?? 1; });
