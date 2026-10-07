import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBody } from '../src/body.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qbr-bodies-'));
  process.env['QBR_DATA_DIR'] = dir;
  delete process.env['AzureWebJobsStorage'];
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['QBR_DATA_DIR'];
});

describe('parseBody', () => {
  it('returns null for malformed JSON and for non-object JSON', () => {
    expect(parseBody('{bad')).toBeNull();
    expect(parseBody('[1,2]')).toBeNull();
    expect(parseBody('null')).toBeNull();
    expect(parseBody('"text"')).toBeNull();
  });
  it('treats an empty body as an empty object', () => {
    expect(parseBody('')).toEqual({});
    expect(parseBody('   ')).toEqual({});
  });
  it('parses a JSON object', () => {
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('write handlers reject empty bodies', () => {
  it('putConfig', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.putConfig('anp', {})).status).toBe(400);
    expect((await h.putConfig('anp', { hiddenSections: [] })).status).toBe(200);
  });
  it('putDiscussion', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.putDiscussion('anp', '2026-Q1', {})).status).toBe(400);
    expect((await h.putDiscussion('anp', '2026-Q1', { items: [] })).status).toBe(200);
  });
  it('putClientGoals', async () => {
    const h = await import('../src/handlers.js');
    await (await import('../src/store/index.js')).getDataStore().upsertClient({ id: 'bx', name: 'Body Co' });
    expect((await h.putClientGoals('bx', {})).status).toBe(400);
    expect((await h.putClientGoals('bx', { goals: 'not-a-list' })).status).toBe(400);
    expect((await h.putClientGoals('bx', { goals: [{ title: 'Move to Intune' }] })).status).toBe(200);
  });
  it('putOrgSettings', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.putOrgSettings({})).status).toBe(400);
    expect((await h.putOrgSettings({ brand: { name: 'Mash IT' } })).status).toBe(200);
  });
});

describe('brand colors', () => {
  it('rejects anything but a #rrggbb hex for primary and accent', async () => {
    const h = await import('../src/handlers.js');
    expect((await h.putOrgSettings({ brand: { primary: '#000}</style><script>' } })).status).toBe(400);
    expect((await h.putOrgSettings({ brand: { accent: 'red' } })).status).toBe(400);
    expect((await h.putOrgSettings({ brand: { primary: '#004aad' } })).status).toBe(200);
    expect((await h.putOrgSettings({ brand: { primary: '#004AAD', accent: '#0B2545' } })).status).toBe(200);
  });
});
