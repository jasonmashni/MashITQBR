import { describe, it, expect } from 'vitest';
import { FetchHttpTransport } from '@mashit/integrations';

describe('FetchHttpTransport', () => {
  it('retries 429 honoring Retry-After then succeeds', async () => {
    const calls: number[] = [];
    const fetchImpl = async () => {
      calls.push(Date.now());
      if (calls.length < 3) return new Response('slow', { status: 429, headers: { 'Retry-After': '0' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const t = new FetchHttpTransport({ fetchImpl, retries: 3, backoffMs: 1 });
    const r = await t.request({ method: 'GET', url: 'https://x/y' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it('gives up after the retry budget on 503', async () => {
    let n = 0;
    const fetchImpl = async () => {
      n++;
      return new Response('down', { status: 503 });
    };
    const t = new FetchHttpTransport({ fetchImpl, retries: 2, backoffMs: 1 });
    const r = await t.request({ method: 'GET', url: 'https://x/y' });
    expect(r.status).toBe(503);
    expect(n).toBe(3);
  });

  it('does not retry a POST on 5xx (could duplicate a write) but does on 429', async () => {
    let n = 0;
    const t5 = new FetchHttpTransport({
      fetchImpl: async () => {
        n++;
        return new Response('x', { status: 502 });
      },
      retries: 3,
      backoffMs: 1,
    });
    expect((await t5.request({ method: 'POST', url: 'https://x/y', body: '{}' })).status).toBe(502);
    expect(n).toBe(1);
    let m = 0;
    const t4 = new FetchHttpTransport({
      fetchImpl: async () =>
        m++ === 0 ? new Response('x', { status: 429, headers: { 'Retry-After': '0' } }) : new Response('{}', { status: 200 }),
      retries: 3,
      backoffMs: 1,
    });
    expect((await t4.request({ method: 'POST', url: 'https://x/y', body: '{}' })).status).toBe(200);
    expect(m).toBe(2);
  });

  it('does not retry a 4xx other than 429', async () => {
    let n = 0;
    const t = new FetchHttpTransport({
      fetchImpl: async () => {
        n++;
        return new Response('nope', { status: 403 });
      },
      retries: 3,
      backoffMs: 1,
    });
    expect((await t.request({ method: 'GET', url: 'https://x/y' })).status).toBe(403);
    expect(n).toBe(1);
  });

  it('aborts a hung request', async () => {
    const fetchImpl = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const t = new FetchHttpTransport({ fetchImpl, timeoutMs: 20, retries: 0 });
    await expect(t.request({ method: 'GET', url: 'https://x/y' })).rejects.toThrow(/abort/);
  });

  it('keeps the no-arg constructor working', () => {
    expect(() => new FetchHttpTransport()).not.toThrow();
  });
});
