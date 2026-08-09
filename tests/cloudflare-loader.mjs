export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: "data:text/javascript,export const env = globalThis.__cloudflareEnv ?? {};",
      shortCircuit: true,
    };
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    !/\.[a-z0-9]+$/i.test(specifier)
  ) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      try {
        return await nextResolve(`${specifier}/index.ts`, context);
      } catch {
        // Fall through to Node's default resolution.
      }
    }
  }
  return nextResolve(specifier, context);
}
