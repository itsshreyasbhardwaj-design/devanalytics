/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: [
    '@devanalytics/core', '@devanalytics/db', '@devanalytics/metrics',
    '@devanalytics/anomaly-detection', '@devanalytics/investigations',
    '@devanalytics/event-ingestion', '@devanalytics/github', '@devanalytics/ai',
    '@devanalytics/api', '@devanalytics/ui', '@devanalytics/demo-data', '@devanalytics/runtime',
  ],
  // The embedded database and pg are loaded at runtime on the server only and
  // must not be bundled into the server build.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  eslint: { ignoreDuringBuilds: true },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // These packages must stay external on the server.
      //
      // PGlite ships a WebAssembly build that finds its own artefacts through
      // `new URL(..., import.meta.url)`; if webpack inlines it, those URLs are
      // rewritten and Node's fs rejects the result at runtime. `pg` and
      // `ioredis` are optional and may not be installed at all.
      //
      // serverExternalPackages alone is not enough here: the workspace package
      // that imports PGlite is listed in transpilePackages, and transpiled
      // packages have their dependencies bundled.
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        { '@electric-sql/pglite': 'commonjs @electric-sql/pglite', pg: 'commonjs pg', ioredis: 'commonjs ioredis' },
      ];
    }
    // Workspace packages are ESM TypeScript source and import siblings with an
    // explicit ".js" extension, as the spec requires. Webpack has to be told
    // that those specifiers resolve to ".ts"/".tsx" on disk.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  async headers() {
    // React Refresh evaluates strings in development, so 'unsafe-eval' is
    // required there and must never be present in a production response.
    const isDev = process.env.NODE_ENV !== 'production';
    const scriptSrc = isDev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self' 'unsafe-inline'";
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          { key: 'x-frame-options', value: 'DENY' },
          {
            key: 'content-security-policy',
            value: [
              "default-src 'self'",
              scriptSrc,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
