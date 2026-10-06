import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  env: {
    // Pin even the unset/default value in both client and server bundles.
    // A runtime-only override must not disable the route the built client uses.
    NEXT_PUBLIC_PI_CHAT_ENABLED: process.env.NEXT_PUBLIC_PI_CHAT_ENABLED ?? '',
  },
  output: 'standalone',
  outputFileTracingIncludes: {
    '/*': [
      'lib/server/agent-runtime/import-pptx-worker.mjs',
      'skills/openmaic/**',
      'skills/agent-runtime/**',
      // Loaded through a runtime-only `import('undici')` (see the LLM
      // dispatcher in lib/ai/providers.ts and the Google proxy transport), so
      // the output tracer never sees it and standalone builds ship without it.
      'node_modules/undici/**',
      // sharp's native libvips libraries are loaded via dlopen and are not
      // statically analyzable, so Next.js standalone tracing omits them. Two
      // sharp versions resolve in the tree (0.34.5 transitive -> libvips
      // 1.2.4, 0.35.4 direct -> libvips 1.3.3); tracing picked the wrong one
      // and the runtime dlopen of sharp 0.35.4 failed with
      // "libvips-cpp.so.8.18.6: No such file or directory" on self-hosted
      // Docker (Alpine/musl) deployments. Force-include every sharp-libvips
      // native lib dir.
      'node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/sharp-libvips-*/lib/**',
    ],
  },
  typescript: {
    tsconfigPath: process.env.NODE_ENV === 'production' ? 'tsconfig.build.json' : 'tsconfig.json',
  },
  transpilePackages: ['mathml2omml', 'pptxgenjs', '@openmaic/importer'],
  // These agent packages do a runtime `import(specifier)` with a computed
  // specifier (to lazily load node:fs/os/path without breaking browser/Vite
  // builds). webpack can't statically analyze that and bundling it throws
  // "Cannot find module as expression is too dynamic" at runtime on the server
  // (the "Edit with AI" Pro-mode path), which broke the #619 keep-alive e2e.
  // Mark them server-external so Next loads them natively and the dynamic
  // import resolves as a real Node call.
  serverExternalPackages: [
    '@earendil-works/pi-ai',
    '@earendil-works/pi-agent-core',
    '@openmaic/generation',
    // Optional peers of @openmaic/storage, reached through deliberately
    // untraced dynamic imports. Externalizing keeps them out of the bundle,
    // and the static anchor in lib/persistence/asset-byte-store.ts gets them
    // traced into the standalone image -- without it, S3 mode and redirect
    // egress cannot resolve their SDK in the shipped deployment.
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
  ],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
  turbopack: {
    ignoreIssue: [
      {
        // Next compiles `instrumentation.ts` twice: once for Node (the only
        // runtime this app serves on -- every route under app/ declares
        // `runtime = 'nodejs'`) and once for the Edge runtime, as
        // `edge-instrumentation.js`. Next drops that second entry when
        // instrumentation is the only Edge entry, but `middleware.ts` is Edge
        // code, so the entry survives and the whole graph `register()` reaches
        // through its dynamic `import()`s gets bundled again for a runtime that
        // never runs it: `register()` returns immediately unless
        // `process.env.NEXT_RUNTIME === 'nodejs'` (instrumentation.ts:16).
        //
        // The bundler still walks those imports, and reports one diagnostic per
        // Node builtin it finds -- node:crypto, node:fs, node:path and so on.
        // None of them can execute: what they serve sits behind the runtime
        // guard above. This only drops the diagnostics; resolution, bundling
        // and the emitted Edge chunk are unchanged, so nothing about how the
        // server behaves moves.
        //
        // Scoped to the Node-only server code these warnings can only come
        // from, and matched on the diagnostic text, so a Node builtin reaching
        // a route that really is Edge keeps failing the build. The Edge runtime
        // polyfills these anyway, which is why the bundle builds at all.
        //
        // Both fields are given the same pattern because Turbopack splits a
        // diagnostic into a title and a description and the split point for
        // this code style is not documented; a rule only has to match one.
        path: '{instrumentation.ts,lib/**,packages/**}',
        title: /Node\.js (module is loaded|API is used).*Edge Runtime/,
      },
      {
        path: '{instrumentation.ts,lib/**,packages/**}',
        description: /Node\.js (module is loaded|API is used).*Edge Runtime/,
      },
    ],
  },
  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        source: '/(.*)',
        headers: [
          // X-Frame-Options only supports SAMEORIGIN (no allow-list),
          // so we omit it when custom ancestors are configured.
          ...(!extraAncestors ? [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] : []),
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${frameAncestors}`,
          },
        ],
      },
      {
        // Provider logos are drawn wherever services are listed, and each tab
        // switch mounts a fresh set of them. With Next's default `max-age=0`
        // every one is revalidated first and stays blank until the server
        // answers. They are not content-hashed, so cache for a day, not forever.
        source: '/logos/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' },
        ],
      },
    ];
  },
};

export default nextConfig;
