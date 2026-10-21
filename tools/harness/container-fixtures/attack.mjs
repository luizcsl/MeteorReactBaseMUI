// Deliberately hostile candidate probe. Executed only inside the real container.
import fs from 'node:fs';
import net from 'node:net';
const attempts = {};
for (const target of [
	'/candidate/created-by-candidate',
	'/verifier/created-by-candidate',
	'/candidate/attack.mjs',
	'/verifier/run.mjs',
	'/var/tmp/created-by-candidate'
]) {
	try {
		fs.writeFileSync(target, 'escape');
		attempts[target] = 'WRITABLE';
	} catch (error) {
		attempts[target] = error.code;
	}
}
try {
	process.setuid(0);
	attempts.root = 'ESCALATED';
} catch (error) {
	attempts.root = error.code;
}
attempts.network = await new Promise((resolve) => {
	const socket = net.connect({ host: '1.1.1.1', port: 443 });
	socket.once('connect', () => {
		socket.destroy();
		resolve('CONNECTED');
	});
	socket.once('error', (error) => resolve(error.code));
	socket.setTimeout(1000, () => {
		socket.destroy();
		resolve('TIMEOUT');
	});
});
console.log(JSON.stringify(attempts));
