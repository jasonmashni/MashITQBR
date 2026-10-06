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
  /** Start a request. Any earlier request still in flight becomes stale and is ignored. */
  run: (fetcher: () => Promise<T>) => void;
  /** Make the in-flight request stale (unmount / deps change) without publishing anything. */
  cancel: () => void;
  /** Replace the data locally (after a save) and clear any error. */
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
    run(fetcher) {
      const id = ++requestId;
      publish({ data: state.data, error: null, loading: true });
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
      publish({ data, error: null, loading: false });
    },
  };
}

/**
 * Load a value whenever `deps` change, ignoring stale responses. `reload()`
 * refetches with the same deps; `setData()` swaps in a locally saved value.
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

  useEffect(() => {
    ctrl.run(() => fetcherRef.current());
    return () => ctrl.cancel();
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload, setData: ctrl.setData };
}
