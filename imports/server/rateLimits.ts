import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';

const perMinute = Number(process.env.DDP_METHODS_PER_MINUTE || 120);
const publicationsPerMinute = Number(process.env.DDP_SUBSCRIPTIONS_PER_MINUTE || 120);
const emailAttempts = Number(process.env.EMAIL_METHOD_RATE_LIMIT_MAX || 5);
const emailWindowMs = Number(process.env.EMAIL_METHOD_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);

// A matcher callback includes the actual matched value in Meteor's bucket key.
// Separate identity rules survive reconnection; connection rules cover anonymous calls.
export const addScopedRateLimit = (matcher: Record<string, unknown>, limit: number, windowMs: number) => {
	const connectionRule = DDPRateLimiter.addRule(
		{ ...matcher, connectionId: (id: string | null) => Boolean(id) },
		limit,
		windowMs
	);
	const identityRule = DDPRateLimiter.addRule(
		{ ...matcher, userId: (id: string | null) => Boolean(id) },
		limit,
		windowMs
	);
	return [connectionRule, identityRule];
};
addScopedRateLimit({ type: 'method', name: (name: string) => !name.startsWith('/') }, perMinute, 60_000);
addScopedRateLimit({ type: 'subscription', name: () => true }, publicationsPerMinute, 60_000);
addScopedRateLimit(
	{
		type: 'method',
		name: (name: string) => ['userprofile.sendVerificationEmail', 'userprofile.sendResetPasswordEmail'].includes(name)
	},
	emailAttempts,
	emailWindowMs
);
addScopedRateLimit({ type: 'method', name: 'RemoveFile' }, 20, 60_000);
// Global emergency protection is deliberately a separate, much larger budget.
DDPRateLimiter.addRule({ type: 'method' }, Number(process.env.DDP_GLOBAL_METHODS_PER_MINUTE || 10000), 60_000);
