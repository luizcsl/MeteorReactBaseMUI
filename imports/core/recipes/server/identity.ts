import { OperationError } from '../../contracts/errors';
import type { RecipeIdentity, RecipePorts } from './engine';
type Observer = { stop(): void | Promise<void> };
export interface IdentitySource {
	isActiveAccount(accountId: string): Promise<boolean>;
	/** Must observe EVERY account/profile/membership/policy change used by these lookups. */
	observe(accountId: string, invalidate: () => void): Promise<Observer>;
}
/** Explicit server-approved source contract. No inferred role mapping and no email matching. */
export function createOwnerIdentityAdapter(source: IdentitySource): Pick<RecipePorts, 'resolveIdentity' | 'observeIdentity'> {
	return {
		async resolveIdentity(userId) {
			if (!await source.isActiveAccount(userId)) throw new OperationError('forbidden');
			return { userId, roles: [] };
		},
		observeIdentity: (userId, invalidate) => source.observe(userId, invalidate)
	};
}
export interface TenantIdentitySource extends IdentitySource {
	/** Returns one explicitly selected, currently active membership, never a request-supplied tenant. */
	membership(accountId: string): Promise<{ tenantId: string; roles: RecipeIdentity['roles'] } | null>;
}
export function createTenantIdentityAdapter(source: TenantIdentitySource): Pick<RecipePorts, 'resolveIdentity' | 'observeIdentity'> {
	return {
		async resolveIdentity(userId) {
			if (!await source.isActiveAccount(userId)) throw new OperationError('forbidden');
			const membership = await source.membership(userId);
			if (!membership || !/^[A-Za-z0-9_-]{1,128}$/.test(membership.tenantId) || !Array.isArray(membership.roles) ||
				membership.roles.some((role) => !['member', 'reviewer'].includes(role))) throw new OperationError('forbidden');
			return { userId, tenantId: membership.tenantId, roles: [...membership.roles] };
		},
		observeIdentity: (userId, invalidate) => source.observe(userId, invalidate)
	};
}
