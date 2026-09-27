import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { CircleCiWebhookAdapter } from '@devanalytics/circleci';
import type { RawWebhookDelivery } from '@devanalytics/core';
import { jobCompleted, workflowCompleted } from '../helpers/circleci-payloads.js';

const adapter = new CircleCiWebhookAdapter();
const SECRET = 'circleci-signing-secret';
const RECEIVED_AT = '2026-03-02T00:00:00.000Z';

function sign(body: string, secret = SECRET): string {
  return `v1=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function delivery(payload: unknown, overrides: Partial<RawWebhookDelivery> = {}): RawWebhookDelivery {
  const body = JSON.stringify(payload);
  return {
    provider: 'circleci',
    body,
    headers: {
      'circleci-event-type': (payload as { type?: string }).type ?? 'workflow-completed',
      'circleci-signature': sign(body),
    },
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe('CircleCI signature verification', () => {
  it('accepts a correctly signed body', () => {
    expect(adapter.verifySignature(delivery(workflowCompleted()), SECRET)).toEqual({ valid: true });
  });

  it('rejects a body altered after signing', () => {
    const d = delivery(workflowCompleted());
    d.body = d.body.replace('"success"', '"failed"');
    expect(adapter.verifySignature(d, SECRET)).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects a signature made with a different secret', () => {
    const d = delivery(workflowCompleted());
    d.headers['circleci-signature'] = sign(d.body, 'other-secret');
    expect(adapter.verifySignature(d, SECRET)).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('accepts a header carrying several versioned signatures', () => {
    // CircleCI may rotate secrets and send both.
    const d = delivery(workflowCompleted());
    d.headers['circleci-signature'] = `v1=${'0'.repeat(64)},${sign(d.body)}`;
    expect(adapter.verifySignature(d, SECRET)).toEqual({ valid: true });
  });

  it('rejects an unsupported signature version', () => {
    const d = delivery(workflowCompleted());
    d.headers['circleci-signature'] = 'v2=deadbeef';
    expect(adapter.verifySignature(d, SECRET)).toEqual({ valid: false, reason: 'algorithm_unsupported' });
  });

  it('distinguishes a missing signature from a missing secret', () => {
    const d = delivery(workflowCompleted());
    delete d.headers['circleci-signature'];
    expect(adapter.verifySignature(d, SECRET)).toEqual({ valid: false, reason: 'missing_signature' });
    expect(adapter.verifySignature(delivery(workflowCompleted()), '')).toEqual({ valid: false, reason: 'missing_secret' });
  });

  it('takes the delivery id from the body, where CircleCI puts it', () => {
    expect(adapter.deliveryId(delivery(workflowCompleted()))).toBe('3888f21b-0000-4000-8000-000000000001');
    expect(adapter.deliveryId({ provider: 'circleci', body: 'not json', headers: {}, receivedAt: RECEIVED_AT })).toBeNull();
  });
});

describe('CircleCI normalization', () => {
  it('maps a completed workflow to a completed run', () => {
    const [event] = adapter.normalize(delivery(workflowCompleted()));
    expect(event?.type).toBe('workflow_run.completed');
    expect(event?.payload).toMatchObject({
      providerRunId: 'wf-0000-0001',
      status: 'completed',
      conclusion: 'success',
      headSha: 'abc1560886d4f094c3e6c9ef40349f7d38b5d27d',
      headBranch: 'feature/rate-limit',
      event: 'webhook',
      runAttempt: 1,
    });
  });

  it('points the event at the code host repository, not a CircleCI one', () => {
    const [event] = adapter.normalize(delivery(workflowCompleted()));
    expect(event?.provider).toBe('circleci');
    // The repository belongs to GitHub, and the descriptor says so.
    expect(event?.repository).toMatchObject({
      provider: 'github',
      fullName: 'acme/api',
      isReference: true,
    });
    expect(event?.orgSlug).toBe('acme');
  });

  it('reports no enqueue time, because CircleCI does not measure one', () => {
    const [event] = adapter.normalize(delivery(workflowCompleted()));
    const payload = event?.payload as Record<string, unknown>;
    expect(payload.enqueuedAt).toBeNull();
    // Duration is still measurable: the workflow ran from 10:01:30 to 10:07.
    expect(payload.startedAt).toBe('2026-03-01T10:01:30.000Z');
    expect(payload.completedAt).toBe('2026-03-01T10:07:00.000Z');
    // And the pipeline's creation is still the run's time anchor.
    expect(payload.createdAt).toBe('2026-03-01T10:00:00.000Z');
  });

  it('uses the workflow name as the workflow identity', () => {
    const [event] = adapter.normalize(delivery(workflowCompleted()));
    expect(event?.payload).toMatchObject({
      workflow: { providerWorkflowId: 'build-and-test', name: 'build-and-test', path: '.circleci/config.yml' },
    });
  });

  it('carries no actor rather than inventing one from a display name', () => {
    const [event] = adapter.normalize(delivery(workflowCompleted()));
    // The payload has a commit author name and email but no host user id.
    expect(event?.actor).toBeNull();
  });

  it('reports no pull request number, leaving the link to the commit', () => {
    const [event] = adapter.normalize(delivery(workflowCompleted()));
    expect(event?.payload).toMatchObject({ pullRequestNumbers: [] });
  });

  it('maps failure, cancellation and authorization outcomes', () => {
    const conclusion = (status: string) => {
      const payload = workflowCompleted();
      (payload.workflow as Record<string, unknown>).status = status;
      return (adapter.normalize(delivery(payload))[0]?.payload as { conclusion: string }).conclusion;
    };
    expect(conclusion('failed')).toBe('failure');
    expect(conclusion('error')).toBe('failure');
    expect(conclusion('failing')).toBe('failure');
    expect(conclusion('canceled')).toBe('cancelled');
    expect(conclusion('unauthorized')).toBe('action_required');
  });

  it('maps a running workflow to a started run', () => {
    const payload = workflowCompleted();
    (payload.workflow as Record<string, unknown>).status = 'running';
    (payload.workflow as Record<string, unknown>).stopped_at = null;
    const [event] = adapter.normalize(delivery(payload));
    expect(event?.type).toBe('workflow_run.started');
    expect(event?.payload).toMatchObject({ status: 'in_progress', conclusion: null, completedAt: null });
  });

  it('ignores statuses that describe neither a run nor an outcome', () => {
    for (const status of ['on_hold', 'not_run', 'queued']) {
      const payload = workflowCompleted();
      (payload.workflow as Record<string, unknown>).status = status;
      expect(adapter.normalize(delivery(payload)), status).toEqual([]);
    }
  });

  it('ignores job events, which are the stages inside a workflow', () => {
    // Ingesting jobs would count every run-derived metric once per stage.
    expect(adapter.normalize(delivery(jobCompleted()))).toEqual([]);
  });

  it('ignores a ping', () => {
    expect(adapter.normalize(delivery({ type: 'ping', id: 'p1' }))).toEqual([]);
  });

  it('ignores a repository on a host this platform does not model', () => {
    const payload = workflowCompleted();
    (payload.project as Record<string, unknown>).slug = 'bb/acme/api';
    ((payload.pipeline as Record<string, unknown>).vcs as Record<string, unknown>).provider_name = 'bitbucket';
    ((payload.pipeline as Record<string, unknown>).vcs as Record<string, unknown>).target_repository_url = 'https://bitbucket.org/acme/api';
    expect(adapter.normalize(delivery(payload))).toEqual([]);
  });

  it('resolves a self-managed GitLab project from its declared VCS name', () => {
    const payload = workflowCompleted();
    (payload.project as Record<string, unknown>).slug = 'circleci/org-uuid/project-uuid';
    ((payload.pipeline as Record<string, unknown>).vcs as Record<string, unknown>).provider_name = 'gitlab';
    ((payload.pipeline as Record<string, unknown>).vcs as Record<string, unknown>).target_repository_url = 'https://git.internal.example.com/acme/platform/api';
    const [event] = adapter.normalize(delivery(payload));
    expect(event?.repository).toMatchObject({ provider: 'gitlab', fullName: 'acme/platform/api' });
  });

  it('records a tag build with a ref rather than a bare branch', () => {
    const payload = workflowCompleted();
    const vcs = (payload.pipeline as Record<string, unknown>).vcs as Record<string, unknown>;
    delete vcs.branch;
    vcs.tag = 'v2.1.0';
    const [event] = adapter.normalize(delivery(payload));
    expect(event?.payload).toMatchObject({ headBranch: 'refs/tags/v2.1.0' });
  });

  it('throws on an unparseable body or a missing type', () => {
    expect(() => adapter.normalize({ provider: 'circleci', body: 'nope', headers: {}, receivedAt: RECEIVED_AT })).toThrow(/valid JSON/);
    expect(() => adapter.normalize({ provider: 'circleci', body: '{}', headers: {}, receivedAt: RECEIVED_AT })).toThrow(/event type/);
  });

  it('collapses a redelivery of the same event', () => {
    const payload = workflowCompleted();
    const first = adapter.normalize(delivery(payload))[0];
    const second = adapter.normalize(delivery(payload))[0];
    expect(first?.idempotencyKey).toBe(second?.idempotencyKey);
  });
});
