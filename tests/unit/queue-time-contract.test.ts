import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import type { RawWebhookDelivery } from '@devanalytics/core';
import { GitHubWebhookAdapter } from '@devanalytics/github';
import { GitLabWebhookAdapter } from '@devanalytics/gitlab';
import { CircleCiWebhookAdapter } from '@devanalytics/circleci';
import { pipelineHook } from '../helpers/gitlab-payloads.js';
import { workflowCompleted } from '../helpers/circleci-payloads.js';

/**
 * The enqueue-time contract, asserted across every provider.
 *
 * `ci_queue_time` is `started_at - enqueued_at`, and a provider that cannot
 * report an enqueue time must send null so its runs are excluded rather than
 * recorded as having waited no time. That is easy to break silently — a code
 * host that stops sending it looks fine until its queue time quietly
 * disappears from the metric — so every adapter is checked here.
 */

const githubRun = () => {
  const body = JSON.stringify({
    action: 'completed',
    workflow: { id: 77, name: 'CI', path: '.github/workflows/ci.yml' },
    workflow_run: {
      id: 12345, run_attempt: 1, head_sha: 'abc', head_branch: 'main',
      event: 'push', status: 'completed', conclusion: 'success',
      created_at: '2026-03-02T10:00:00Z',
      run_started_at: '2026-03-02T10:02:00Z',
      updated_at: '2026-03-02T10:09:00Z',
      workflow_id: 77, pull_requests: [],
      actor: { id: 9, login: 'ana', type: 'User' },
    },
    repository: { id: 900, name: 'api', full_name: 'acme/api', default_branch: 'main', private: true, owner: { login: 'acme' } },
    organization: { login: 'acme' },
  });
  const delivery: RawWebhookDelivery = {
    provider: 'github', body,
    headers: {
      'x-github-event': 'workflow_run', 'x-github-delivery': 'd1',
      'x-hub-signature-256': `sha256=${createHmac('sha256', 's').update(body).digest('hex')}`,
    },
    receivedAt: '2026-03-02T11:00:00.000Z',
  };
  return new GitHubWebhookAdapter().normalize(delivery)[0];
};

const gitlabRun = () => {
  const delivery: RawWebhookDelivery = {
    provider: 'gitlab',
    body: JSON.stringify(pipelineHook()),
    headers: { 'x-gitlab-event': 'Pipeline Hook', 'x-gitlab-event-uuid': 'u1', 'x-gitlab-token': 's' },
    receivedAt: '2026-03-02T11:00:00.000Z',
  };
  return new GitLabWebhookAdapter().normalize(delivery)[0];
};

const circleRun = () => {
  const body = JSON.stringify(workflowCompleted());
  const delivery: RawWebhookDelivery = {
    provider: 'circleci', body,
    headers: {
      'circleci-event-type': 'workflow-completed',
      'circleci-signature': `v1=${createHmac('sha256', 's').update(body, 'utf8').digest('hex')}`,
    },
    receivedAt: '2026-03-02T11:00:00.000Z',
  };
  return new CircleCiWebhookAdapter().normalize(delivery)[0];
};

describe('CI enqueue-time contract', () => {
  it('GitHub reports an enqueue time, so its runs count toward queue time', () => {
    const payload = githubRun()?.payload as Record<string, unknown>;
    expect(payload.enqueuedAt).toBe('2026-03-02T10:00:00Z');
    expect(payload.startedAt).toBe('2026-03-02T10:02:00Z');
  });

  it('GitLab reports an enqueue time, and reconstructs the start from the wait', () => {
    const payload = gitlabRun()?.payload as Record<string, unknown>;
    expect(payload.enqueuedAt).toBe('2026-03-01T10:00:00.000Z');
    expect(payload.startedAt).toBe('2026-03-01T10:00:45.000Z');
  });

  it('CircleCI reports none, so its runs are excluded rather than shown as instant', () => {
    const payload = circleRun()?.payload as Record<string, unknown>;
    expect(payload.enqueuedAt).toBeNull();
    // Duration is still measurable, which is why null is not the same as
    // dropping the run entirely.
    expect(payload.startedAt).toBe('2026-03-01T10:01:30.000Z');
    expect(payload.completedAt).toBe('2026-03-01T10:07:00.000Z');
  });

  it('every adapter states an enqueue time explicitly, present or null', () => {
    // An adapter that simply forgot the field would be indistinguishable from
    // one that deliberately reports none, and would silently vanish from the
    // queue-time metric.
    for (const [name, event] of [['github', githubRun()], ['gitlab', gitlabRun()], ['circleci', circleRun()]] as const) {
      const payload = event?.payload as Record<string, unknown>;
      expect(Object.keys(payload), `${name} omits enqueuedAt entirely`).toContain('enqueuedAt');
    }
  });

  it('every adapter reports a start time, so build duration works everywhere', () => {
    for (const [name, event] of [['github', githubRun()], ['gitlab', gitlabRun()], ['circleci', circleRun()]] as const) {
      const payload = event?.payload as Record<string, unknown>;
      expect(payload.startedAt, `${name} reports no start time`).toBeTruthy();
    }
  });
});
