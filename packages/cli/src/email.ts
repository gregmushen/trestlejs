import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliFailure, type CliRuntime } from "./runtime.js";
import { runCommand } from "./processes.js";

type CapturedEmail = { id: string; to: string[]; subject: string; template: string; text: string; html: string; status: string; createdAt: string; scheduledAt?: string };

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new CliFailure(response.status === 404 ? "local email capture is unavailable or the message does not exist" : `local email capture returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function listLocalEmail(apiUrl: string): Promise<CapturedEmail[]> {
  const response = await fetch(`${apiUrl.replace(/\/$/u, "")}/api/dev/emails`);
  return (await responseJson<{ emails: CapturedEmail[] }>(response)).emails;
}

export async function getLocalEmail(apiUrl: string, id: string): Promise<CapturedEmail> {
  const response = await fetch(`${apiUrl.replace(/\/$/u, "")}/api/dev/emails/${encodeURIComponent(id)}`);
  return (await responseJson<{ email: CapturedEmail }>(response)).email;
}

export async function clearLocalEmail(apiUrl: string): Promise<void> {
  const response = await fetch(`${apiUrl.replace(/\/$/u, "")}/api/dev/emails`, { method: "DELETE" });
  if (!response.ok) throw new CliFailure(`local email capture returned HTTP ${response.status}`);
}

export function formatEmailList(emails: CapturedEmail[]): string {
  if (emails.length === 0) return "No captured email.\n";
  return `${["STATUS\tTO\tSUBJECT\tID", ...emails.map((email) => `${email.status}\t${email.to.join(",")}\t${email.subject}\t${email.id}`)].join("\n")}\n`;
}

export function formatEmail(email: CapturedEmail): string {
  return [`ID: ${email.id}`, `Status: ${email.status}`, `To: ${email.to.join(", ")}`, `Subject: ${email.subject}`, `Template: ${email.template}`, `Created: ${email.createdAt}`, ...(email.scheduledAt ? [`Scheduled: ${email.scheduledAt}`] : []), "", email.text, ""].join("\n");
}

export async function openLocalEmail(apiUrl: string, id: string, root: string, runtime: CliRuntime): Promise<void> {
  const email = await getLocalEmail(apiUrl, id);
  const directory = await mkdtemp(path.join(os.tmpdir(), "trestle-email-"));
  const output = path.join(directory, `${id}.html`);
  await writeFile(output, email.html, { mode: 0o600 });
  await chmod(output, 0o600);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const arguments_ = process.platform === "win32" ? ["/c", "start", "", output] : [output];
  await runCommand(command, arguments_, { cwd: root, env: process.env });
  runtime.stdout(`Opened ${email.subject}\n`);
}
