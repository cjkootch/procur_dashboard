/**
 * Node ESM loader hook that replaces `import 'server-only'` with an
 * empty module during test runs. The real `server-only` package always
 * throws at import time — it's a Next.js build-time guard, not a
 * runtime helper. Without this shim, any test that touches a module
 * graph containing `import 'server-only'` would crash before a single
 * assertion ran.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    return {
      url: 'data:text/javascript,export default {};',
      shortCircuit: true,
      format: 'module',
    };
  }
  return nextResolve(specifier, context);
}
