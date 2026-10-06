import { afterEach, describe, expect, it } from 'vitest';
import { authRequired, gate, isPublicRoute } from '../src/gate.js';

const principal = Buffer.from(
  JSON.stringify({ auth_typ: 'aad', claims: [{ typ: 'name', val: 'Tech' }, { typ: 'preferred_username', val: 'tech@mashit.net' }] }),
).toString('base64');

const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

describe('authRequired', () => {
  it('follows QBR_AUTH_REQUIRED when set, else whether we run in Azure', () => {
    expect(authRequired({ QBR_AUTH_REQUIRED: '1' })).toBe(true);
    expect(authRequired({ QBR_AUTH_REQUIRED: '0', WEBSITE_INSTANCE_ID: 'abc' })).toBe(false);
    expect(authRequired({ WEBSITE_INSTANCE_ID: 'abc' })).toBe(true);
    expect(authRequired({})).toBe(false);
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

  it('lets the system capabilities routes through so the header can render a sign-in state', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '1';
    for (const p of ['api/system', 'api/capabilities', 'api/system-info']) expect((await gate(p, headers({}), okFn)).status).toBe(200);
  });

  it('is open when auth is not required (local dev)', async () => {
    process.env['QBR_AUTH_REQUIRED'] = '0';
    expect((await gate('api/clients', headers({}), okFn)).status).toBe(200);
  });
});
