import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// A component split into `x.tsx` (device) and `x.web.tsx` (browser) is typed
// from the device half, so a name only that half exports still type-checks and
// is `undefined` on web: React then fails with error #130 the moment it is
// drawn. The halves have to export the same runtime names.

const SRC = join(__dirname, '..', '..');

function twins(dir: string): Array<[string, string]> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__generated__' ? [] : twins(path);
    const match = /^(.*)\.web\.(tsx?)$/.exec(entry.name);
    return match ? [[join(dir, `${match[1]}.${match[2]}`), path] as [string, string]] : [];
  });
}

/** The names a module exports at runtime: types and interfaces left out. */
function runtimeExports(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const names = new Set<string>();
  for (const [, name] of source.matchAll(/^export (?:const|let|function|class|async function) (\w+)/gm)) {
    names.add(name);
  }
  for (const [, list] of source.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const part of list.split(',')) {
      const spec = part.trim();
      if (spec === '' || spec.startsWith('type ')) continue;
      names.add(spec.split(/\s+as\s+/).pop() as string);
    }
  }
  return [...names].sort();
}

describe('device and web halves of a component', () => {
  const pairs = twins(SRC).filter(([device]) => {
    try {
      readFileSync(device);
      return true;
    } catch {
      return false;
    }
  });

  it('are found', () => {
    expect(pairs.length).toBeGreaterThan(0);
  });

  it.each(
    pairs.map(([device, web]) => [relative(SRC, web), device, web]),
  )('%s exports what its device half does', (_name, device, web) => {
    expect(runtimeExports(web)).toEqual(runtimeExports(device));
  });
});
