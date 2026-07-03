// Assemble a self-contained Azure Functions deploy folder at apps/api/deploy:
//   dist/ (bundled API) + www/ (built React) + host.json + minimal package.json
// then install only the runtime deps so the folder can be deployed as-is.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // apps/api
const repoRoot = resolve(apiRoot, '..', '..');
const apiDist = resolve(apiRoot, 'dist');
const webDist = resolve(repoRoot, 'apps', 'web', 'dist');
const deploy = resolve(apiRoot, 'deploy');

if (!existsSync(resolve(apiDist, 'functions.js'))) {
  throw new Error('apps/api/dist/functions.js missing — run `npm run build -w @mashit/api` first.');
}
if (!existsSync(resolve(webDist, 'index.html'))) {
  throw new Error('apps/web/dist/index.html missing — run `npm run build -w @mashit/web` first.');
}

try {
  // maxRetries/retryDelay: Windows holds EBUSY/EPERM locks briefly (VS Code,
  // AV scanners, a shell cd'd into the folder) — retry before giving up.
  rmSync(deploy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (err) {
  if (err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'ENOTEMPTY') {
    console.error(
      `\nCould not clear ${deploy} — something is holding it open.\n` +
        'Close any terminal or VS Code window sitting in apps/api/deploy (and any running func host), then re-run npm run deploy:build.\n',
    );
  }
  throw err;
}
mkdirSync(deploy, { recursive: true });
cpSync(apiDist, resolve(deploy, 'dist'), { recursive: true });
cpSync(webDist, resolve(deploy, 'www'), { recursive: true });
cpSync(resolve(apiRoot, 'host.json'), resolve(deploy, 'host.json'));

const apiPkg = JSON.parse(readFileSync(resolve(apiRoot, 'package.json'), 'utf8'));
const deployPkg = {
  name: 'mashit-qbr-func',
  version: apiPkg.version ?? '0.1.0',
  private: true,
  type: 'module',
  main: 'dist/functions.js',
  dependencies: {
    '@azure/functions': apiPkg.dependencies['@azure/functions'],
    '@azure/data-tables': apiPkg.dependencies['@azure/data-tables'],
    '@azure/identity': apiPkg.dependencies['@azure/identity'],
    '@azure/keyvault-secrets': apiPkg.dependencies['@azure/keyvault-secrets'],
    '@azure/storage-blob': apiPkg.dependencies['@azure/storage-blob'],
    '@modelcontextprotocol/sdk': apiPkg.dependencies['@modelcontextprotocol/sdk'],
    pdfmake: apiPkg.dependencies.pdfmake,
    pptxgenjs: apiPkg.dependencies.pptxgenjs,
  },
};
writeFileSync(resolve(deploy, 'package.json'), JSON.stringify(deployPkg, null, 2));
// Keep the whole payload; nothing to ignore beyond stray bin links.
writeFileSync(resolve(deploy, '.funcignore'), 'node_modules/.bin\n');

console.log('Installing runtime dependencies in deploy/ …');
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: deploy, stdio: 'inherit' });

console.log('\nDeploy package ready:', deploy);
console.log('In VS Code: Open Folder -> apps/api/deploy, then Azure -> Deploy to Function App.');
