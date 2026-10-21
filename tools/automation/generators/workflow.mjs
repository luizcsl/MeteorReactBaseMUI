import path from 'node:path';
import { buildSync } from 'esbuild';
import { validateDefinition } from '../../recipes.mjs';

// Execute the actual typed runtime validator, not a second implementation of the DSL.
const compiled = buildSync({
	entryPoints: [path.resolve(import.meta.dirname, '../../../imports/core/recipes/server/workflow.ts')],
	bundle: true,
	platform: 'node',
	format: 'esm',
	write: false
});
const runtime = await import(
	'data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
export const validateWorkflow = runtime.validateWorkflowConfig;

export function renderWorkflow({ definition, workflow }) {
	const d = validateDefinition(definition),
		config = validateWorkflow(workflow, d);
	return {
		[`imports/modules/${d.name}/generated/workflow/server/index.ts`]: `// Generated bounded workflow. Server composition only; never registers an independent transport or timer.
import { definition } from '../../definition';
import type { RecipePorts } from '../../../../../core/recipes/server/engine';
import { createWorkflowGuard, workflowStatus, type WorkflowConfig } from '../../../../../core/recipes/server/workflow';
const workflowConfig: WorkflowConfig = ${JSON.stringify(config, null, 2)};
const guard = createWorkflowGuard(definition, workflowConfig);
export function createWorkflowPorts<P extends Omit<RecipePorts, 'repository'>>(basePorts: P): P & { beforeTransition: NonNullable<RecipePorts['beforeTransition']> } {
 const previous = basePorts.beforeTransition;
 const beforeTransition: NonNullable<RecipePorts['beforeTransition']> = async context => {
  await guard(context);
  if (previous) await previous(context);
 };
 return { ...basePorts, beforeTransition };
}
// Requires an already authorized server-side row and trusted server time. No remote method is exposed.
export const getWorkflowStatus = (row: Parameters<typeof workflowStatus>[2], now: Date) => workflowStatus(definition, workflowConfig, row, now);
`
	};
}
