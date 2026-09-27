import { describe, it, expect } from 'vitest';
import { providerFromVcs, refFromRepositoryUrl, refFromSlug, resolveRepositoryRef } from '@devanalytics/circleci';

describe('CircleCI repository resolution', () => {
  it('maps CircleCI VCS names to code hosts', () => {
    expect(providerFromVcs('github')).toBe('github');
    expect(providerFromVcs('GitHub')).toBe('github');
    expect(providerFromVcs('gh')).toBe('github');
    expect(providerFromVcs('gitlab')).toBe('gitlab');
    expect(providerFromVcs('gl')).toBe('gitlab');
  });

  it('refuses hosts this platform does not model, rather than guessing', () => {
    // Attributing a Bitbucket repository to GitHub would file its CI runs
    // against a repository that is not the one being built.
    expect(providerFromVcs('bitbucket')).toBeNull();
    expect(providerFromVcs('bb')).toBeNull();
    expect(providerFromVcs('something-new')).toBeNull();
    expect(providerFromVcs(null)).toBeNull();
  });

  it('parses a classic project slug', () => {
    expect(refFromSlug('gh/acme/api')).toEqual({ hostProvider: 'github', fullName: 'acme/api' });
    expect(refFromSlug('github/acme/api')).toEqual({ hostProvider: 'github', fullName: 'acme/api' });
    expect(refFromSlug('gitlab/acme/group/api')).toEqual({ hostProvider: 'gitlab', fullName: 'acme/group/api' });
  });

  it('rejects the newer opaque slug, which identifies CircleCI entities not a repository', () => {
    // "circleci/<org-uuid>/<project-uuid>" carries no repository path.
    expect(refFromSlug('circleci/4b2b6b1a-0000-0000-0000-000000000000/f0f0')).toBeNull();
    expect(refFromSlug('gh/acme')).toBeNull();
    expect(refFromSlug(null)).toBeNull();
  });

  it('parses a repository URL and strips the git suffix', () => {
    expect(refFromRepositoryUrl('https://github.com/acme/api')).toEqual({ hostProvider: 'github', fullName: 'acme/api' });
    expect(refFromRepositoryUrl('https://github.com/acme/api.git')).toEqual({ hostProvider: 'github', fullName: 'acme/api' });
    expect(refFromRepositoryUrl('https://gitlab.com/acme/group/api/')).toEqual({ hostProvider: 'gitlab', fullName: 'acme/group/api' });
  });

  it('uses the declared VCS name for a self-managed host the URL cannot identify', () => {
    // A self-managed GitLab lives on its own domain, so the hostname says
    // nothing; CircleCI's provider_name does.
    expect(refFromRepositoryUrl('https://git.internal.example.com/acme/api', 'gitlab')).toEqual({
      hostProvider: 'gitlab', fullName: 'acme/api',
    });
    expect(refFromRepositoryUrl('https://git.internal.example.com/acme/api')).toBeNull();
  });

  it('prefers the URL over the slug, because only the URL identifies a self-managed host', () => {
    expect(resolveRepositoryRef({
      repositoryUrl: 'https://gitlab.com/acme/api',
      vcsName: 'gitlab',
      projectSlug: 'gh/other/repo',
    })).toEqual({ hostProvider: 'gitlab', fullName: 'acme/api' });
  });

  it('falls back to the slug when there is no usable URL', () => {
    expect(resolveRepositoryRef({ repositoryUrl: null, projectSlug: 'gh/acme/api' })).toEqual({
      hostProvider: 'github', fullName: 'acme/api',
    });
    expect(resolveRepositoryRef({ repositoryUrl: 'not-a-url', projectSlug: 'gh/acme/api' })).toEqual({
      hostProvider: 'github', fullName: 'acme/api',
    });
  });

  it('returns nothing when neither source identifies a repository', () => {
    expect(resolveRepositoryRef({ repositoryUrl: 'https://bitbucket.org/acme/api', projectSlug: 'bb/acme/api' })).toBeNull();
    expect(resolveRepositoryRef({})).toBeNull();
  });
});
