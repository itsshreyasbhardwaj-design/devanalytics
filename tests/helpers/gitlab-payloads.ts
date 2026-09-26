/**
 * GitLab webhook payload fixtures.
 *
 * Shaped after GitLab's documented project webhook bodies, including the
 * awkward parts: `iid` versus `id`, space-separated timestamps with a trailing
 * zone, `short_sha` on deployments, and the absence of any diff statistics on
 * the merge request hook.
 */

export const PROJECT = {
  id: 15,
  name: 'Checkout',
  description: '',
  web_url: 'https://gitlab.example.com/northwind/payments/checkout',
  namespace: 'payments',
  visibility_level: 0,
  path_with_namespace: 'northwind/payments/checkout',
  default_branch: 'main',
  homepage: 'https://gitlab.example.com/northwind/payments/checkout',
  url: 'git@gitlab.example.com:northwind/payments/checkout.git',
};

export const USER = { id: 51, name: 'Ana Reyes', username: 'ana', avatar_url: null, email: 'ana@example.com' };
export const REVIEWER = { id: 62, name: 'Devon Park', username: 'devon', avatar_url: null };

export const mergeRequestAttributes = (overrides: Record<string, unknown> = {}) => ({
  id: 9001,
  iid: 42,
  target_branch: 'main',
  source_branch: 'feature/idempotency',
  source_project_id: 15,
  target_project_id: 15,
  author_id: 51,
  title: 'Add idempotency key to checkout',
  created_at: '2026-03-01 09:00:00 UTC',
  updated_at: '2026-03-01 09:00:00 UTC',
  state: 'opened',
  work_in_progress: false,
  draft: false,
  merge_status: 'can_be_merged',
  description: '',
  url: 'https://gitlab.example.com/northwind/payments/checkout/-/merge_requests/42',
  action: 'open',
  merge_commit_sha: null,
  last_commit: {
    id: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
    message: 'Add idempotency key',
    timestamp: '2026-03-01T08:55:00+00:00',
  },
  ...overrides,
});

export const mergeRequestHook = (attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  object_kind: 'merge_request',
  event_type: 'merge_request',
  user: USER,
  project: PROJECT,
  object_attributes: mergeRequestAttributes(attrs),
  labels: [],
  repository: { name: 'Checkout', url: PROJECT.url, homepage: PROJECT.homepage },
  ...extra,
});

export const pushHook = (overrides: Record<string, unknown> = {}) => ({
  object_kind: 'push',
  event_name: 'push',
  before: '95790bf891e76fee5e1747ab589903a6a1f80f22',
  after: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
  ref: 'refs/heads/main',
  checkout_sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
  user_id: 51,
  user_name: 'Ana Reyes',
  user_username: 'ana',
  user_email: 'ana@example.com',
  project_id: 15,
  project: PROJECT,
  commits: [
    {
      id: 'b6568db1bc1dcd7f8b4d5a946b0b91f9dacd7327',
      message: 'Update checkout client',
      title: 'Update checkout client',
      timestamp: '2026-03-01T08:50:00+00:00',
      url: 'https://gitlab.example.com/northwind/payments/checkout/-/commit/b6568db1',
      author: { name: 'Ana Reyes', email: 'ana@example.com' },
      added: ['a.ts'],
      modified: ['b.ts'],
      removed: [],
    },
    {
      id: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
      message: 'Add idempotency key',
      title: 'Add idempotency key',
      timestamp: '2026-03-01T08:55:00+00:00',
      url: 'https://gitlab.example.com/northwind/payments/checkout/-/commit/da156088',
      author: { name: 'Ana Reyes', email: 'ana@example.com' },
      added: [],
      modified: ['c.ts'],
      removed: [],
    },
  ],
  total_commits_count: 2,
  ...overrides,
});

export const noteHook = (attrs: Record<string, unknown> = {}) => ({
  object_kind: 'note',
  event_type: 'note',
  user: REVIEWER,
  project_id: 15,
  project: PROJECT,
  object_attributes: {
    id: 1244,
    note: 'This needs a retry budget.',
    noteable_type: 'MergeRequest',
    author_id: 62,
    created_at: '2026-03-01 11:30:00 UTC',
    updated_at: '2026-03-01 11:30:00 UTC',
    project_id: 15,
    line_code: '8ec9a00bfd09b3190ac6b22251dbb1aa95a0579d_0_1',
    noteable_id: 9001,
    system: false,
    type: 'DiffNote',
    url: 'https://gitlab.example.com/northwind/payments/checkout/-/merge_requests/42#note_1244',
    position: { new_path: 'src/checkout.ts', old_path: 'src/checkout.ts', new_line: 12 },
    ...attrs,
  },
  merge_request: mergeRequestAttributes(),
});

export const pipelineHook = (attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  object_kind: 'pipeline',
  object_attributes: {
    id: 31,
    iid: 3,
    ref: 'main',
    tag: false,
    sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
    before_sha: '95790bf891e76fee5e1747ab589903a6a1f80f22',
    source: 'merge_request_event',
    status: 'success',
    stages: ['test', 'deploy'],
    created_at: '2026-03-01 10:00:00 UTC',
    finished_at: '2026-03-01 10:07:00 UTC',
    duration: 420,
    queued_duration: 45,
    url: 'https://gitlab.example.com/northwind/payments/checkout/-/pipelines/31',
    ...attrs,
  },
  merge_request: { id: 9001, iid: 42, title: 'Add idempotency key to checkout', source_branch: 'feature/idempotency', target_branch: 'main', state: 'opened', url: '...' },
  user: USER,
  project: PROJECT,
  commit: { id: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7', message: 'Add idempotency key' },
  builds: [],
  ...extra,
});

export const deploymentHook = (overrides: Record<string, unknown> = {}) => ({
  object_kind: 'deployment',
  status: 'success',
  status_changed_at: '2026-03-01 12:15:00 +0200',
  deployment_id: 7788,
  deployable_id: 796,
  deployable_url: 'https://gitlab.example.com/northwind/payments/checkout/-/jobs/796',
  environment: 'production',
  environment_slug: 'production',
  environment_external_url: 'https://checkout.example.com',
  project: PROJECT,
  short_sha: 'da156088',
  user: USER,
  user_url: 'https://gitlab.example.com/ana',
  commit_url: 'https://gitlab.example.com/northwind/payments/checkout/-/commit/da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
  commit_title: 'Add idempotency key',
  ...overrides,
});
