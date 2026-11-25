import { spawnSync } from "node:child_process";
import { render } from "ink";
import React from "react";
import { App, type Exit } from "./App.js";

const enterAlt = () => process.stdout.write("\x1b[?1049h\x1b[H");
const leaveAlt = () => process.stdout.write("\x1b[?1049l");

// Attaching hands the terminal to `claude attach`; when you detach, the deck comes back.
while (true) {
  let result = { type: "quit" } as Exit;
  enterAlt();
  const app = render(<App onExit={(e) => (result = e)} />, { exitOnCtrlC: false });
  await app.waitUntilExit();
  app.cleanup();
  leaveAlt();
  if (result.type === "quit") break;
  console.log(`\nAttaching to ${result.name}. Detach to come back to the deck.\n`);
  spawnSync("claude", ["attach", result.id], { stdio: "inherit" });
}
