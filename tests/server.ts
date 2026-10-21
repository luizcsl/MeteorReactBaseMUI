import './main';
import './security-legacy';
import './security-media.tests';
import '../imports/modules/tasks/tests/policy.test';

if (process.env.TEST_TRANSACTIONS === '1') {
	require('./transactions.server');
} else {
	console.info('Transaction port: NOT QUALIFIED in this run. Use npm run test:transactions against a replica set.');
}

import './profile-publication.server';

import './recipes.server';

import '../imports/integration/server/tests';

import './requests.server';
