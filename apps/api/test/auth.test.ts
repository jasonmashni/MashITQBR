import { afterEach, describe, expect, it } from 'vitest';
import { authRequired, gate, isPublicRoute } from '../src/gate.js';

const principal = Buffer.from(
  JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'name', val: 'Tech' }, { typ: 'preferred_username', val: 'tech@mashit.net' }] }),
).toString('base64');

const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

describe('authRequired', () => {
  it('follows QBR_AUTH_REQUIRED when set, else whether we run in Azure', () => {
    expect(authRequired({ QBR_AUTH_REQUIRED: '1' })).toBe(true);
    expect(authRequired({ QBR_AUTH_REQUIRED: '0' })).toBe(false);
    expect(authRequired({ WEBSITE_INSTANCE_ID: 'abc' })).toBe(true);
    expect(authRequired({})).toBe(false);
  });
});

describe('authRequired in Azure', () => {
  it('ignores QBR_AUTH_REQUIRED=0 on App Service: the override is local-only', () => {
    expect(authRequired({ QBR_AUTH_REQUIRED: '0', WEBSITE_INSTANCE_ID: 'abc' })).toBe(true);
  });
});

describe('isPublicRoute', () => {
  it('admits only the booking page and its API', () => {
    for (const p of ['book', 'book/tok', '/book/tok', 'api/book', 'api/book/tok', 'api/book/tok/slots']) expect(isPublicRoute(p)).toBe(true);
    for (const p of ['api/clients', 'api/me', 'booking', 'api/bookx', 'api/clients/anp/qbr/2026-Q1/booking', '']) expect(isPublicRoute(p)).toBe(false);
  });
});

describe('gate', () => {
  const prev = process.env['QBR_AUTH_REQUIRED'];
  afterEach(() => {
    if (prev === undefined) delete process.env['QBR_AUTH_REQUIRED'];
    else process.env['QBR_AUTH_REQUIRED'] = prev;
  });
  const okFn = async () => ({ status: 200, json: { ok: true } });

  it('401s a protected route without an Easy Auth principal when auth is required', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '1';
    let ran = false;
    const res = await gate('api/clients', headers({}), async () => {
      ran = true;
      return { status: 200, json: {} };
    });
    expect(res.status).toBe(401);
    expect(ran).toBe(false);
  });

  it('401s api/me without a principal so the UI shows sign-in', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '1';
    expect((await gate('api/me', headers({}), okFn)).status).toBe(401);
  });

  it('401s on a principal header that does not decode', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '1';
    const res = await gate('api/clients', headers({ 'x-ms-client-principal': 'not-json' }), okFn);
    expect(res.status).toBe(401);
  });

  it('reaches the handler with a valid principal', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '1';
    const res = await gate('api/clients', headers({ 'x-ms-client-principal': principal }), okFn);
    expect(res).toEqual({ status: 200, json: { ok: true } });
  });

  it('lets the public booking routes through without a principal', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '1';
    expect((await gate('api/book/tok', headers({}), okFn)).status).toBe(200);
    expect((await gate('book/tok', headers({}), okFn)).status).toBe(200);
  });

  it('gates the system capabilities routes like every other route', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '1';
    for (const p of ['api/system', 'api/capabilities', 'api/system-info', '/api/system/']) {
      expect(await gate(p, headers({}), okFn)).toEqual({ status: 401, json: { error: 'Not signed in' } });
      expect((await gate(p, headers({ 'x-ms-client-principal': principal }), okFn)).status).toBe(200);
    }
  });

  it('is open when auth is not required (local dev)', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '0';
    expect((await gate('api/clients', headers({}), okFn)).status).toBe(200);
  });

  it('401s a forged empty principal ({} base64)', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '1';
    expect((await gate('api/clients', headers({ 'x-ms-client-principal': 'e30=' }), okFn)).status).toBe(401);
    const noClaims = Buffer.from(JSON.stringify({ auth_typ: 'aad', claims: [] })).toString('base64');
    expect((await gate('api/clients', headers({ 'x-ms-client-principal': noClaims }), okFn)).status).toBe(401);
    const noType = Buffer.from(JSON.stringify({ claims: [{ typ: 'name', val: 'x' }] })).toString('base64');
    expect((await gate('api/clients', headers({ 'x-ms-client-principal': noType }), okFn)).status).toBe(401);
  });

  describe('on App Service', () => {
    const keys = ['WEBSITE_INSTANCE_ID', 'WEBSITE_AUTH_ENABLED'] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    afterEach(() => {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('passes a valid envelope when Easy Auth is on (WEBSITE_AUTH_ENABLED=True, any case)', async () => {
      delete process.env['QBR_AUTH_REQUIRED'];
      process.env['WEBSITE_INSTANCE_ID'] = 'abc';
      for (const v of ['True', 'true', 'TRUE', '1', ' true ']) {
        process.env['WEBSITE_AUTH_ENABLED'] = v;
        expect((await gate('api/clients', headers({ 'x-ms-client-principal': principal }), okFn)).status).toBe(200);
      }
    });

    it('fails closed without WEBSITE_AUTH_ENABLED, even with a valid header', async () => {
      delete process.env['QBR_AUTH_REQUIRED'];
      process.env['WEBSITE_INSTANCE_ID'] = 'abc';
      delete process.env['WEBSITE_AUTH_ENABLED'];
      expect((await gate('api/clients', headers({ 'x-ms-client-principal': principal }), okFn)).status).toBe(401);
      for (const v of ['False', '0', '', 'yes', 'truee', '11']) {
        process.env['WEBSITE_AUTH_ENABLED'] = v;
        expect((await gate('api/system', headers({ 'x-ms-client-principal': principal }), okFn)).status).toBe(401);
      }
      // The public booking page keeps working.
      expect((await gate('api/book/tok', headers({}), okFn)).status).toBe(200);
    });

    it('cannot be switched off with QBR_AUTH_REQUIRED=0', async () => {
      process.env['QBR_AUTH_REQUIRED'] = '0';
      process.env['WEBSITE_INSTANCE_ID'] = 'abc';
      process.env['WEBSITE_AUTH_ENABLED'] = 'True';
      expect((await gate('api/clients', headers({}), okFn)).status).toBe(401);
    });
  });
});
