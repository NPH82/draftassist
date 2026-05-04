import { execSync } from 'node:child_process';

function run(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function resolveBaseRef() {
  const explicit = process.env.DOCS_CHECK_BASE_REF || process.env.GITHUB_BASE_REF;
  if (explicit) return `origin/${explicit}`;
  return 'HEAD~1';
}

const baseRef = resolveBaseRef();
let changed = [];
try {
  changed = run(`git diff --name-only ${baseRef}...HEAD`)
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
} catch {
  // If diff base is unavailable locally, do not hard-fail local runs.
  process.exit(0);
}

if (changed.length === 0) process.exit(0);

const docFiles = new Set(['spec.md', 'SETUP.md']);
const docsChanged = changed.some((f) => docFiles.has(f));

const codeChanged = changed.some((f) =>
  f.startsWith('backend/src/')
  || f.startsWith('frontend/src/')
  || f === 'backend/package.json'
  || f === 'frontend/package.json'
  || f.startsWith('backend/src/models/')
  || f.startsWith('frontend/src/components/')
);

if (codeChanged && !docsChanged) {
  console.error('[docs-check] Source code changed but docs were not updated.');
  console.error('[docs-check] Please update spec.md and/or SETUP.md in the same PR.');
  process.exit(1);
}

process.exit(0);
