const paths = [
  '/', '/repositories', '/teams', '/pull-requests', '/ci', '/deployments',
  '/anomalies', '/investigations', '/investigations?metric=pr_cycle_time',
  '/metrics', '/metrics/pr_cycle_time', '/ask', '/explorer', '/settings',
  '/api/v1/health', '/api/v1/openapi.json', '/metrics/not_a_metric',
];
let failures = 0;
for (const path of paths) {
  const started = Date.now();
  try {
    const res = await fetch(`http://localhost:3117${path}`, { signal: AbortSignal.timeout(180_000) });
    const body = await res.text();
    const expected = path.includes('not_a_metric') ? 404 : 200;
    const ok = res.status === expected;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(res.status).padEnd(4)} ${String(Date.now() - started).padStart(6)}ms ${String(body.length).padStart(8)}b  ${path}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ---                     ${path}  ${err.message}`);
  }
}
console.log(failures === 0 ? '\nall routes ok' : `\n${failures} route(s) failed`);
process.exit(failures === 0 ? 0 : 1);
