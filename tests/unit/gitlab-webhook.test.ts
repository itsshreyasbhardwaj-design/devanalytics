import { describe, it, expect } from 'vitest';
import { GitLabWebhookAdapter } from '@devanalytics/gitlab';
import type { RawWebhookDelivery } from '@devanalytics/core';
import {
  deploymentHook, mergeRequestHook, noteHook, pipelineHook, pushHook, REVIEWER, USER,
} from '../helpers/gitlab-payloads.js';

const adapter = new GitLabWebhookAdapter();
const SECRET = 'gitlab-endpoint-secret';
const RECEIVED_AT = '2026-03-02T00:00:00.000Z';

function delivery(event: string, body: unknown, overrides: Partial<RawWebhookDelivery> = {}): RawWebhookDelivery {
  return {
    provider: 'gitlab',
    body: JSON.stringify(body),
    headers: {
      'x-gitlab-event': event,
      'x-gitlab-event-uuid': 'uuid-1',
      'x-gitlab-token': SECRET,
    },
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe('GitLab token verification', () => {
  it('accepts the configured token', () => {
    expect(adapter.verifySignature(delivery('Push Hook', pushHook()), SECRET)).toEqual({ valid: true });
  });

  it('rejects a wrong token', () => {
    expect(adapter.verifySignature(delivery('Push Hook', pushHook()), 'other-secret')).toEqual({
      valid: false, reason: 'mismatch',
    });
  });

  it('rejects a token of a different length without throwing', () => {
    const d = delivery('Push Hook', pushHook());
    d.headers['x-gitlab-token'] = 'short';
    expect(adapter.verifySignature(d, SECRET)).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a missing token and a missing secret distinctly', () => {
    const d = delivery('Push Hook', pushHook());
    delete d.headers['x-gitlab-token'];
    expect(adapter.verifySignature(d, SECRET)).toEqual({ valid: false, reason: 'missing_signature' });
    expect(adapter.verifySignature(delivery('Push Hook', pushHook()), '')).toEqual({ valid: false, reason: 'missing_secret' });
  });

  it('does not authenticate the body, unlike an HMAC', () => {
    // Stated as a test because it is a real property of GitLab's scheme, not an
    // oversight: the token travels in a header and says nothing about the body.
    const tampered = delivery('Push Hook', pushHook());
    tampered.body = tampered.body.replace('Add idempotency key', 'Something else entirely');
    expect(adapter.verifySignature(tampered, SECRET).valid).toBe(true);
  });

  it('reuses the delivery UUID across retries so they collapse', () => {
    expect(adapter.deliveryId(delivery('Push Hook', pushHook()))).toBe('uuid-1');
  });
});

describe('GitLab normalization: repository and organization', () => {
  it('derives the organization from nested group paths', () => {
    const [event] = adapter.normalize(delivery('Push Hook', pushHook()));
    expect(event?.orgSlug).toBe('northwind/payments');
    expect(event?.repository).toEqual({
      providerRepoId: '15',
      fullName: 'northwind/payments/checkout',
      name: 'checkout',
      defaultBranch: 'main',
      isPrivate: true,
    });
  });

  it('treats visibility level 20 as public and everything else as private', () => {
    const publicProject = pushHook({ project: { ...pushHook().project, visibility_level: 20 } });
    expect(adapter.normalize(delivery('Push Hook', publicProject))[0]?.repository.isPrivate).toBe(false);

    const internal = pushHook({ project: { ...pushHook().project, visibility_level: 10 } });
    expect(adapter.normalize(delivery('Push Hook', internal))[0]?.repository.isPrivate).toBe(true);
  });

  it('ignores a payload with no project', () => {
    expect(adapter.normalize(delivery('Push Hook', { object_kind: 'push' }))).toEqual([]);
  });

  it('throws on a missing event header or unparseable body', () => {
    expect(() => adapter.normalize({ provider: 'gitlab', body: '{}', headers: {}, receivedAt: RECEIVED_AT })).toThrow(/X-Gitlab-Event/);
    expect(() => adapter.normalize(delivery('Push Hook', undefined as unknown as object))).toThrow(/valid JSON/);
  });
});

describe('GitLab normalization: push', () => {
  it('carries every commit with normalized timestamps', () => {
    const [event] = adapter.normalize(delivery('Push Hook', pushHook()));
    expect(event?.type).toBe('push');
    expect(event?.occurredAt).toBe('2026-03-01T08:55:00.000Z');

    const commits = (event?.payload as { commits: { sha: string; authoredAt: string; additions: null }[] }).commits;
    expect(commits).toHaveLength(2);
    expect(commits[0]?.authoredAt).toBe('2026-03-01T08:50:00.000Z');
    // GitLab's push payload lists changed paths but no line counts. Recording
    // zero would be a measurement; null is the truth.
    expect(commits.every((c) => c.additions === null)).toBe(true);
  });

  it('attributes commits to the pusher, whom GitLab does identify', () => {
    const [event] = adapter.normalize(delivery('Push Hook', pushHook()));
    expect(event?.actor).toMatchObject({ providerUserId: '51', login: 'ana', isBot: false });
  });

  it('ignores a branch deletion, which has no commits', () => {
    expect(adapter.normalize(delivery('Push Hook', pushHook({ commits: [], total_commits_count: 0 })))).toEqual([]);
  });
});

describe('GitLab normalization: merge requests', () => {
  it('uses iid as the human-facing number and id as the provider id', () => {
    const [event] = adapter.normalize(delivery('Merge Request Hook', mergeRequestHook()));
    expect(event?.type).toBe('pull_request.opened');
    expect(event?.payload).toMatchObject({ number: 42, providerPrId: '9001' });
  });

  it('never reports diff statistics it was not given', () => {
    const [event] = adapter.normalize(delivery('Merge Request Hook', mergeRequestHook()));
    const payload = event?.payload as Record<string, unknown>;
    // The merge request hook carries no diff stats at all. Absent keys mean the
    // projector records null rather than a zero that PR size would average in.
    expect(payload).not.toHaveProperty('additions');
    expect(payload).not.toHaveProperty('deletions');
    expect(payload).not.toHaveProperty('changedFiles');
  });

  it('maps a merge to a merge, not just a close', () => {
    const [event] = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook({
        action: 'merge', state: 'merged', updated_at: '2026-03-01 17:00:00 UTC',
        merge_commit_sha: 'abc1560886d4f094c3e6c9ef40349f7d38b5d27d',
      })),
    );
    expect(event?.type).toBe('pull_request.merged');
    expect(event?.payload).toMatchObject({
      state: 'merged',
      mergedAt: '2026-03-01T17:00:00.000Z',
      mergeCommitSha: 'abc1560886d4f094c3e6c9ef40349f7d38b5d27d',
    });
  });

  it('maps a close without a merge to a close', () => {
    const [event] = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook({ action: 'close', state: 'closed', updated_at: '2026-03-01 18:00:00 UTC' })),
    );
    expect(event?.type).toBe('pull_request.closed');
    expect(event?.payload).toMatchObject({ state: 'closed', mergedAt: null, closedAt: '2026-03-01T18:00:00.000Z' });
  });

  it('maps a reopen', () => {
    const [event] = adapter.normalize(delivery('Merge Request Hook', mergeRequestHook({ action: 'reopen', state: 'opened' })));
    expect(event?.type).toBe('pull_request.reopened');
  });

  it('treats an approval as a submitted review', () => {
    const [event] = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook({ action: 'approved', updated_at: '2026-03-01 12:00:00 UTC' }, { user: REVIEWER })),
    );
    expect(event?.type).toBe('review.submitted');
    expect(event?.payload).toMatchObject({ state: 'approved', submittedAt: '2026-03-01T12:00:00.000Z' });
    expect(event?.actor?.login).toBe('devon');
  });

  it('treats a single-reviewer approval the same as reaching the threshold', () => {
    const single = adapter.normalize(delivery('Merge Request Hook', mergeRequestHook({ action: 'approval' }, { user: REVIEWER })));
    expect(single[0]?.type).toBe('review.submitted');
    expect(single[0]?.payload).toMatchObject({ state: 'approved' });
  });

  it('treats an unapproval as a dismissed review', () => {
    const [event] = adapter.normalize(delivery('Merge Request Hook', mergeRequestHook({ action: 'unapproved' }, { user: REVIEWER })));
    expect(event?.payload).toMatchObject({ state: 'dismissed' });
  });

  it('detects leaving draft from the draft flag', () => {
    const [event] = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook(
        { action: 'update', draft: false, updated_at: '2026-03-01 10:30:00 UTC' },
        { changes: { draft: { previous: true, current: false } } },
      )),
    );
    expect(event?.type).toBe('pull_request.ready_for_review');
    expect(event?.occurredAt).toBe('2026-03-01T10:30:00.000Z');
  });

  it('detects leaving draft from the title prefix on older GitLab', () => {
    const [event] = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook(
        { action: 'update', title: 'Add idempotency key' },
        { changes: { title: { previous: 'Draft: Add idempotency key', current: 'Add idempotency key' } } },
      )),
    );
    expect(event?.type).toBe('pull_request.ready_for_review');
  });

  it('does not treat entering draft as becoming ready', () => {
    const events = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook(
        { action: 'update', draft: true },
        { changes: { draft: { previous: false, current: true } } },
      )),
    );
    expect(events).toEqual([]);
  });

  it('emits a review request when a reviewer is added', () => {
    const events = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook(
        { action: 'update' },
        { changes: { reviewers: { previous: [], current: [REVIEWER] } } },
      )),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('pull_request.review_requested');
    expect((events[0]?.payload as { requestedReviewer: { login: string } }).requestedReviewer.login).toBe('devon');
  });

  it('ignores routine updates', () => {
    expect(adapter.normalize(delivery('Merge Request Hook', mergeRequestHook({ action: 'update' }, { changes: { updated_at: {} } })))).toEqual([]);
    expect(adapter.normalize(delivery('Merge Request Hook', mergeRequestHook({ action: 'update' })))).toEqual([]);
  });

  it('marks a draft merge request as a draft', () => {
    const [event] = adapter.normalize(delivery('Merge Request Hook', mergeRequestHook({ draft: true })));
    expect(event?.payload).toMatchObject({ isDraft: true });
  });
});

