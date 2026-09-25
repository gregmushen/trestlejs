// Keyboard integration matrix (docs/ADMIN_KUMO_SPEC.md §15.3), run against a
// running `trestle dev`: `pnpm --filter ./apps/admin test:keyboard`.
//
// For every registered view it proves that the g-sequence navigates, `f`
// focuses the filter, typing never fires shortcuts, j/k move the active row,
// Enter selects into the URL, every destructive shortcut only opens a
// confirmation that cannot be submitted without a reason, Escape closes it,
// and the previous view's commands no longer fire after navigating away.
//
// Environment: ADMIN_URL (default http://localhost:42070), ADMIN_USER and
// ADMIN_PASSWORD (default the local admin/admin operator), CHROME_PATH.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const admin = process.env.ADMIN_URL ?? "http://localhost:42070";
const chromePath = process.env.CHROME_PATH ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const overlay = '[role="dialog"]:not([aria-modal="false"])';

const described = spawnSync("pnpm", ["exec", "tsx", path.join(here, "check-admin-views.ts"), "--json"], { cwd: path.join(here, ".."), encoding: "utf8" });
if (described.status !== 0) { console.error(described.stderr || described.stdout); process.exit(1); }
const registry = JSON.parse(described.stdout);

const profile = mkdtempSync(path.join(tmpdir(), "trestle-keyboard-"));
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
let targets;
for (let attempt = 0; attempt < 80 && !targets; attempt += 1) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await wait(250); } }
if (!targets) { console.error(`Could not start Chrome at ${chromePath}; set CHROME_PATH.`); process.exit(1); }
const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve));
let sequence = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message.result ?? message); pending.delete(message.id); }
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description?.split("\n")[0] ?? "exception");
});
const send = (method, params = {}) => new Promise((resolve) => { const id = ++sequence; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
await send("Runtime.enable"); await send("Page.enable");
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
const goto = async (url) => { await send("Page.navigate", { url }); await wait(2500); };
const key = async (value, modifiers = 0, keyCode) => {
  const text = value.length === 1 && !(modifiers & 6) ? value : undefined;
  const base = { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, modifiers, windowsVirtualKeyCode: keyCode ?? (value.length === 1 ? value.toUpperCase().charCodeAt(0) : 0) };
  await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await wait(150);
};
const press = async (hotkey) => { for (const step of hotkey.split(" ")) step.startsWith("Shift+") ? await key(step.slice(6).toUpperCase(), 8) : await key(step); await wait(700); };
const fill = (label, value) => evaluate(`(() => { const field = [...document.querySelectorAll("input")].find((input) => input.closest("label")?.innerText.startsWith(${JSON.stringify(label)}) || input.labels?.[0]?.innerText.startsWith(${JSON.stringify(label)})); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event("input", { bubbles: true })); })()`);
const url = () => evaluate("location.pathname + location.search");
const dialog = () => evaluate(`document.querySelector('${overlay}')?.innerText ?? ""`);
const blur = () => evaluate("document.activeElement?.blur?.()");

await goto(admin);
await fill("Email or username", process.env.ADMIN_USER ?? "admin");
await fill("Password", process.env.ADMIN_PASSWORD ?? "admin");
await evaluate(`document.querySelector("button[type=submit]").click()`); await wait(3000);

let failures = 0;
let previous = [];
for (const view of registry.views) {
  const commands = registry.commands.filter((command) => command.view === view.id);
  const checks = [];
  const check = (name, ok, detail = "") => { if (!ok) failures += 1; checks.push(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`); };
  const navigation = commands.find((command) => command.kind === "navigate");
  await blur();
  if (navigation?.hotkey) { await press(navigation.hotkey); await wait(1000); check(`${navigation.hotkey} navigates`, (await url()).split("?")[0] === view.path, await url()); }
  else { await goto(`${admin}${view.path}`); check("reachable (palette only)", (await url()).split("?")[0] === view.path); }
  await wait(1000);
  for (const command of previous.filter((candidate) => candidate.kind !== "navigate" && candidate.hotkey && !commands.some((mine) => mine.hotkey === candidate.hotkey)).slice(0, 2)) {
    await blur(); await press(command.hotkey);
    const opened = Boolean(await dialog()); check(`stale ${command.hotkey} from ${command.view} does nothing`, !opened);
    if (opened) await key("Escape", 0, 27);
  }
  if (await evaluate(`Boolean(document.querySelector("[data-admin-filter]"))`)) {
    await blur(); await key("f");
    check("f focuses the filter", await evaluate(`document.activeElement?.hasAttribute("data-admin-filter")`));
    const before = (await url()).split("?")[0];
    for (const letter of ["r", "s", "j", "e"]) await key(letter);
    await wait(700);
    check("typing does not fire shortcuts", !(await dialog()) && (await url()).split("?")[0] === before);
    await evaluate(`(() => { const input = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ""); input.dispatchEvent(new Event("input", { bubbles: true })); input.blur(); })()`);
    await wait(900);
  }
  if (await evaluate(`document.querySelectorAll("main table tbody tr").length`) > 0) {
    await blur(); await key("j");
    check("j moves the active row", await evaluate(`Boolean(document.querySelector("tr[data-active]")) && document.activeElement?.tagName === "TR"`));
    if (await evaluate(`document.querySelector("tr[data-active]")?.hasAttribute("aria-selected") ?? false`)) { await key("Enter", 0, 13); await wait(1000); check("Enter selects into the URL", (await url()).includes("selected=")); }
  }
  for (const command of commands.filter((candidate) => candidate.destructive && candidate.hotkey)) {
    await blur(); await press(command.hotkey);
    if (!(await dialog())) { checks.push(`- ${command.hotkey} ${command.id}: no eligible target selected`); continue; }
    const guarded = await evaluate(`Boolean(document.querySelector('${overlay} textarea')) && [...document.querySelectorAll('${overlay} button[type=submit]')].every((button) => button.disabled)`);
    await key("Enter", 12, 13); await wait(700);
    const stillOpen = Boolean(await dialog());
    await key("Escape", 0, 27); await wait(500);
    check(`${command.hotkey} ${command.id} opens a confirmation that needs a reason`, guarded && stillOpen && !(await dialog()));
  }
  if (errors.length) { failures += 1; checks.push(`✗ exceptions: ${[...new Set(errors.splice(0))].join(" | ")}`); }
  previous = commands;
  console.log(`${view.id}\n${checks.map((line) => `  ${line}`).join("\n")}`);
}
const exited = new Promise((resolve) => chrome.once("exit", resolve));
chrome.kill();
await exited;
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log(failures ? `${failures} keyboard checks failed` : "Keyboard matrix passed");
process.exit(failures ? 1 : 0);
