import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A function with a fixed identity that calls the latest `callback`. It lets
 * memoised children take an event handler without re-rendering each time the
 * parent's handler closes over new state. Only call it from events and
 * effects, not while rendering: it points at the newest callback once the
 * render has committed.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
