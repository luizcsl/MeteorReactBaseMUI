import { Meteor } from 'meteor/meteor';
export type MethodHandler = (this: Meteor.MethodThisType, ...args: any[]) => any;
/** Shared transport registration only. The supplied handler still owns its explicit authorization contract. */
export function registerMethods(methods: Record<string, MethodHandler>): void {
	if (!Meteor.isServer) throw new Error('Server registration imported on client');
	Meteor.methods(methods);
}
export function registerPublications(publications: Record<string, (this: any, ...args: any[]) => any>): void {
	if (!Meteor.isServer) throw new Error('Server registration imported on client');
	for (const [name, handler] of Object.entries(publications)) Meteor.publish(name, handler);
}
