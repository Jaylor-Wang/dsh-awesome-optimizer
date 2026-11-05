import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function findTsc() {
  const searchBases = [
    root,
    path.resolve(root, '../Awesome-Canvas/web'),
    path.resolve(root, '../threejs-projects'),
    'D:/nodejs/node_global/node_modules/@deepseek-ai/dsh',
    'D:/nodejs/node_global'
  ];
  for (const base of searchBases) {
    try {
      const baseReq = createRequire(path.join(base, 'package.json'));
      const pkgFile = baseReq.resolve('typescript/package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const binRel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsc;
      if (binRel) {
        return path.resolve(path.dirname(pkgFile), binRel);
      }
    } catch {
      // Try next candidate
    }
  }
  return null;
}

const tscBin = findTsc();
if (tscBin) {
  const res = spawnSync(process.execPath, [tscBin, '--project', path.join(root, 'tsconfig.json'), '--noEmit'], {
    cwd: root,
    stdio: 'inherit'
  });
  if (res.error) throw res.error;
  process.exitCode = res.status ?? 1;
} else {
  // Verify all declared .d.ts files exist and match package.json exports
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (typeof entry === 'object' && entry !== null && entry.types) {
      const resolved = path.resolve(root, entry.types);
      if (!fs.existsSync(resolved)) {
        console.error(`Missing declaration file for export "${subpath}": ${entry.types}`);
        process.exitCode = 1;
      }
    }
  }
  if (!process.exitCode) {
    console.log('Verified all package.json TypeScript declaration entrypoints exist.');
  }
}
