import { registerMethods, registerPublications } from '../../../api/server/registration';
import { startRecipePublication } from './publication';
import { Meteor } from 'meteor/meteor';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { ContractError } from '../../contracts/schema';
import { OperationError } from '../../contracts/errors';
import { validateDefinition, type RecipeDefinition } from '../definition';
import { recipeService, type RecipePorts } from './engine';
import { mongoRecipeRepository } from './mongo';
const registered = new Set<string>();
/** Explicit server-only registration. No client stubs or role-bearing input; publications require a trusted revocation observer. */
export function registerRecipe(raw: RecipeDefinition, ports: Omit<RecipePorts, 'repository'>): RecipePorts {
	if (!Meteor.isServer) throw new Error('Recipe registration is server-only');
	const definition = validateDefinition(raw);
	if (registered.has(definition.name)) throw new Error('Duplicate recipe registration');
	if (ports.observeIdentity && definition.profile === 'master-detail' && !ports.observeDependencies)
		throw new Error('Reactive master/detail requires a parent dependency observer');
	const baseRepository = mongoRecipeRepository(`recipe_${definition.name}`);
	const repository = ports.configureRepository ? ports.configureRepository(baseRepository) : baseRepository;
	const servicePorts: RecipePorts = { ...ports, repository };
	const service = recipeService(definition, servicePorts);
	for (const operation of ['list', 'create', 'update', 'transition', 'remove'] as const) {
		const name = `${definition.name}.${operation}`;
		registerMethods({
			[name]: async function (...args: unknown[]) {
				try {
					if (args.length !== 1) throw new OperationError('invalid-input');
					return await service[operation](this.userId, args[0]);
				} catch (error) {
					if (error instanceof OperationError || error instanceof ContractError)
						throw new Meteor.Error(error.code, error.code);
					throw new Meteor.Error('internal-error', 'Operation failed');
				}
			}
		});
		DDPRateLimiter.addRule({ type: 'method', name, connectionId: () => true }, 60, 60_000);
		DDPRateLimiter.addRule({ type: 'method', name, userId: (value: string | null) => !!value }, 120, 60_000);
	}
	if (ports.observeIdentity) {
		registerPublications({
			[`${definition.name}.records`]: function (...args: unknown[]) {
				if (args.length !== 1) throw new Meteor.Error('invalid-input');
				return startRecipePublication(this, `recipe_view_${definition.name}`, service, args[0], {
					observeIdentity: ports.observeIdentity!,
					observeRecords: repository.observeChanges!,
					observeDependencies: ports.observeDependencies,
					error: () => new Meteor.Error('forbidden', 'Subscription no longer authorized')
				});
			}
		});
		DDPRateLimiter.addRule(
			{ type: 'subscription', name: `${definition.name}.records`, connectionId: () => true },
			30,
			60_000
		);
	}
	registered.add(definition.name);
	return servicePorts;
}
