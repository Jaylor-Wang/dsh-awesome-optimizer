import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the installed DSH dependency graph so Cordis service identities stay shared.
const root = fileURLToPath(new URL('../', import.meta.url));
const host = path.resolve(process.env.DSH_IMPLEMENTATION_ROOT ?? 'D:/nodejs/node_global/node_modules/@deepseek-ai/dsh');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const hostManifest = JSON.parse(fs.readFileSync(path.join(host, 'package.json'), 'utf8'));
assert.equal(hostManifest.name, '@deepseek-ai/dsh');

const packagesToLink = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tool-executor-native'
];

const created = [];
for (const name of packagesToLink) {
  const target = path.join(root, 'node_modules', name);
  if (fs.existsSync(target)) continue;
  const candidates = [
    path.join(host, 'node_modules', name),
    path.join(host, 'node_modules/@deepseek-ai/dsh-agent-loop/node_modules', name)
  ];
  const source = candidates.find(candidate => fs.existsSync(path.join(candidate, 'package.json')));
  assert.ok(source, `Could not locate ${name} in ${host}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  created.push(name);
}

const selfTarget = path.join(root, 'node_modules', manifest.name);
if (!fs.existsSync(selfTarget)) {
  fs.mkdirSync(path.dirname(selfTarget), { recursive: true });
  fs.symlinkSync(root, selfTarget, process.platform === 'win32' ? 'junction' : 'dir');
  created.push(manifest.name);
}

const require = createRequire(path.join(root, 'package.json'));
for (const name of packagesToLink) {
  require.resolve(name);
}

console.log(JSON.stringify({
  hostVersion: hostManifest.version,
  linked: created,
  totalPackages: packagesToLink.length,
  networkRequests: 0
}, null, 2));
