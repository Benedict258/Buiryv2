// Part of the Oracle templates (docs/DEPLOY_ORACLE.md 10.5; DESIGNED ONLY for the VM). Runs on the build machine from
// infra/oracle/build-artifact.sh: node check-artifact-deps.cjs <app dir>
//
// Refuses (exit 4) when a workspace dev tool (typescript, tsx, vitest) is in the artefact's node_modules but no
// production package there lists it as a dependency or a peer. A tool required by a production package is allowed:
// `typescript`, for example, is a peer of production packages and pnpm installs it with them. A dev tool requiring
// another dev tool does not count. Prints package names only.
/* global require, process, console */
/* eslint-disable @typescript-eslint/no-require-imports -- a plain CommonJS script run with node on the build machine */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const DEV_TOOLS = ['typescript', 'tsx', 'vitest'];
const app = process.argv[2];
if (!app) {
  console.error('[artifact] usage: check-artifact-deps.cjs <app dir>');
  process.exit(2);
}
const nm = path.join(app, 'node_modules');

/** Every package.json directly under node_modules, scoped ones included. */
function packages() {
  if (!fs.existsSync(nm)) return [];
  const out = [];
  for (const e of fs.readdirSync(nm)) {
    const dirs = e.startsWith('@') ? fs.readdirSync(path.join(nm, e)).map((s) => path.join(e, s)) : [e];
    for (const d of dirs) {
      const f = path.join(nm, d, 'package.json');
      if (fs.existsSync(f)) {
        try {
          out.push(JSON.parse(fs.readFileSync(f, 'utf8')));
        } catch {
          // an unreadable manifest is not a dependent
        }
      }
    }
  }
  return out;
}

const all = packages();
const present = new Set(all.map((p) => p.name));
const failures = [];
for (const tool of DEV_TOOLS) {
  if (!present.has(tool)) continue;
  const requiredBy = all.filter(
    (p) =>
      !DEV_TOOLS.includes(p.name) &&
      ((p.dependencies && tool in p.dependencies) || (p.peerDependencies && tool in p.peerDependencies)),
  );
  if (requiredBy.length === 0) failures.push(tool);
  else console.log(`[artifact] ${tool} kept: required by ${requiredBy.map((p) => p.name).join(', ')}`);
}
for (const tool of failures)
  console.error(`[artifact] ${tool} is in the artefact but no production package requires it; refusing`);
process.exit(failures.length ? 4 : 0);
