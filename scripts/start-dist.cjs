process.env.KHAANZ_LOAD_DIST = "1";
const { spawn } = require("child_process");

const child = spawn(require("electron"), ["."], {
  stdio: "inherit",
  env: process.env,
  windowsHide: false,
});

child.on("exit", (code) => process.exit(code ?? 0));
