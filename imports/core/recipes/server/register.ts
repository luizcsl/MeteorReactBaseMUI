import { Meteor } from 'meteor/meteor';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { ContractError } from '../../contracts/schema';
import { OperationError } from '../../contracts/errors';
import { validateDefinition, type RecipeDefinition } from '../definition';
import { recipeService, type RecipePorts } from './engine';
import { mongoRecipeRepository } from './mongo';
const registered = new Set<string>();
/** Explicit server-only registration. No client stubs, publications or role-bearing input. */
export function registerRecipe(raw: RecipeDefinition, ports: Omit<RecipePorts, 'repository'>): void {
	if (!Meteor.isServer) throw new Error('Recipe registration is server-only');
	const definition = validateDefinition(raw);
	if (registered.has(definition.name)) throw new Error('Duplicate recipe registration');
	const service = recipeService(definition, {
		...ports,
		repository: mongoRecipeRepository(`recipe_${definition.name}`)
	});
	for (const operation of ['list', 'create', 'update', 'transition', 'remove'] as const) {
		const name = `${definition.name}.${operation}`;
		Meteor.methods({
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
	registered.add(definition.name);
}
