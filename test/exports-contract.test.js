import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function stripCommentsAndAugmentations(source) {
  let clean = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // Remove `declare module '...' { ... }` blocks so nested interfaces are ignored
  let idx;
  while ((idx = clean.search(/\bdeclare\s+module\s+['"][^'"]+['"]\s*\{/)) !== -1) {
    const braceStart = clean.indexOf('{', idx);
    let depth = 0;
    let end = braceStart;
    while (end < clean.length) {
      if (clean[end] === '{') depth++;
      else if (clean[end] === '}') {
        depth--;
        if (depth === 0) {
          end++;
          break;
        }
      }
      end++;
    }
    clean = clean.slice(0, idx) + clean.slice(end);
  }
  return clean;
}

function parseDtsValueExports(filePath) {
  const source = stripCommentsAndAugmentations(fs.readFileSync(filePath, 'utf8'));
  const names = new Set();

  if (/\bexport\s+default\b/.test(source)) {
    names.add('default');
  }

  for (const match of source.matchAll(/^\s*export\s+(?:declare\s+)?(?:const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }

  for (const match of source.matchAll(/^\s*export\s*\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/gm)) {
    for (const rawItem of match[1].split(',')) {
      const item = rawItem.trim();
      if (!item || /^type\s+/.test(item)) continue;
      const alias = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      names.add(alias ? alias[2] : item);
    }
  }

  return [...names].sort();
}

test('package.json subpath exports stay in exact parity with .d.ts value declarations', async () => {
  const checked = [];
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (typeof entry !== 'object' || !entry || !entry.default || !entry.types) continue;
    const jsPath = path.resolve(root, entry.default);
    const dtsPath = path.resolve(root, entry.types);
    assert.ok(fs.existsSync(jsPath), `Missing JS entrypoint for ${subpath}: ${entry.default}`);
    assert.ok(fs.existsSync(dtsPath), `Missing .d.ts entrypoint for ${subpath}: ${entry.types}`);

    const mod = await import(pathToFileURL(jsPath).href);
    const runtimeExports = Object.keys(mod).sort();
    const declaredExports = parseDtsValueExports(dtsPath);

    assert.deepEqual(
      declaredExports,
      runtimeExports,
      `Export parity mismatch on subpath "${subpath}" (${entry.types} vs ${entry.default})`
    );

    // Every plugin entrypoint must provide the standard Cordis plugin contract
    assert.equal(typeof mod.name, 'string', `${subpath} must export string name`);
    assert.ok(mod.Config, `${subpath} must export Config schema`);
    assert.equal(typeof mod.apply, 'function', `${subpath} must export apply()`);
    assert.equal(typeof mod.default?.apply, 'function', `${subpath} must export default plugin object`);
    checked.push(subpath);
  }

  assert.ok(checked.length >= 12, `Expected at least 12 typed export subpaths, checked ${checked.length}`);
});
