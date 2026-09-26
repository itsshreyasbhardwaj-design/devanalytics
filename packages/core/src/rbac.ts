import { ForbiddenError } from './errors.js';

/**
 * Role-based access control.
 *
 * Roles are per-organization. There is no global superuser role in the data
 * model — cross-organization access is impossible to express, which is what
 * makes tenant isolation a property of the schema rather than of a code path
 * someone has to remember to write.
 */
export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export type Permission =
  | 'org:read'
  | 'org:manage'
  | 'repo:read'
  | 'repo:connect'
  | 'metrics:read'
  | 'investigation:read'
  | 'investigation:create'
  | 'anomaly:acknowledge'
  | 'data:export'
  | 'ai:query'
  | 'audit:read'
  | 'member:manage'
  | 'token:manage';

const GRANTS: Record<Role, Permission[]> = {
  viewer: ['org:read', 'repo:read', 'metrics:read', 'investigation:read'],
  member: [
    'org:read',
    'repo:read',
    'metrics:read',
    'investigation:read',
    'investigation:create',
    'anomaly:acknowledge',
    'data:export',
    'ai:query',
  ],
  admin: [
    'org:read',
    'org:manage',
    'repo:read',
    'repo:connect',
    'metrics:read',
    'investigation:read',
    'investigation:create',
    'anomaly:acknowledge',
    'data:export',
    'ai:query',
    'audit:read',
    'member:manage',
  ],
  owner: [
    'org:read',
    'org:manage',
    'repo:read',
    'repo:connect',
    'metrics:read',
    'investigation:read',
    'investigation:create',
    'anomaly:acknowledge',
    'data:export',
    'ai:query',
    'audit:read',
    'member:manage',
    'token:manage',
  ],
};

export interface Principal {
  userId: string;
  orgId: string;
  role: Role;
  /** Populated for API-token principals; null for interactive sessions. */
  tokenId: string | null;
}

export function permissionsFor(role: Role): readonly Permission[] {
  return GRANTS[role];
}

export function can(principal: Principal, permission: Permission): boolean {
  return GRANTS[principal.role].includes(permission);
}

export function assertCan(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) {
    throw new ForbiddenError(`Role "${principal.role}" lacks permission "${permission}"`, {
      role: principal.role,
      permission,
    });
  }
}

/** Every org-scoped read must funnel through this. */
export function assertOrgAccess(principal: Principal, orgId: string): void {
  if (principal.orgId !== orgId) {
    throw new ForbiddenError('Cross-organization access denied', {
      principalOrgId: principal.orgId,
      requestedOrgId: orgId,
    });
  }
}
