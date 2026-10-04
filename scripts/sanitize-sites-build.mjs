import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = process.cwd();
const generatedSecrets = resolve(projectRoot, "dist", "server", ".dev.vars");
const expectedPrefix = `${resolve(projectRoot, "dist", "server")}/`;

if (!generatedSecrets.startsWith(expectedPrefix)) {
  throw new Error("Refusing to sanitize a path outside the generated Sites server output.");
}

await rm(generatedSecrets, { force: true });

// Keep the public archive root in sync with Vite's current client build.
await rm(resolve(projectRoot, "dist", "assets"), { recursive: true, force: true });
await cp(resolve(projectRoot, "dist", "client", "assets"), resolve(projectRoot, "dist", "assets"), { recursive: true });
await cp(resolve(projectRoot, "dist", "client", "index.html"), resolve(projectRoot, "dist", "index.html"));
