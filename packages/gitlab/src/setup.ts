import type { Provider } from '@devanalytics/core';

/**
 * Connecting a GitLab project.
 *
 * Webhook endpoint creation is provider-neutral and lives in
 * `@devanalytics/github`'s `createWebhookEndpoint`, which takes the provider as
 * a parameter; this module supplies only the GitLab-specific configuration.
 */

/** Hooks a connected project must enable. Names match GitLab's project webhook settings. */
export const REQUIRED_GITLAB_EVENTS = [
  'push_events',
  'merge_requests_events',
  'note_events',
  'pipeline_events',
  'deployment_events',
] as const;

export interface GitLabWebhookConfig {
  url: string;
  token: string;
  push_events: boolean;
  merge_requests_events: boolean;
  note_events: boolean;
  pipeline_events: boolean;
  deployment_events: boolean;
  job_events: boolean;
  issues_events: boolean;
  tag_push_events: boolean;
  enable_ssl_verification: boolean;
}

/**
 * The body for `POST /projects/:id/hooks`.
 *
 * `enable_ssl_verification` is not optional in practice: GitLab authenticates
 * with a bearer token rather than a body signature, so TLS is the only thing
 * preventing the secret being read off the wire.
 */
export function gitlabWebhookConfig(input: { url: string; secret: string }): GitLabWebhookConfig {
  return {
    url: input.url,
    token: input.secret,
    push_events: true,
    merge_requests_events: true,
    note_events: true,
    pipeline_events: true,
    deployment_events: true,
    // Per-job hooks would duplicate pipeline-level runs; only the pipeline is modelled.
    job_events: false,
    issues_events: false,
    tag_push_events: false,
    enable_ssl_verification: true,
  };
}

export const GITLAB_PROVIDER: Provider = 'gitlab';
