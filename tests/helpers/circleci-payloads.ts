/**
 * CircleCI v2 webhook payload fixtures, shaped after CircleCI's documented
 * bodies — including the parts that make it a CI-only provider: a project slug
 * and repository URL instead of a host repository id, and no runner queue
 * timestamp anywhere.
 */

export const workflowCompleted = (overrides: Record<string, unknown> = {}) => ({
  id: '3888f21b-0000-4000-8000-000000000001',
  type: 'workflow-completed',
  happened_at: '2026-03-01T10:07:00.000Z',
  webhook: { id: 'wh-1', name: 'DevAnalytics' },
  project: {
    id: '84996d1a-0000-4000-8000-000000000002',
    name: 'api',
    slug: 'gh/acme/api',
  },
  organization: { id: 'org-1', name: 'acme' },
  workflow: {
    id: 'wf-0000-0001',
    name: 'build-and-test',
    created_at: '2026-03-01T10:01:30.000Z',
    stopped_at: '2026-03-01T10:07:00.000Z',
    url: 'https://app.circleci.com/pipelines/github/acme/api/130/workflows/wf-0000-0001',
    status: 'success',
  },
  pipeline: {
    id: 'pl-0000-0001',
    number: 130,
    created_at: '2026-03-01T10:00:00.000Z',
    trigger: { type: 'webhook' },
    vcs: {
      provider_name: 'github',
      origin_repository_url: 'https://github.com/acme/api',
      target_repository_url: 'https://github.com/acme/api',
      revision: 'abc1560886d4f094c3e6c9ef40349f7d38b5d27d',
      branch: 'feature/rate-limit',
      commit: {
        subject: 'Add rate limiting',
        body: '',
        authored_at: '2026-03-01T09:55:00.000Z',
        committed_at: '2026-03-01T09:55:00.000Z',
        author: { name: 'Ana Reyes', email: 'ana@example.com' },
      },
    },
  },
  ...overrides,
});

export const jobCompleted = () => ({
  id: '3888f21b-0000-4000-8000-000000000003',
  type: 'job-completed',
  happened_at: '2026-03-01T10:04:00.000Z',
  project: { id: 'p1', name: 'api', slug: 'gh/acme/api' },
  organization: { id: 'org-1', name: 'acme' },
  job: { id: 'job-1', number: 136, name: 'build', started_at: '2026-03-01T10:01:40.000Z', stopped_at: '2026-03-01T10:04:00.000Z', status: 'success' },
  workflow: { id: 'wf-0000-0001', name: 'build-and-test', created_at: '2026-03-01T10:01:30.000Z' },
  pipeline: { id: 'pl-0000-0001', number: 130, created_at: '2026-03-01T10:00:00.000Z', vcs: { provider_name: 'github', target_repository_url: 'https://github.com/acme/api', revision: 'abc', branch: 'main' } },
});
