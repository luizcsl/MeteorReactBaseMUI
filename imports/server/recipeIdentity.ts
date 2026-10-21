import { userprofileServerApi } from '../modules/userprofile/api/userProfileServerApi';
import { createMeteorOwnerIdentityAdapter } from '../core/recipes/server/meteorIdentity';
/** Composition boundary: same approved active-account/profile contract as registerApi. No role inference. */
export function ownerRecipePorts() {
	return createMeteorOwnerIdentityAdapter(userprofileServerApi.getCollectionInstance());
}
