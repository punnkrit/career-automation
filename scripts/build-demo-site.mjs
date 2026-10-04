import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Invoke Vite through Node so Windows does not need a shell or npm.cmd.
const build = spawnSync(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.demo.config.ts"], { cwd: root, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);
const output = resolve(root, "dist");
if (!existsSync(resolve(root, "dist-demo/index.html"))) throw new Error("Demo build is missing index.html");
rmSync(output, { recursive: true, force: true });
cpSync(resolve(root, "dist-demo"), output, { recursive: true });
