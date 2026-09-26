import { getRuntime } from '@/lib/runtime';

/**
 * The REST API, mounted inside the Next.js app.
 *
 * This is a pass-through to the shared route table in @devanalytics/api, so the
 * dashboard's API and the standalone server are the same code and cannot drift.
 */
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  const runtime = await getRuntime();
  return runtime.api.handle(request);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
