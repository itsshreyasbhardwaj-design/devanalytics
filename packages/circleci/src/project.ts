import type { Provider } from '@devanalytics/core';

/**
 * Resolving which repository a CircleCI event is about.
 *
 * CircleCI is CI-only. It builds repositories it does not host, and it
 * identifies them two ways: a project slug of the form
 * `<vcs>/<org>/<repo>`, and a repository URL under `pipeline.vcs`. Neither
 * contains the code host's numeric repository id, so events resolve by host
 * and full name.
 */

export interface RepositoryRef {
  hostProvider: Provider;
  /** "acme/api" — the path the code host and a human both use. */
  fullName: string;
}

const VCS_PROVIDERS: Record<string, Provider | null> = {
  github: 'github',
  gh: 'github',
  gitlab: 'gitlab',
  gl: 'gitlab',
  // CircleCI also builds Bitbucket, which this platform does not model. Such
  // events are ignored rather than attributed to the wrong host.
  bitbucket: null,
  bb: null,
  circleci: null,
};

export function providerFromVcs(name: string | null | undefined): Provider | null {
  if (!name) return null;
  return VCS_PROVIDERS[name.trim().toLowerCase()] ?? null;
}

/**
 * Parse a project slug.
 *
 * CircleCI slugs are `gh/acme/api` on the classic platform and
 * `circleci/<org-id>/<project-id>` on the newer one. Only the former carries
 * the repository path; the latter identifies CircleCI's own entities and is
 * useless for resolution, so it is rejected rather than guessed at.
 */
export function refFromSlug(slug: string | null | undefined): RepositoryRef | null {
  if (!slug) return null;
  const parts = slug.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const hostProvider = providerFromVcs(parts[0]);
  if (!hostProvider) return null;
  return { hostProvider, fullName: parts.slice(1).join('/') };
}

/**
 * Parse a repository URL, e.g. https://github.com/acme/api.
 *
 * Preferred over the slug when both are present: a self-managed GitLab lives
 * on its own host, and the URL is what says so.
 */
export function refFromRepositoryUrl(url: string | null | undefined, vcsName?: string | null): RepositoryRef | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!path.includes('/')) return null;

  const fromName = providerFromVcs(vcsName);
  const fromHost = /(^|\.)github\.com$/i.test(parsed.hostname)
    ? 'github'
    : /(^|\.)gitlab\.com$/i.test(parsed.hostname)
      ? 'gitlab'
      : null;

  const hostProvider = fromName ?? fromHost;
  if (!hostProvider) return null;
  return { hostProvider, fullName: path };
}

/** Best available reference, preferring the URL and falling back to the slug. */
export function resolveRepositoryRef(input: {
  repositoryUrl?: string | null;
  vcsName?: string | null;
  projectSlug?: string | null;
}): RepositoryRef | null {
  return (
    refFromRepositoryUrl(input.repositoryUrl, input.vcsName) ??
    refFromSlug(input.projectSlug) ??
    null
  );
}
