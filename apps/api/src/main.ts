/**
 * Standalone API server.
 *
 * Mounts the same route table as the Next.js app. Useful when the dashboard
 * and the API are deployed separately, or when only the API is wanted.
 */
import { createServer } from 'node:http';
import { createRuntime } from '@devanalytics/runtime';

const port = Number(process.env.PORT ?? 3118);
const runtime = await createRuntime();

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? '/'}`;
  const request = new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
  });

  const response = await runtime.api.handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(port, () => {
  process.stdout.write(`DevAnalytics API listening on http://localhost:${port}\n`);
  process.stdout.write(`OpenAPI: http://localhost:${port}/api/v1/openapi.json\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void runtime.close().then(() => process.exit(0));
    });
  });
}