describe('GitLab normalization: notes', () => {
  it('maps an inline diff comment to a review comment', () => {
    const [event] = adapter.normalize(delivery('Note Hook', noteHook()));
    expect(event?.type).toBe('review_comment.created');
    expect(event?.payload).toMatchObject({
      providerCommentId: '1244',
      path: 'src/checkout.ts',
      createdAt: '2026-03-01T11:30:00.000Z',
    });
  });

  it('ignores system notes, which are GitLab bookkeeping', () => {
    expect(adapter.normalize(delivery('Note Hook', noteHook({ system: true })))).toEqual([]);
  });

  it('ignores general discussion, whose GitHub analogue is not ingested either', () => {
    expect(adapter.normalize(delivery('Note Hook', noteHook({ type: null })))).toEqual([]);
  });

  it('ignores notes on issues and commits', () => {
    expect(adapter.normalize(delivery('Note Hook', noteHook({ noteable_type: 'Issue' })))).toEqual([]);
  });
});

describe('GitLab normalization: pipelines', () => {
  it('maps a finished pipeline to a completed run', () => {
    const [event] = adapter.normalize(delivery('Pipeline Hook', pipelineHook()));
    expect(event?.type).toBe('workflow_run.completed');
    expect(event?.payload).toMatchObject({
      providerRunId: '31',
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-03-01T10:00:00.000Z',
      completedAt: '2026-03-01T10:07:00.000Z',
      event: 'merge_request_event',
      runAttempt: 1,
    });
  });

  it('reconstructs the start time from queued_duration', () => {
    const [event] = adapter.normalize(delivery('Pipeline Hook', pipelineHook()));
    // created 10:00:00 + 45s queued.
    expect(event?.payload).toMatchObject({ startedAt: '2026-03-01T10:00:45.000Z' });
  });

  it('leaves the start time unknown when GitLab does not report queue duration', () => {
    const [event] = adapter.normalize(delivery('Pipeline Hook', pipelineHook({ queued_duration: null })));
    // Older GitLab omits it. Null keeps CI queue time out of the metric rather
    // than reporting a zero-second queue.
    expect(event?.payload).toMatchObject({ startedAt: null });
  });

  it('maps failure and cancellation distinctly', () => {
    expect((adapter.normalize(delivery('Pipeline Hook', pipelineHook({ status: 'failed' })))[0]?.payload as { conclusion: string }).conclusion).toBe('failure');
    expect((adapter.normalize(delivery('Pipeline Hook', pipelineHook({ status: 'canceled' })))[0]?.payload as { conclusion: string }).conclusion).toBe('cancelled');
    expect((adapter.normalize(delivery('Pipeline Hook', pipelineHook({ status: 'skipped' })))[0]?.payload as { conclusion: string }).conclusion).toBe('skipped');
  });

  it('maps a running pipeline to a started run', () => {
    const [event] = adapter.normalize(delivery('Pipeline Hook', pipelineHook({ status: 'running', finished_at: null })));
    expect(event?.type).toBe('workflow_run.started');
    expect(event?.payload).toMatchObject({ status: 'in_progress', conclusion: null, completedAt: null });
  });

  it('ignores pre-start statuses that would never resolve', () => {
    for (const status of ['created', 'pending', 'preparing', 'waiting_for_resource', 'manual', 'scheduled']) {
      expect(adapter.normalize(delivery('Pipeline Hook', pipelineHook({ status }))), status).toEqual([]);
    }
  });

  it('links a pipeline to its merge request by iid', () => {
    const [event] = adapter.normalize(delivery('Pipeline Hook', pipelineHook()));
    expect(event?.payload).toMatchObject({ pullRequestNumbers: [42] });
  });

  it('leaves the link empty for a branch pipeline', () => {
    const [event] = adapter.normalize(delivery('Pipeline Hook', pipelineHook({ source: 'push' }, { merge_request: null })));
    expect(event?.payload).toMatchObject({ pullRequestNumbers: [], event: 'push' });
  });
});

