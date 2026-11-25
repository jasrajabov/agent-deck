#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(root, "node_modules", ".bin", "tsx");
const { status } = spawnSync(tsx, [join(root, "src", "cli.tsx"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(status ?? 0);
