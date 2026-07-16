// Allows the VS Code Electron binary to act as Node when a standalone Node.js
// installation is unavailable. Clearing the flag before loading the runner
// prevents child VS Code test instances from starting in Node mode.
delete process.env.ELECTRON_RUN_AS_NODE;
await import("../node_modules/@vscode/test-cli/out/bin.mjs");
