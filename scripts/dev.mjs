import { spawn } from "node:child_process";

function run(cmd, args, opts = {}) {
  const p = spawn(cmd, args, { stdio: "inherit", shell: true, ...opts });
  p.on("exit", (code) => process.exitCode = code ?? 0);
  return p;
}

const server = run("npm", ["run", "dev:server"]);
const ui = run("npm", ["run", "dev:ui"]);

function shutdown() {
  server.kill("SIGINT");
  ui.kill("SIGINT");
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
