import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "create", "template");
const destination = path.join(root, "packages", "cli", "dist", "template");

// Only this generated build output is replaced. Application source and the
// checked-in template are never modified by a CLI build.
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true, force: true });
