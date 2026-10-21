const positiveIntegerVariables = [
	'MAX_PUBLICATION_LIMIT',
	'MAX_COUNTER_LIMIT',
	'MAX_EXPORT_LIMIT',
	'MAX_THUMBNAIL_DIMENSION',
	'MAX_UPLOAD_BYTES',
	'DDP_METHODS_PER_MINUTE',
	'DDP_SUBSCRIPTIONS_PER_MINUTE',
	'DDP_GLOBAL_METHODS_PER_MINUTE',
	'EMAIL_METHOD_RATE_LIMIT_MAX',
	'EMAIL_METHOD_RATE_LIMIT_WINDOW_MS',
	'SOCIAL_IMAGE_MAX_BYTES',
	'SOCIAL_IMAGE_TIMEOUT_MS',
	'OAUTH_HTTP_TIMEOUT_MS'
];

const assertUrl = (name: string, value: string | undefined, protocols: string[]) => {
	if (!value) return;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${name} deve ser uma URL válida.`);
	}
	if (!protocols.includes(parsed.protocol)) throw new Error(`${name} usa um protocolo não permitido.`);
};

export const validateEnvironment = () => {
	for (const name of positiveIntegerVariables) {
		const value = process.env[name];
		if (value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
			throw new Error(`${name} deve ser um inteiro positivo.`);
		}
	}

	if (process.env.JSON_BODY_LIMIT !== undefined && !/^[1-9]\d*(?:b|kb|mb)?$/i.test(process.env.JSON_BODY_LIMIT))
		throw new Error('JSON_BODY_LIMIT deve ser um limite positivo em b, kb ou mb.');
	assertUrl('ROOT_URL', process.env.ROOT_URL, ['http:', 'https:']);
	assertUrl('MONGO_URL', process.env.MONGO_URL, ['mongodb:', 'mongodb+srv:']);
	for (const origin of (process.env.CORS_ORIGINS || '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)) {
		if (origin !== '*') assertUrl('CORS_ORIGINS', origin, ['http:', 'https:']);
	}
	const requireTogether = (names: string[]) => {
		const supplied = names.filter((name) => Boolean(process.env[name])).length;
		if (supplied > 0 && supplied < names.length) throw new Error(`Defina ${names.join(', ')} em conjunto.`);
	};
	requireTogether(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
	requireTogether(['FACEBOOK_APP_ID', 'FACEBOOK_SECRET']);
	requireTogether(['MAIL_URL_SMTP', 'MAIL_NO_REPLY', 'MAIL_SYSTEM']);

	if (process.env.DISABLE_MEDIA_TOKEN === 'true')
		throw new Error('DISABLE_MEDIA_TOKEN não é suportado; mídia privada exige autorização.');
	if (process.env.NODE_ENV === 'production') {
		if (!process.env.ROOT_URL || !process.env.MONGO_URL)
			throw new Error('ROOT_URL e MONGO_URL são obrigatórias em produção.');
		if (process.env.CORS_ORIGINS?.split(',').includes('*'))
			throw new Error('CORS_ORIGINS não pode usar * em produção.');
		if (!process.env.MEDIA_SIGNING_KEY || process.env.MEDIA_SIGNING_KEY.length < 48) {
			throw new Error(
				'MEDIA_SIGNING_KEY com ao menos 48 caracteres é obrigatório em produção; não é um token de acesso.'
			);
		}
	}
};

validateEnvironment();
