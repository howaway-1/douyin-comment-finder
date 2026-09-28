'use strict';
const path = require('node:path');
const os = require('node:os');
function loadPlaywright() {
  const candidates = ['playwright'];
  if (process.env.DCF_PLAYWRIGHT_PATH) candidates.push(process.env.DCF_PLAYWRIGHT_PATH);
  candidates.push(path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright'));
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw new Error('缺少 Playwright。请在工具目录运行 npm install，然后重试。');
}
module.exports = {loadPlaywright};
