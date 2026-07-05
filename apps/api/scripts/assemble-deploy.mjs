// Assemble a self-contained Azure Functions deploy folder at apps/api/deploy:
//   dist/ (bundled API) + www/ (built React) + host.json + minimal package.json
// then install only the runtime deps so the folder can be deployed as-is.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
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

// Build stamp beside the bundle — /api/system reports it, so the deployed
// API identifies exactly which commit it's running.
const gitSha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
})();
writeFileSync(resolve(deploy, 'dist', 'build.json'), JSON.stringify({ sha: gitSha, builtAt: new Date().toISOString() }));

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

// Prune runtime-useless files from node_modules. Beyond saving space, this keeps
// the deploy zip UNDER 65,535 entries — past that the zipper switches to ZIP64,
// whose end-of-central-directory record Kudu rejects with
// "Offset to Central Directory cannot be held in an Int64" (deploy fails). The
// biggest offender is bundled type declarations (e.g. hono ships hundreds).
const PRUNE_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'doc', 'example', 'examples', '.github', '.bin']);
const PRUNE_FILE = /(\.d\.(?:ts|cts|mts)|\.d\.ts\.map|\.js\.map|\.cjs\.map|\.mjs\.map|\.ts\.map|\.markdown|\.md)$/i;
const PRUNE_NAME = /^(license|licence|readme|changelog|authors|contributing|\.npmignore|\.editorconfig|\.eslintrc.*|tsconfig.*|\.travis\.yml)$/i;
let pruned = 0;
let kept = 0;
function pruneTree(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (PRUNE_DIRS.has(e.name.toLowerCase())) {
        try {
          rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          pruned++;
        } catch {
          /* leave it — pruning is best-effort */
        }
      } else {
        pruneTree(p);
      }
    } else if (PRUNE_FILE.test(e.name) || PRUNE_NAME.test(e.name)) {
      try {
        rmSync(p, { force: true });
        pruned++;
      } catch {
        /* ignore */
      }
    } else {
      kept++;
    }
  }
}
const nodeModules = resolve(deploy, 'node_modules');
if (existsSync(nodeModules)) {
  pruneTree(nodeModules);
  console.log(`Pruned ${pruned} type/doc/map file(s); ~${kept} runtime file(s) remain.`);
  if (kept > 60000) {
    console.warn(
      `\nWarning: ${kept} files still in node_modules — close to the 65,535 ZIP64 threshold that breaks VS Code zip deploy. ` +
        'If deploy fails with "Offset to Central Directory", deploy via CLI zip instead (see README).',
    );
  }
}
void statSync; // (kept available for future size reporting)

console.log('\nDeploy package ready:', deploy);
console.log('In VS Code: Open Folder -> apps/api/deploy, then Azure -> Deploy to Function App.');
