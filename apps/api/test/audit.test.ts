import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonDataStore } from '../src/store/index.js';
import { actorFrom, principalFrom } from '../src/auth.js';
import { currentActor, runWithActor } from '../src/requestContext.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-audit-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('audit store', () => {
  it('appends and lists newest-first with a limit', async () => {
    const s = new JsonDataStore(dir);
    for (let i = 0; i < 5; i++) {
      await s.appendAudit({ id: `e${i}`, at: new Date(2026, 0, i + 1).toISOString(), actor: 'jason@mashit.net', action: 'qbr.sync', target: `qbr:c/${i}` });
    }
    const latest = await s.listAudit(3);
    expect(latest).toHaveLength(3);
    expect(latest[0]!.id).toBe('e4'); // newest first
    expect(latest[2]!.id).toBe('e2');
  });
});

describe('principalFrom / actorFrom', () => {
  const envelope = Buffer.from(
    JSON.stringify({
      auth_typ: 'aad',
      name_typ: 'name',
      role_typ: 'roles',
      claims: [
        { typ: 'name', val: 'Jason Mashni' },
        { typ: 'preferred_username', val: 'jason.mashni@mashit.net' },
        { typ: 'roles', val: 'qbr.admin' },
      ],
    }),
  ).toString('base64');

  it('parses the Easy Auth principal envelope', () => {
    const p = principalFrom((n) => (n === 'x-ms-client-principal' ? envelope : undefined));
    expect(p?.name).toBe('Jason Mashni');
    expect(p?.email).toBe('jason.mashni@mashit.net');
    expect(p?.roles).toEqual(['qbr.admin']);
  });

  it('returns undefined without the header and on garbage', () => {
    expect(principalFrom(() => undefined)).toBeUndefined();
    expect(principalFrom((n) => (n === 'x-ms-client-principal' ? '!!!not-base64-json' : undefined))).toBeUndefined();
  });

  it('actorFrom prefers email, falls back to anonymous', () => {
    expect(actorFrom((n) => (n === 'x-ms-client-principal' ? envelope : undefined))).toBe('jason.mashni@mashit.net');
    expect(actorFrom(() => undefined)).toBe('anonymous');
  });
});

describe('request context', () => {
  it('scopes the actor to the wrapped call', async () => {
    expect(currentActor()).toBe('system');
    const inside = await runWithActor('jason@mashit.net', async () => currentActor());
    expect(inside).toBe('jason@mashit.net');
    expect(currentActor()).toBe('system');
  });
});