describe('GitLab normalization: deployments', () => {
  it('recovers the full commit sha so the deployment can be attributed', () => {
    const [event] = adapter.normalize(delivery('Deployment Hook', deploymentHook()));
    expect(event?.type).toBe('deployment.status_changed');
    expect(event?.payload).toMatchObject({
      providerDeploymentId: '7788',
      sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
      state: 'success',
      isProduction: true,
    });
  });

  it('applies the timestamp offset rather than assuming UTC', () => {
    const [event] = adapter.normalize(delivery('Deployment Hook', deploymentHook()));
    // 12:15 +0200 is 10:15 UTC.
    expect(event?.occurredAt).toBe('2026-03-01T10:15:00.000Z');
  });

  it('prefers the declared environment tier over guessing from the name', () => {
    const tiered = adapter.normalize(delivery('Deployment Hook', deploymentHook({ environment: 'prod-eu-west', environment_tier: 'production' })));
    expect(tiered[0]?.payload).toMatchObject({ isProduction: true });

    const staging = adapter.normalize(delivery('Deployment Hook', deploymentHook({ environment: 'staging', environment_tier: 'staging' })));
    expect(staging[0]?.payload).toMatchObject({ isProduction: false });
  });

  it('maps deployment states', () => {
    const state = (status: string) =>
      (adapter.normalize(delivery('Deployment Hook', deploymentHook({ status })))[0]?.payload as { state: string }).state;
    expect(state('success')).toBe('success');
    expect(state('failed')).toBe('failure');
    expect(state('running')).toBe('in_progress');
    expect(state('canceled')).toBe('inactive');
  });

  it('ignores a deployment with no identifier', () => {
    expect(adapter.normalize(delivery('Deployment Hook', deploymentHook({ deployment_id: null, deployable_id: null })))).toEqual([]);
  });
});

