import { describe, expect, it } from 'vitest';
import { createResourceController, type ResourceState } from '../src/hooks/useResource.js';

/** A promise the test settles by hand, so call ordering is explicit. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness<T>() {
  const states: Array<ResourceState<T>> = [];
  const ctrl = createResourceController<T>((s) => states.push(s));
  const last = () => states[states.length - 1]!;
  return { ctrl, states, last };
}

describe('createResourceController', () => {
  it('a slower first call does not overwrite a faster second call', async () => {
    const { ctrl, last } = harness<string>();
    const first = deferred<string>();
    const second = deferred<string>();
    ctrl.run(() => first.promise);
    ctrl.run(() => second.promise);
    expect(last().loading).toBe(true);

    second.resolve('second');
    await flush();
    expect(last()).toEqual({ data: 'second', error: null, loading: false });

    first.resolve('first');
    await flush();
    expect(last()).toEqual({ data: 'second', error: null, loading: false });
  });

  it('a rejected call sets error and leaves data undefined', async () => {
    const { ctrl, last } = harness<string>();
    const call = deferred<string>();
    ctrl.run(() => call.promise);
    call.reject(new Error('boom'));
    await flush();
    expect(last()).toEqual({ data: undefined, error: 'boom', loading: false });
  });

  it('a stale rejection does not clobber a newer success', async () => {
    const { ctrl, last } = harness<number>();
    const first = deferred<number>();
    const second = deferred<number>();
    ctrl.run(() => first.promise);
    ctrl.run(() => second.promise);
    second.resolve(2);
    first.reject(new Error('late'));
    await flush();
    expect(last()).toEqual({ data: 2, error: null, loading: false });
  });

  it('cancel drops an in-flight response', async () => {
    const { ctrl, states } = harness<string>();
    const call = deferred<string>();
    ctrl.run(() => call.promise);
    const before = states.length;
    ctrl.cancel();
    call.resolve('ignored');
    await flush();
    expect(states.length).toBe(before);
  });

  it('setData replaces data and clears error', async () => {
    const { ctrl, last } = harness<string>();
    const call = deferred<string>();
    ctrl.run(() => call.promise);
    call.reject('not an Error');
    await flush();
    expect(last().error).toBe('Unknown error');
    ctrl.setData('local');
    expect(last()).toEqual({ data: 'local', error: null, loading: false });
  });
});
