import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { routes } from '../src/devRoutes.js';

/** Every `route(name, METHOD, path, ...)` functions.ts registers on Azure. */
function functionRoutes(): Array<{ name: string; method: string; path: string }> {
  const src = readFileSync(fileURLToPath(new URL('../src/functions.ts', import.meta.url)), 'utf8');
  return [...src.matchAll(/route\('([^']+)', '([A-Z]+)', '([^']+)'/g)].map((m) => ({ name: m[1]!, method: m[2]!, path: m[3]! }));
}

describe('dev server route table', () => {
  it('serves every route the Functions app registers', () => {
    const fns = functionRoutes();
    expect(fns.length).toBeGreaterThan(80);
    const missing = fns.filter(({ method, path }) => {
      const sample = '/' + path.replace(/\{[^}]+\}/g, 'x1');
      return !routes.some((r) => r.method === method && r.re.test(sample));
    });
    expect(missing.map((m) => `${m.method} ${m.path} (${m.name})`)).toEqual([]);
  });
});
