import React, { useContext, useEffect, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import AuthContext from '../../../app/authProvider/authContext';
import { formatMoney, parseMoneyText } from '../../../core/recipes/definition';
import { REQUEST_METHODS, requestDto, requestPage, type RequestDto } from '../contracts';
const states = { draft: 'Rascunho', submitted: 'Enviada', approved: 'Aprovada', rejected: 'Rejeitada' };
const actions = {
	created: 'Criada',
	'item-added': 'Item adicionado',
	submitted: 'Enviada',
	approved: 'Aprovada',
	rejected: 'Rejeitada'
};
export default function RequestsPage() {
	const { isLoggedIn, userLoading, user } = useContext(AuthContext);
	// Remount the entire private subtree synchronously when identity changes.
	if (userLoading) return <CircularProgress aria-label="Carregando sessão" />;
	if (!isLoggedIn) return <Alert severity="info">Entre para acessar as solicitações.</Alert>;
	return <RequestWorkspace key={user?._id} />;
}
function RequestWorkspace() {
	const [rows, setRows] = useState<RequestDto[]>([]),
		[selected, setSelected] = useState<RequestDto | null>(null);
	const [title, setTitle] = useState(''),
		[description, setDescription] = useState(''),
		[quantity, setQuantity] = useState('1'),
		[price, setPrice] = useState('');
	const [busy, setBusy] = useState(false),
		[loading, setLoading] = useState(true),
		[error, setError] = useState('');
	const alive = useRef(true),
		serial = useRef(0),
		pendingCreate = useRef<{ title: string; mutationId: string } | null>(null),
		inFlight = useRef(false);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => {
			alive.current = false;
			serial.current++;
		};
	}, []);
	async function load() {
		const token = ++serial.current;
		setLoading(true);
		try {
			if (!Meteor.status().connected) throw new Error('offline');
			const next = requestPage.parse(await Meteor.callAsync(REQUEST_METHODS.list, { limit: 100 }));
			if (alive.current && token === serial.current) {
				setRows(next);
				setSelected((current) => (current ? (next.find((row) => row.id === current.id) ?? null) : null));
			}
		} catch {
			if (alive.current && token === serial.current)
				setError('Não foi possível carregar as solicitações. Verifique sua conexão e seu acesso.');
		} finally {
			if (alive.current && token === serial.current) setLoading(false);
		}
	}
	async function mutate(method: string, input: unknown) {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError('');
		try {
			if (!Meteor.status().connected) throw new Error('offline');
			const next = requestDto.parse(await Meteor.callAsync(method, input));
			if (!alive.current) return;
			setSelected(next);
			setDescription('');
			setPrice('');
			if (method === REQUEST_METHODS.create) {
				pendingCreate.current = null;
				setTitle('');
			}
			await load();
		} catch (failure) {
			if (alive.current)
				setError(
					(failure as { error?: string }).error === 'conflict'
						? 'A solicitação mudou. Atualize antes de tentar novamente.'
						: 'Não foi possível concluir. Verifique os dados e a atribuição de aprovador com o administrador.'
				);
		} finally {
			inFlight.current = false;
			if (alive.current) setBusy(false);
		}
	}
	function create(event: React.FormEvent) {
		event.preventDefault();
		if (pendingCreate.current?.title !== title.trim())
			pendingCreate.current = { title: title.trim(), mutationId: crypto.randomUUID() };
		void mutate(REQUEST_METHODS.create, pendingCreate.current);
	}
	function addItem(event: React.FormEvent) {
		event.preventDefault();
		if (!selected) return;
		try {
			const unitPrice = parseMoneyText(price, 2);
			void mutate(REQUEST_METHODS.addItem, {
				id: selected.id,
				version: selected.version,
				item: { description, quantity: Number(quantity), unitPrice }
			});
		} catch {
			setError('Informe um valor em BRL com no máximo duas casas decimais.');
		}
	}
	return (
		<Box sx={{ p: 3, maxWidth: 1000, mx: 'auto' }}>
			<Stack spacing={2}>
				<Typography component="h1" variant="h4">
					Solicitações
				</Typography>
				{error && (
					<Alert severity="error" role="alert">
						{error}
					</Alert>
				)}
				<Box component="form" onSubmit={create} aria-label="Nova solicitação">
					<Stack direction="row" spacing={2}>
						<TextField
							label="Título da solicitação"
							required
							value={title}
							disabled={busy}
							onChange={(e) => setTitle(e.target.value)}
							slotProps={{ htmlInput: { maxLength: 200 } }}
						/>
						<Button type="submit" disabled={busy || !title.trim()}>
							Criar solicitação
						</Button>
					</Stack>
				</Box>
				<Button
					disabled={busy || loading}
					onClick={() => {
						setError('');
						void load();
					}}>
					Atualizar solicitações
				</Button>
				{loading && <CircularProgress aria-label="Carregando solicitações" />}
				{!loading && !rows.length && <Typography>Nenhuma solicitação encontrada.</Typography>}
				<Stack component="nav" aria-label="Lista de solicitações">
					{rows.map((row) => (
						<Button key={row.id} disabled={busy} onClick={() => setSelected(row)}>
							{row.title} — {states[row.state]}
						</Button>
					))}
				</Stack>
				{selected && (
					<Stack spacing={2} component="section" aria-label="Detalhes da solicitação">
						<Typography component="h2" variant="h5">
							{selected.title}
						</Typography>
						<Typography>
							Status: {states[selected.state]} · Versão {selected.version}
						</Typography>
						<Typography>Total: BRL {formatMoney(selected.total, 2)}</Typography>
						<Box component="ul" aria-label="Itens da solicitação">
							{selected.items.map((item, index) => (
								<li key={index}>
									{item.description} · {item.quantity} × BRL {formatMoney(item.unitPrice, 2)}
								</li>
							))}
						</Box>
						{selected.canEdit && (
							<Box component="form" onSubmit={addItem} aria-label="Adicionar item">
								<Stack spacing={1}>
									<TextField
										label="Descrição do item"
										required
										disabled={busy}
										value={description}
										onChange={(e) => setDescription(e.target.value)}
										slotProps={{ htmlInput: { maxLength: 200 } }}
									/>
									<TextField
										label="Quantidade"
										type="number"
										required
										disabled={busy}
										value={quantity}
										onChange={(e) => setQuantity(e.target.value)}
										slotProps={{ htmlInput: { min: 1, max: 1000, step: 1 } }}
									/>
									<TextField
										label="Preço unitário em BRL"
										required
										disabled={busy}
										value={price}
										onChange={(e) => setPrice(e.target.value)}
										slotProps={{ htmlInput: { inputMode: 'decimal' } }}
									/>
									<Button type="submit" disabled={busy || selected.items.length >= 30}>
										Adicionar item
									</Button>
									<Button
										disabled={busy || !selected.items.length}
										onClick={() => void mutate(REQUEST_METHODS.submit, { id: selected.id, version: selected.version })}>
										Enviar para aprovação
									</Button>
								</Stack>
							</Box>
						)}
						{selected.canReview && (
							<Stack direction="row" spacing={2}>
								{(['approved', 'rejected'] as const).map((decision) => (
									<Button
										key={decision}
										disabled={busy}
										onClick={() =>
											void mutate(REQUEST_METHODS.decide, { id: selected.id, version: selected.version, decision })
										}>
										{decision === 'approved' ? 'Aprovar' : 'Rejeitar'}
									</Button>
								))}
							</Stack>
						)}
						<Typography component="h3" variant="h6">
							Histórico
						</Typography>
						<Box component="ol" aria-label="Histórico da solicitação">
							{selected.history.map((event) => (
								<li key={event.version}>
									{actions[event.action]} · {event.actor === 'reviewer' ? 'Aprovador' : 'Solicitante'} ·{' '}
									{new Date(event.at).toLocaleString()} · v{event.version}
								</li>
							))}
						</Box>
					</Stack>
				)}
				<Typography variant="caption">
					Até 100 solicitações por consulta, 30 itens e 200 eventos por solicitação.
				</Typography>
			</Stack>
		</Box>
	);
}
