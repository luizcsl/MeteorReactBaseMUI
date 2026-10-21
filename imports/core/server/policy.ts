import { OperationError, type TrustedContext } from './operations';
export type Role = 'viewer' | 'editor' | 'admin';
export interface Membership { userId: string; tenantId: string; role: Role; active: boolean }
export type MembershipLookup = (userId: string, tenantId: string) => Promise<Membership | null>;
export type Scope = { kind: 'owner'; ownerId: string } | { kind: 'tenant'; tenantId: string };
export const ownerScope = (ctx: TrustedContext): Scope => {
  if (!ctx.userId) throw new OperationError('unauthenticated');
  return { kind: 'owner', ownerId: ctx.userId };
};
/** Tenant IDs are selection, not authority. Membership is re-read for each request. */
export async function tenantScope(ctx: TrustedContext, tenantId: string, allowedRoles: readonly Role[], lookup: MembershipLookup): Promise<Scope> {
  if (!ctx.userId) throw new OperationError('unauthenticated');
  const membership = await lookup(ctx.userId, tenantId);
  if (!membership || !membership.active || membership.userId !== ctx.userId || membership.tenantId !== tenantId || !allowedRoles.includes(membership.role)) throw new OperationError('forbidden');
  return { kind: 'tenant', tenantId };
}
export function scopeSelector(scope: Scope): { ownerId: string; tenantId: null } | { tenantId: string } {
  if (scope.kind === 'owner' && scope.ownerId) return { ownerId: scope.ownerId, tenantId: null };
  if (scope.kind === 'tenant' && scope.tenantId) return { tenantId: scope.tenantId };
  throw new OperationError('forbidden');
}
