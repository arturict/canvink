// The app follows the browser language. Unit tests assert the German texts,
// so they run as a German browser; tests of the detection pass their own list.
const realNavigator = globalThis.navigator;
const germanBrowser = new Proxy(realNavigator ?? {}, {
  get(target, property) {
    if (property === 'language') return 'de-CH';
    if (property === 'languages') return ['de-CH'];
    // Native getters need the real navigator as `this`.
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: germanBrowser });
