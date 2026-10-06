import { useCallback, useEffect, useRef, useState } from 'react';

export interface ResourceState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
}

export interface Resource<T> extends ResourceState<T> {
  reload: () => void;
  setData: (t: T) => void;
}

export interface ResourceController<T> {
  /**
   * Start a request. Any earlier request still in flight becomes stale and is
   * ignored. The previous data is cleared (new deps mean a different resource,
   * e.g. another client) unless `keepData` is set, which `reload()` uses.
   */
  run: (fetcher: () => Promise<T>, opts?: { keepData?: boolean }) => void;
  /** Make the in-flight request stale (unmount / deps change) without publishing anything. */
  cancel: () => void;
  /**
   * Replace the data locally (after a save) and clear any error. Any request
   * still in flight becomes stale, so an older server copy cannot overwrite it.
   */
  setData: (t: T) => void;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Unknown error');

/**
 * The request-sequencing core of `useResource`, kept free of React so it can
 * be tested directly. Every `run` bumps a request id; a response is published
 * only when its id is still the latest. A failure publishes `error` and leaves
 * `data` undefined: no defaults are substituted, so callers can tell "failed
 * to load" from "loaded empty" and block saves that would overwrite real data.
 */
export function createResourceController<T>(onChange: (s: ResourceState<T>) => void): ResourceController<T> {
  let requestId = 0;
  let state: ResourceState<T> = { data: undefined, error: null, loading: false };
  const publish = (next: ResourceState<T>) => {
    state = next;
    onChange(state);
  };
  return {
    run(fetcher, opts = {}) {
      const id = ++requestId;
      publish({ data: opts.keepData ? state.data : undefined, error: null, loading: true });
      let promise: Promise<T>;
      try {
        promise = fetcher();
      } catch (e) {
        promise = Promise.reject(e);
      }
      promise.then(
        (data) => {
          if (id === requestId) publish({ data, error: null, loading: false });
        },
        (e: unknown) => {
          if (id === requestId) publish({ data: undefined, error: errorMessage(e), loading: false });
        },
      );
    },
    cancel() {
      requestId++;
    },
    setData(data) {
      requestId++;
      publish({ data, error: null, loading: false });
    },
  };
}

/**
 * Load a value whenever `deps` change, ignoring stale responses. A deps change
 * clears the previous data; `reload()` refetches with the same deps and keeps
 * it; `setData()` swaps in a locally saved value.
 */
export function useResource<T>(fetcher: () => Promise<T>, deps: unknown[]): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ data: undefined, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const ctrlRef = useRef<ResourceController<T> | null>(null);
  if (!ctrlRef.current) ctrlRef.current = createResourceController<T>(setState);
  const ctrl = ctrlRef.current;
  // Always call the latest fetcher without making it a dependency (callers
  // pass inline arrows; `deps` decides when to refetch).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // Which nonce the last run used: a run with the same deps but a new nonce is
  // a reload() and keeps the data on screen; a deps change clears it so the
  // previous client's data can never be edited and saved under the new one.
  const lastNonceRef = useRef<number | null>(null);

  useEffect(() => {
    const isReload = lastNonceRef.current !== null && lastNonceRef.current !== nonce;
    lastNonceRef.current = nonce;
    ctrl.run(() => fetcherRef.current(), { keepData: isReload });
    return () => ctrl.cancel();
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload, setData: ctrl.setData };
}
