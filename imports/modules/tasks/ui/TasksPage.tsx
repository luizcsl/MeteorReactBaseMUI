import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { callMethod } from '../../../api/methodTransport';
import { nanoid } from 'nanoid';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItem, Stack, TextField, Typography } from '@mui/material';
import AuthContext from '../../../app/authProvider/authContext';
import { taskDto, taskPage, TASKS_METHODS, type TaskDto } from '../contracts';

function message(error: unknown): string {
  const code = (error as { error?: string })?.error;
  if (code === 'conflict') return 'Esta tarefa foi alterada. Atualize a lista antes de tentar novamente.';
  if (code === 'forbidden' || code === 'unauthenticated') return 'Você não tem acesso. Entre novamente ou consulte o administrador.';
  return 'Não foi possível concluir. Verifique sua conexão e tente novamente.';
}
/** Method-only reference: no broad publication or client collection cache. */
export default function TasksPage() {
  const { isLoggedIn, userLoading, user } = useContext(AuthContext);
  const [items, setItems] = useState<TaskDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<TaskDto | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<TaskDto | null>(null);
  // Invalidate pending responses on account change/unmount to prevent cross-account UI leaks.
  const pendingCreate = useRef<{ mutationId: string; title: string } | null>(null);
  const generation = useRef(0);
  const listRequest = useRef(0);
  const load = useCallback(async (after: string | null = null) => {
    const token = generation.current;
    const request = ++listRequest.current;
    setLoading(true); setError('');
    try {
      if (!Meteor.status().connected) throw new Error('offline');
      const page = taskPage.parse(await callMethod(TASKS_METHODS.list, { after, limit: 20 }));
      if (token !== generation.current || request !== listRequest.current) return;
      setItems(previous => after ? [...previous, ...page.items] : page.items); setNext(page.next);
    } catch (failure) { if (token === generation.current && request === listRequest.current) setError(message(failure)); }
    finally { if (token === generation.current && request === listRequest.current) setLoading(false); }
  }, []);
  useEffect(() => {
    generation.current += 1; pendingCreate.current = null; setItems([]); setNext(null); setSelected(null); setDeleteTarget(null); setError(''); setBusy(false); setTitle('');
    if (isLoggedIn) void load();
    return () => { generation.current += 1; };
  }, [isLoggedIn, user?._id, load]);
  async function mutate(work: () => Promise<unknown>) {
    const token = generation.current;
    setBusy(true); setError('');
    try {
      if (!Meteor.status().connected) throw new Error('offline');
      await work();
      if (token !== generation.current) return;
      setTitle(''); setSelected(null); setDeleteTarget(null); await load();
    } catch (failure) { if (token === generation.current) setError(message(failure)); }
    finally { if (token === generation.current) setBusy(false); }
  }
  async function create() {
    const payload = title.trim();
    if (!pendingCreate.current || pendingCreate.current.title !== payload) pendingCreate.current = { mutationId: nanoid(), title: payload };
    const attempt = pendingCreate.current;
    await callMethod(TASKS_METHODS.create, attempt);
    if (pendingCreate.current === attempt) pendingCreate.current = null;
  }
  async function detail(id: string) {
    const token = generation.current; setBusy(true); setError('');
    try {
      if (!Meteor.status().connected) throw new Error('offline');
      const task = taskDto.parse(await callMethod(TASKS_METHODS.get, { id }));
      if (token === generation.current) { setSelected(task); setEditTitle(task.title); }
    } catch (failure) { if (token === generation.current) setError(message(failure)); }
    finally { if (token === generation.current) setBusy(false); }
  }
  if (userLoading) return <CircularProgress aria-label="Carregando sessão" />;
  if (!isLoggedIn) return <Alert severity="info">Entre para acessar suas tarefas.</Alert>;
  return <Box sx={{ p: 3, maxWidth: 800, mx: 'auto' }}>
    <Typography variant="h4" component="h1">Tarefas</Typography>
    {error && <Alert severity="error" role="alert" action={<Button onClick={() => void load()} disabled={loading || busy}>Atualizar</Button>}>{error}</Alert>}
    <Box component="form" onSubmit={event => { event.preventDefault(); void mutate(create); }} sx={{ my: 2 }}>
      <Stack direction="row" spacing={2}>
        <TextField label="Nova tarefa" value={title} onChange={event => setTitle(event.target.value)} required slotProps={{ htmlInput: { maxLength: 200 } }} disabled={busy} fullWidth />
        <Button type="submit" disabled={busy || !title.trim()}>Criar</Button>
      </Stack>
    </Box>
    {loading && <CircularProgress aria-label="Carregando tarefas" />}
    {!loading && !error && items.length === 0 && <Typography>Nenhuma tarefa ainda.</Typography>}
    <List aria-label="Suas tarefas">{items.map(task => <ListItem key={task.id} divider>
      <Button onClick={() => void detail(task.id)} disabled={busy} sx={{ flex: 1, justifyContent: 'flex-start' }}>{task.title} ({task.status === 'done' ? 'concluída' : 'aberta'})</Button>
      <Button onClick={() => setDeleteTarget(task)} disabled={busy} aria-label={`Excluir ${task.title}`}>Excluir</Button>
    </ListItem>)}</List>
    {next && <Button disabled={loading || busy} onClick={() => void load(next)}>Carregar mais</Button>}
    <Dialog open={!!selected} onClose={() => { if (!busy) setSelected(null); }} fullWidth aria-labelledby="task-detail-title">
      <DialogTitle id="task-detail-title">Editar tarefa</DialogTitle>
      <DialogContent>{error && <Alert severity="error" role="alert">{error} Feche esta janela e atualize a lista.</Alert>}<TextField autoFocus label="Título" value={editTitle} onChange={event => setEditTitle(event.target.value)} fullWidth margin="dense" slotProps={{ htmlInput: { maxLength: 200 } }} disabled={busy} />
        <Typography>Versão {selected?.version}</Typography></DialogContent>
      <DialogActions><Button onClick={() => setSelected(null)} disabled={busy}>Cancelar</Button>
        <Button disabled={busy || !editTitle.trim()} onClick={() => selected && void mutate(() => callMethod(TASKS_METHODS.update, { id: selected.id, version: selected.version, title: editTitle.trim(), status: selected.status }))}>Salvar</Button>
        <Button disabled={busy || !editTitle.trim()} onClick={() => selected && void mutate(() => callMethod(TASKS_METHODS.update, { id: selected.id, version: selected.version, title: editTitle.trim(), status: selected.status === 'done' ? 'open' : 'done' }))}>{selected?.status === 'done' ? 'Reabrir' : 'Concluir'}</Button>
      </DialogActions>
    </Dialog>
    <Dialog open={!!deleteTarget} onClose={() => { if (!busy) setDeleteTarget(null); }} aria-labelledby="task-delete-title">
      <DialogTitle id="task-delete-title">Excluir tarefa?</DialogTitle><DialogContent>{error && <Alert severity="error" role="alert">{error} Feche esta janela e atualize a lista.</Alert>}{deleteTarget?.title}</DialogContent>
      <DialogActions><Button onClick={() => setDeleteTarget(null)} disabled={busy}>Cancelar</Button><Button color="error" disabled={busy} onClick={() => deleteTarget && void mutate(() => callMethod(TASKS_METHODS.remove, { id: deleteTarget.id, version: deleteTarget.version }))}>Excluir</Button></DialogActions>
    </Dialog>
  </Box>;
}
