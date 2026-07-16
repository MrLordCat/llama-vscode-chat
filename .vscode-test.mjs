import { defineConfig } from '@vscode/test-cli';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  launchArgs: [
    `--user-data-dir=${path.resolve('.vscode-test', `user-data-${os.userInfo().username}-${Date.now()}`)}`
  ],
  mocha: {
    ui: 'tdd',
    timeout: 20000,
    color: true
  }
});
