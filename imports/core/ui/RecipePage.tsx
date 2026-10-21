import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, MenuItem, Stack, TextField, Typography } from '@mui/material';
import {
	formatMoney,
	parseMoneyText,
	parseRecipeFilters,
	validateDefinition,
	type RecipeData,
	type RecipeDefinition
} from '../recipes/definition';
import { RecipeForm } from './RecipeForm';
export interface RecipeRow {
	id: string;
	parentId: string | null;
	version: number;
	state: string;
	data: RecipeData;
}
export interface RecipeClient {
	list: (filters: RecipeData, limit: number, parentId?: string | null) => Promise<RecipeRow[]>;
	create: (data: RecipeData, parentId: string | null, mutationId: string) => Promise<RecipeRow>;
	update: (id: string, version: number, data: RecipeData) => Promise<RecipeRow>;
	transition: (id: string, version: number, to: string) => Promise<RecipeRow>;
	remove: (id: string, version: number) => Promise<unknown>;
}
interface RecipePageProps {
	definition: RecipeDefinition;
	client: RecipeClient;
	parentId?: string | null;
}
/** A scope change remounts all private UI state before it can render under a different identity. */
export function RecipePage(props: RecipePageProps) {
	const clientIdentity = useRef({ client: props.client, generation: 0 });
	if (clientIdentity.current.client !== props.client)
		clientIdentity.current = { client: props.client, generation: clientIdentity.current.generation + 1 };
	// Equivalent freshly allocated metadata must not discard edits on every parent render.
	const scopeKey = JSON.stringify([
		clientIdentity.current.generation,
		props.parentId ?? null,
		validateDefinition(props.definition)
	]);
	return <ScopedRecipePage key={scopeKey} {...props} />;
}
function ScopedRecipePage({ definition, client, parentId = null }: RecipePageProps) {
	const [rows, setRows] = useState<RecipeRow[]>([]),
		[loading, setLoading] = useState(true),
		[error, setError] = useState(''),
		[filters, setFilters] = useState<RecipeData>({}),
		[editing, setEditing] = useState<RecipeRow | null>(null),
		[busy, setBusy] = useState(false);
	const serial = useRef(0);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const currentQuery = useRef({ client, filters, parentId });
	currentQuery.current = { client, filters, parentId };
	const sameQuery = (query: typeof currentQuery.current) =>
		mounted.current &&
		query.client === currentQuery.current.client &&
		query.filters === currentQuery.current.filters &&
		query.parentId === currentQuery.current.parentId;
	const currentParent = useRef(parentId);
	currentParent.current = parentId;
	const creation = useRef<{ fingerprint: string; mutationId: string } | null>(null);
	useEffect(() => {
		setEditing(null);
		setRows([]);
		creation.current = null;
	}, [parentId]);
	const refresh = async () => {
		if (!sameQuery({ client, filters, parentId })) return;
		const query = { client, filters, parentId };
		const token = ++serial.current;
		setLoading(true);
		setError('');
		try {
			const normalized = { ...filters };
			for (const field of definition.fields)
				if (field.type === 'money' && typeof normalized[field.name] === 'string')
					normalized[field.name] = parseMoneyText(normalized[field.name] as string, field.scale!);
			const next = await client.list(parseRecipeFilters(definition, normalized), 100, parentId);
			if (token === serial.current && sameQuery(query)) setRows(next);
		} catch {
			if (token === serial.current && sameQuery(query))
				setError('Unable to load records. You may not have permission.');
		} finally {
			if (token === serial.current && sameQuery(query)) setLoading(false);
		}
	};
	useEffect(() => {
		void refresh();
		return () => {
			serial.current++;
		};
	}, [client, filters, parentId]);
	const action = async (fn: () => Promise<unknown>) => {
		if (busy) return;
		const startedParent = parentId;
		const startedQuery = currentQuery.current;
		setBusy(true);
		setError('');
		try {
			await fn();
			if (mounted.current && currentParent.current === startedParent) await refresh();
		} catch {
			if (sameQuery(startedQuery)) setError('Operation failed or record changed. Refresh and retry.');
		} finally {
			setBusy(false);
		}
	};
	return (
		<Stack spacing={3}>
			<Typography variant="h4">{definition.name}</Typography>
			{definition.filters.length > 0 && (
				<Stack direction="row" spacing={1}>
					{definition.filters.map((name) => {
						const f = definition.fields.find((f) => f.name === name)!;
						return (
							<TextField
								key={name}
								label={`Filter ${f.label}`}
								select={f.type === 'enum' || f.type === 'boolean'}
								type={f.type === 'date' ? 'date' : f.type === 'integer' ? 'number' : 'text'}
								slotProps={{ inputLabel: f.type === 'date' ? { shrink: true } : undefined }}
								value={filters[name] ?? ''}
								onChange={(e) => {
									const next = { ...filters };
									if (e.target.value === '') delete next[name];
									else
										next[name] =
											f.type === 'integer'
												? Number(e.target.value)
												: f.type === 'boolean'
													? e.target.value === 'true'
													: e.target.value;
									setFilters(next);
								}}>
								{(f.type === 'enum' || f.type === 'boolean') && [
									<MenuItem key="all" value="">
										All
									</MenuItem>,
									...(f.type === 'boolean' ? ['true', 'false'] : f.values!).map((v) => (
										<MenuItem key={v} value={v}>
											{v}
										</MenuItem>
									))
								]}
							</TextField>
						);
					})}
				</Stack>
			)}
			{error && (
				<Alert severity="error" role="alert">
					{error}
				</Alert>
			)}
			<RecipeForm
				key={`${parentId ?? ''}:${editing?.id ?? 'new'}`}
				definition={definition}
				initial={editing?.data}
				disabled={busy}
				onSubmit={async (data) => {
					const startedParent = parentId;
					setBusy(true);
					try {
						if (editing) await client.update(editing.id, editing.version, data);
						else {
							const fingerprint = JSON.stringify([data, parentId]);
							if (creation.current?.fingerprint !== fingerprint)
								creation.current = { fingerprint, mutationId: crypto.randomUUID() };
							await client.create(data, parentId, creation.current.mutationId);
							if (mounted.current && currentParent.current === startedParent) creation.current = null;
						}
						if (mounted.current && currentParent.current === startedParent) {
							setEditing(null);
							await refresh();
						}
					} finally {
						setBusy(false);
					}
				}}
			/>
			{editing && (
				<Button disabled={busy} onClick={() => setEditing(null)}>
					Cancel edit
				</Button>
			)}
			{loading ? (
				<CircularProgress aria-label="Loading records" />
			) : rows.length === 0 ? (
				<Typography>No records found.</Typography>
			) : (
				rows.map((row) => (
					<Box key={row.id} component="article" sx={{ border: 1, borderColor: 'divider', p: 2 }}>
						<Typography>
							{definition.fields
								.map(
									(f) =>
										`${f.label}: ${f.type === 'money' && typeof row.data[f.name] === 'number' ? f.currency + ' ' + formatMoney(row.data[f.name] as number, f.scale!) : String(row.data[f.name] ?? '')}`
								)
								.join(' · ')}
						</Typography>
						<Typography>State: {row.state}</Typography>
						<Button disabled={busy} onClick={() => setEditing(row)}>
							Edit
						</Button>
						<Button disabled={busy} onClick={() => void action(() => client.remove(row.id, row.version))}>
							Delete
						</Button>
						{definition.transitions
							.filter((t) => t.from === row.state)
							.map((t) => (
								<Button
									key={t.to}
									disabled={busy}
									onClick={() => void action(() => client.transition(row.id, row.version, t.to))}>
									{t.to}
								</Button>
							))}
					</Box>
				))
			)}
			<Button disabled={loading || busy} onClick={() => void refresh()}>
				Refresh
			</Button>
			<Typography variant="caption">
				Showing at most 100 records. Filters are exact-match. Server authorization applies to every action.
			</Typography>
		</Stack>
	);
}
