import { access } from "node:fs/promises";
import path from "node:path";

const manifestRelativePath = path.join(".trestle", "project.yaml");

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(startDirectory: string): Promise<string> {
  let current = path.resolve(startDirectory);
  while (true) {
    if (await exists(path.join(current, manifestRelativePath))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`No ${manifestRelativePath} found from ${path.resolve(startDirectory)}`);
    }
    current = parent;
  }
}