describe('GitLab normalization: ignored hooks', () => {
  it('ignores hooks that are not modelled, without throwing', () => {
    for (const hook of ['Tag Push Hook', 'Issue Hook', 'Job Hook', 'Wiki Page Hook', 'Release Hook', 'Something New Hook']) {
      expect(adapter.normalize(delivery(hook, pushHook())), hook).toEqual([]);
    }
  });
});

describe('GitLab idempotency', () => {
  it('produces the same key for a redelivery', () => {
    const body = mergeRequestHook();
    const first = adapter.normalize(delivery('Merge Request Hook', body))[0];
    const second = adapter.normalize(delivery('Merge Request Hook', body))[0];
    expect(first?.idempotencyKey).toBe(second?.idempotencyKey);
  });

  it('produces different keys for different deliveries of different facts', () => {
    const opened = adapter.normalize(delivery('Merge Request Hook', mergeRequestHook()))[0];
    const merged = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook({ action: 'merge', state: 'merged' }), { headers: { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'uuid-2', 'x-gitlab-token': SECRET } }),
    )[0];
    expect(opened?.idempotencyKey).not.toBe(merged?.idempotencyKey);
  });

  it('keeps distinct events from one delivery apart', () => {
    const events = adapter.normalize(
      delivery('Merge Request Hook', mergeRequestHook({ action: 'update' }, { changes: { reviewers: { previous: [], current: [REVIEWER, USER] } } })),
    );
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(2);
  });
});
