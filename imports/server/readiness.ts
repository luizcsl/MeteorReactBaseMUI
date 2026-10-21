// Readiness is false until every required startup step succeeds. Failed startup
// never advertises readiness merely because Mongo still answers a ping.
const required = new Set(['indexes-and-identity', 'bootstrap', 'oauth']);
const completed = new Set<string>();
export const markStartupComplete = (name: string) => {
	if (required.has(name)) completed.add(name);
};
export const isStartupComplete = () => [...required].every((name) => completed.has(name));
