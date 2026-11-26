import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function findTsc() {
  const searchBases = [root];
  if (process.env.DSH_IMPLEMENTATION_ROOT) {
    searchBases.push(path.resolve(process.env.DSH_IMPLEMENTATION_ROOT));
  }
  try {
    const res = spawnSync('npm root -g', {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      shell: true
    });
    if (res.status === 0 && res.stdout?.trim()) {
      const globalRoot = res.stdout.trim();
      searchBases.push(path.join(globalRoot, '@deepseek-ai/dsh'), globalRoot);
    }
  } catch {}
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
  const pathTsc = spawnSync(`tsc --project "${path.join(root, 'tsconfig.json')}" --noEmit`, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    shell: true
  });
  if (pathTsc.error || pathTsc.status === null) {
    console.error('TypeScript compiler unavailable. Install the development dependencies or provide tsc on PATH.');
  }
  process.exitCode = pathTsc.status ?? 1;
}
