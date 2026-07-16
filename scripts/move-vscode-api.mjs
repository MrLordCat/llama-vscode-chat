import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const downloadedPath = fileURLToPath(new URL("../vscode.d.ts", import.meta.url));
const targetPath = fileURLToPath(new URL("../src/vscode.d.ts", import.meta.url));

await fs.rm(targetPath, { force: true });
await fs.rename(downloadedPath, targetPath);
console.log(`Updated ${targetPath}`);
