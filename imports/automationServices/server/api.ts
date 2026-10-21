export type ApiSchema = {
	type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
	properties?: Record<string, ApiSchema>;
	required?: string[];
	items?: ApiSchema;
	additionalProperties?: false;
	maxLength?: number;
	maxItems?: number;
};
export interface ApiOperation {
	id: string;
	method: 'GET' | 'POST';
	path: string;
	input: ApiSchema | null;
	output: ApiSchema;
	status: number;
}
export interface ApiTransport {
	/** Approved server transport adds authentication. Must enforce timeout, size bound, no redirects,
	 * HTTPS destination allowlist and egress controls. Never return credentials in errors. */
	request(input: {
		url: string;
		method: 'GET' | 'POST';
		body: unknown;
		timeoutMs: number;
		maxBytes: number;
		redirect: 'error';
	}): Promise<{ status: number; body: unknown }>;
}
export class ExternalApiError extends Error {
	constructor(
		readonly kind: 'transport' | 'status' | 'contract',
		readonly status?: number
	) {
		super('External API ' + kind);
	}
}
export function parseApi(schema: ApiSchema, value: unknown, depth = 0): unknown {
	const fail = (): never => {
		throw new ExternalApiError('contract');
	};
	if (depth > 8) fail();
	if (schema.type === 'object') {
		if (
			!value ||
			typeof value !== 'object' ||
			Array.isArray(value) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(value))
		)
			return fail();
		const v = value as Record<string, unknown>,
			props = schema.properties ?? {};
		if (
			Reflect.ownKeys(v).some(
				(k) =>
					typeof k !== 'string' ||
					!Object.hasOwn(props, k) ||
					!Object.hasOwn(Object.getOwnPropertyDescriptor(v, k)!, 'value')
			) ||
			(schema.required ?? []).some((k) => !Object.hasOwn(v, k))
		)
			return fail();
		return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, parseApi(props[k], v, depth + 1)]));
	}
	if (schema.type === 'array') {
		if (
			!Array.isArray(value) ||
			value.length > (schema.maxItems ?? 100) ||
			Reflect.ownKeys(value).length !== value.length + 1
		)
			return fail();
		return value.map((v) => parseApi(schema.items!, v, depth + 1));
	}
	if (schema.type === 'integer') {
		if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail();
		return value;
	}
	if (
		typeof value !== schema.type ||
		(typeof value === 'number' && !Number.isFinite(value)) ||
		(typeof value === 'string' && value.length > (schema.maxLength ?? 4096))
	)
		return fail();
	return value;
}
export function externalClient(baseUrl: string, operations: ApiOperation[], transport: ApiTransport) {
	return {
		async call(operationId: string, input: unknown) {
			const op = operations.find((o) => o.id === operationId);
			if (!op) throw new ExternalApiError('contract');
			const body = op.input
				? parseApi(op.input, input)
				: input === null
					? null
					: (() => {
							throw new ExternalApiError('contract');
						})();
			let response;
			try {
				response = await transport.request({
					url: baseUrl + op.path,
					method: op.method,
					body,
					timeoutMs: 10000,
					maxBytes: 1000000,
					redirect: 'error'
				});
			} catch {
				throw new ExternalApiError('transport');
			}
			if (response.status !== op.status) throw new ExternalApiError('status', response.status);
			return parseApi(op.output, response.body);
		}
	};
}
export function mockTransport(responses: Record<string, { status: number; body: unknown }>): ApiTransport {
	return {
		async request({ url, method }) {
			const response = responses[method + ' ' + url];
			if (!response) throw new Error('No mock response');
			return structuredClone(response);
		}
	};
}
