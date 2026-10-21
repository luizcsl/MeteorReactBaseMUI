import { validateDefinition } from '../../recipes.mjs';

export function exactObject(value, keys, label) {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new Error(`${label}: expected plain object`);
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== 'string' || !keys.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
			throw new Error(`${label}: unsupported key`);
	}
	return value;
}
function names(value, allowed, label) {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype ||
		value.length < 1 ||
		value.length > 30 ||
		Reflect.ownKeys(value).length !== value.length + 1 ||
		!Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i))).every(
			(d) => d?.enumerable && Object.hasOwn(d, 'value')
		) ||
		new Set(value).size !== value.length ||
		value.some((v) => !allowed.includes(v))
	)
		throw new Error(`${label}: invalid values`);
	return [...value];
}
export function validateUI(definition, input = {}) {
	const d = validateDefinition(definition);
	const u = exactObject(
		input,
		['layout', 'columns', 'pageSize', 'density', 'bulk', 'locales', 'steps', 'reactive', 'persistProgress'],
		'ui'
	);
	if (u.reactive !== undefined && typeof u.reactive !== 'boolean') throw new Error('ui: reactive must be boolean');
	if (Object.values(u).some((value) => value === null)) throw new Error('ui: explicit null is unsupported');
	const layout = u.layout ?? 'list-detail';
	if (!['list-detail', 'wizard'].includes(layout)) throw new Error('ui: unsupported layout');
	if (u.persistProgress !== undefined && !['none', 'session'].includes(u.persistProgress))
		throw new Error('ui: invalid progress persistence');
	if (u.persistProgress === 'session' && layout !== 'wizard') throw new Error('ui: session progress requires wizard');
	if (u.persistProgress === 'session' && d.profile !== 'owner')
		throw new Error(
			'ui: session progress requires owner profile; tenant drafts need a reviewed server-trusted tenant scope'
		);
	const columns = names(
		u.columns ?? d.fields.map((f) => f.name),
		d.fields.map((f) => f.name),
		'columns'
	);
	const pageSize = u.pageSize ?? 10,
		density = u.density ?? 'standard';
	if (![5, 10, 25, 50].includes(pageSize) || !['compact', 'standard'].includes(density))
		throw new Error('ui: unsupported pagination/density');
	if (u.bulk !== undefined && u.bulk !== 'delete') throw new Error('ui: unsupported bulk operation');
	const locales = names(u.locales ?? ['en'], ['en', 'pt-BR'], 'locales');
	let steps = [];
	if (layout === 'wizard') {
		if (
			!Array.isArray(u.steps) ||
			u.steps.length < 2 ||
			u.steps.length > 10 ||
			Reflect.ownKeys(u.steps).length !== u.steps.length + 1 ||
			!Array.from({ length: u.steps.length }, (_, i) => Object.getOwnPropertyDescriptor(u.steps, String(i))).every(
				(d) => d?.enumerable && Object.hasOwn(d, 'value')
			)
		)
			throw new Error('ui: wizard needs 2–10 steps');
		steps = u.steps.map((step) => {
			exactObject(step, ['label', 'fields'], 'step');
			if (typeof step.label !== 'string' || !step.label.trim() || step.label.length > 80)
				throw new Error('ui: invalid step label');
			return {
				label: step.label,
				fields: names(
					step.fields,
					d.fields.map((f) => f.name),
					'step.fields'
				)
			};
		});
		if (new Set(steps.map((step) => step.label)).size !== steps.length) throw new Error('ui: duplicate step labels');
		const all = steps.flatMap((s) => s.fields);
		if (new Set(all).size !== all.length || all.length !== d.fields.length)
			throw new Error('ui: wizard must cover every field exactly once');
	} else if (u.steps !== undefined) throw new Error('ui: steps require wizard');
	return {
		layout,
		columns,
		pageSize,
		density,
		reactive: u.reactive ?? false,
		persistProgress: u.persistProgress ?? 'none',
		...(u.bulk ? { bulk: u.bulk } : {}),
		locales,
		steps
	};
}
const messages = {
	en: {
		save: 'Save',
		saving: 'Saving…',
		error: 'Unable to save. Check the fields and your permission, then retry.',
		loading: 'Loading records',
		empty: 'No records found.',
		conflict: 'Operation failed or record changed. Refresh and retry.',
		refresh: 'Refresh',
		search: 'Search loaded records',
		edit: 'Edit',
		detail: 'Details',
		close: 'Close',
		remove: 'Delete selected',
		confirm: 'Delete selected records?',
		cancel: 'Cancel',
		next: 'Next',
		back: 'Back',
		bounded: 'Showing at most 100 authorized records. Search, sort and pagination apply to this loaded window.',
		partial: 'Some records could not be deleted. Refresh before retrying.',
		saved: 'Operation completed.',
		draftUnavailable: 'Draft could not be saved in this browser session.',
		order: 'ID order',
		pageSize: 'Page size',
		serverWindow: 'Server-scoped exact filters and stable ID cursor pagination.',
		new: 'New record'
	},
	'pt-BR': {
		save: 'Salvar',
		saving: 'Salvando…',
		error: 'Não foi possível salvar. Confira os campos e sua permissão.',
		loading: 'Carregando registros',
		empty: 'Nenhum registro encontrado.',
		conflict: 'A operação falhou ou o registro mudou. Atualize e tente novamente.',
		refresh: 'Atualizar',
		search: 'Pesquisar registros carregados',
		edit: 'Editar',
		detail: 'Detalhes',
		close: 'Fechar',
		remove: 'Excluir selecionados',
		confirm: 'Excluir os registros selecionados?',
		cancel: 'Cancelar',
		next: 'Próximo',
		back: 'Voltar',
		bounded:
			'Exibindo no máximo 100 registros autorizados. Pesquisa, ordenação e paginação se aplicam a este conjunto.',
		partial: 'Alguns registros não puderam ser excluídos. Atualize antes de tentar novamente.',
		saved: 'Operação concluída.',
		draftUnavailable: 'Não foi possível guardar o rascunho nesta sessão.',
		order: 'Ordem de ID',
		pageSize: 'Tamanho da página',
		serverWindow: 'Filtros exatos autorizados no servidor e paginação por cursor de ID.',
		new: 'Novo registro'
	}
};
export function renderUI({ definition, ui = {}, services = {} }) {
	const d = validateDefinition(definition),
		u = validateUI(d, ui),
		base = `imports/modules/${d.name}/generated`;
	const search = services.search;
	if (
		search &&
		(!Array.isArray(search.fields) ||
			search.fields.some((name) => !d.filters.includes(name)) ||
			!Number.isInteger(search.pageSize) ||
			search.pageSize < 1 ||
			search.pageSize > 100)
	)
		throw new Error('ui: invalid bounded search config');
	if (search && d.profile === 'master-detail') throw new Error('ui: master-detail cursor search unsupported');
	if (search && u.reactive) throw new Error('ui: reactive cursor search requires a dedicated reviewed adapter');
	const catalogs = Object.fromEntries(u.locales.map((locale) => [locale, messages[locale]]));
	return {
		[`imports/modules/${d.name}/automation/Page.tsx`]: `// Generated authenticated composition boundary. Server scopes remain authoritative.
import React, { useContext, useEffect } from 'react';
import AuthContext from '../../../app/authProvider/authContext';
import { createRecipeClient } from '../../../core/ui/recipeClient';
import { definition } from '../generated/definition';
import { FeatureUI } from '../generated/FeatureUI';
import { type Locale } from '../generated/ui.messages';
${search ? "import { createServiceClient } from '../generated/services/client';\nconst searchClient=createServiceClient().search;" : ''}
import { clearDrafts,browserDraftStorage } from '../generated/ui.state';
const client=createRecipeClient(definition,${u.reactive});
export default function AutomationPage({parentId=null,locale}:{parentId?:string|null;locale?:Locale}) {
 const {user,isLoggedIn,userLoading}=useContext(AuthContext);
 useEffect(()=>{if(!userLoading&&!isLoggedIn)clearDrafts(browserDraftStorage());},[userLoading,isLoggedIn]);
 if(!isLoggedIn||!user?._id)return null;
 return <FeatureUI client={client} scopeKey={user._id} parentId={parentId} locale={locale} ${search ? 'search={searchClient}' : ''}/>;
}
`,
		[`${base}/ui.state.ts`]:
			"// Generated pure state controllers shared by the UI and executable tests.\nimport { definition } from './definition';\nimport { type RecipeData } from '../../../core/recipes/definition';\nimport { type RecipeRow } from '../../../core/ui/RecipePage';\nexport type SearchInput={filters:RecipeData;cursor:string|null;limit:number;order:'asc'|'desc'};\nexport type SearchClient=(input:SearchInput)=>Promise<{items:RecipeRow[];nextCursor:string|null}>;\nexport interface CursorState {rows:RecipeRow[];loading:boolean;error:boolean;page:number;hasNext:boolean;}\nexport function createCursorPager(search:SearchClient,publish:(state:CursorState)=>void){\n let serial=0, disposed=false, cursors:Array<string|null>=[null],page=0,next:string|null=null;\n let query:Omit<SearchInput,'cursor'>={filters:{},limit:10,order:'asc'};\n const load=async()=>{const token=++serial;publish({rows:[],loading:true,error:false,page,hasNext:false});\n  try{const result=await search({...query,filters:{...query.filters},cursor:cursors[page]});if(disposed||token!==serial)return;\n   if(!Array.isArray(result.items)||result.items.length>query.limit||(result.nextCursor!==null&&(typeof result.nextCursor!=='string'||result.nextCursor.length>1024)))throw new Error('Invalid page');\n   next=result.nextCursor;publish({rows:result.items,loading:false,error:false,page,hasNext:next!==null});\n  }catch{if(!disposed&&token===serial){next=null;publish({rows:[],loading:false,error:true,page,hasNext:false});}}\n };\n return {request(input:Omit<SearchInput,'cursor'>){query={...input,filters:{...input.filters}};page=0;cursors=[null];next=null;return load();},\n next(){if(next===null)return Promise.resolve();cursors=cursors.slice(0,page+1);cursors.push(next);page++;next=null;return load();},\n previous(){if(page===0)return Promise.resolve();page--;next=null;return load();},refresh(){page=0;cursors=[null];next=null;return load();},\n cancel(){serial++;},dispose(){serial++;disposed=true;}};\n}\nexport type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;\nconst prefix='automation:draft:'+definition.name+':',indexKey=prefix+'active';\nexport function clearDrafts(storage:DraftStorage|undefined){try{if(!storage)return;const key=storage.getItem(indexKey);if(key?.startsWith(prefix))storage.removeItem(key);storage.removeItem(indexKey);}catch{}}\nexport function browserDraftStorage():DraftStorage|undefined{try{return typeof window==='undefined'?undefined:window.sessionStorage;}catch{return undefined;}}\nexport function createDraftStore(storage:DraftStorage|undefined,owner:string,context:string,steps:number,schema:string,now=()=>Date.now()){\n const key=prefix+encodeURIComponent(JSON.stringify([owner,context]));\n const valid=(value:unknown):value is RecipeData=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).every(([name,data])=>definition.fields.some(field=>field.name===name)&&(data===null||typeof data==='boolean'||typeof data==='number'&&Number.isSafeInteger(data)||typeof data==='string'&&data.length<=2000));\n const activate=()=>{if(!storage)return false;const previous=storage.getItem(indexKey);if(previous!==key){clearDrafts(storage);storage.setItem(indexKey,key);}return true;};\n const clear=()=>{try{storage?.removeItem(key);}catch{}};\n return {clear,read():{step:number;data:RecipeData}|null{try{if(!activate())return null;const raw=storage!.getItem(key);if(!raw)return null;if(raw.length>65536)throw new Error('oversized draft');const value=JSON.parse(raw);\n if(value.version!==1||value.owner!==owner||value.context!==context||value.schema!==schema||!Number.isSafeInteger(value.savedAt)||now()<value.savedAt||now()-value.savedAt>1800000||!Number.isInteger(value.step)||value.step<0||value.step>=steps||!valid(value.data))throw new Error('invalid draft');\n return {step:value.step,data:value.data};}catch{clear();return null;}},\n save(step:number,data:RecipeData){try{if(!activate()||!valid(data)||!Number.isInteger(step)||step<0||step>=steps)return false;const value=JSON.stringify({version:1,owner,context,schema,savedAt:now(),step,data});if(value.length>65536)return false;storage!.setItem(key,value);return true;}catch{return false;}}};\n}\n",
		[`${base}/ui.messages.ts`]: `// Generated. Field and step labels are supplied by the product specification.\nexport const messages = ${JSON.stringify(catalogs, null, 2)} as const;\nexport type Locale = keyof typeof messages;\n`,
		[`${base}/FeatureUI.tsx`]: `// Generated bounded UI. Server authorization remains authoritative; no browser persistence of private drafts.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, Step, StepLabel, Stepper, TextField, Typography } from '@mui/material';
import { DataGrid, type GridColDef, type GridRowSelectionModel } from '@mui/x-data-grid';
import { RecipeForm } from '../../../core/ui/RecipeForm';
import { type RecipeClient, type RecipeRow } from '../../../core/ui/RecipePage';
import { parseRecipeData, parseRecipeFilters, parseMoneyText, formatMoney, initialRecipeData, type RecipeData, type RecipeDefinition } from '../../../core/recipes/definition';
import { definition } from './definition';
import { messages, type Locale } from './ui.messages';
import { createCursorPager,createDraftStore,clearDrafts,browserDraftStorage,type SearchClient } from './ui.state';
const config = ${JSON.stringify(u)};
const searchConfig:${'null|{fields:string[];pageSize:number}'}=${JSON.stringify(search ?? null)};
export interface FeatureUIProps { client: RecipeClient; scopeKey: string; parentId?: string | null; locale?: Locale; search?:SearchClient; }
export function FeatureUI(props: FeatureUIProps) {
 const identity = useRef({client:props.client,generation:0});
 if(identity.current.client!==props.client) identity.current={client:props.client,generation:identity.current.generation+1};
 return <ScopedFeature key={JSON.stringify([props.scopeKey,props.parentId,identity.current.generation])} {...props}/>;
}
function ScopedFeature({client,scopeKey,search,parentId=null,locale=${JSON.stringify(u.locales[0])}}:FeatureUIProps) {
 const t=messages[locale];
 const [rows,setRows]=useState<RecipeRow[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[query,setQuery]=useState(''),[status,setStatus]=useState('');
 const [selected,setSelected]=useState<GridRowSelectionModel>({type:'include',ids:new Set()}),[confirm,setConfirm]=useState(false);
 const [detail,setDetail]=useState<RecipeRow|null>(null),[editing,setEditing]=useState<RecipeRow|null>(null),[revision,setRevision]=useState(0),[reload,setReload]=useState(0);
 const [filters,setFilters]=useState<RecipeData>({}),[order,setOrder]=useState<'asc'|'desc'>('asc'),[pageSize,setPageSize]=useState(Math.min(config.pageSize,searchConfig?.pageSize??100)),[page,setPage]=useState(0),[hasNext,setHasNext]=useState(false);
 const pager=useMemo(()=>search?createCursorPager(search,state=>{setRows(state.rows);setLoading(state.loading);setPage(state.page);setHasNext(state.hasNext);setError(state.error?t.conflict:'');setDetail(null);setSelected({type:'include',ids:new Set()});if(state.error){setEditing(null);setRevision(v=>v+1);clearDrafts(browserDraftStorage());}}):null,[search]);
 useEffect(()=>()=>pager?.cancel(),[pager]);
 useEffect(()=>{if(pager)void pager.request({filters,limit:pageSize,order});return()=>pager?.cancel();},[pager,filters,pageSize,order]);
 const live=useRef(true), sequence=useRef(0), lock=useRef(false), creation=useRef<{fingerprint:string;id:string}|null>(null);
 useEffect(()=>{live.current=true;return()=>{live.current=false;sequence.current++;};},[]);
 const refresh=async()=>{
  if(pager){await pager.refresh();return;}
  if(searchConfig){setRows([]);setLoading(false);setError(t.conflict);return;}
  if(client.subscribe){setReload(value=>value+1);return;}
  const token=++sequence.current; setLoading(true);setError('');setSelected({type:'include',ids:new Set()});setDetail(null);
  try {const next=await client.list({},100,parentId);if(live.current&&token===sequence.current)setRows(next);}
  catch {if(live.current&&token===sequence.current){setRows([]);setEditing(null);setRevision(value=>value+1);clearDrafts(browserDraftStorage());setError(t.conflict);}}
  finally {if(live.current&&token===sequence.current)setLoading(false);}
 };
 useEffect(()=>{
  if(pager)return;
  if(!client.subscribe){void refresh();return;}
  const token=++sequence.current;setLoading(true);setRows([]);setDetail(null);setSelected({type:'include',ids:new Set()});
  const subscription=client.subscribe({},100,parentId,state=>{if(!live.current||token!==sequence.current)return;setRows(state.error?[]:state.rows);setLoading(state.loading);setError(state.error?t.conflict:'');if(state.error||(state.loading&&state.rows.length===0)){setEditing(null);setDetail(null);setRevision(value=>value+1);creation.current=null;clearDrafts(browserDraftStorage());setSelected({type:'include',ids:new Set()});}});
  return()=>{sequence.current++;subscription.stop();};
 },[client,parentId,reload,pager]);
 const mutate=async(fn:()=>Promise<unknown>)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');setStatus('');
  try {await fn();if(live.current){setStatus(t.saved);clearDrafts(browserDraftStorage());setEditing(null);setRevision(v=>v+1);await refresh();}}
  catch {if(live.current)setError(t.conflict);throw new Error(t.conflict);}
  finally {lock.current=false;if(live.current)setBusy(false);}
 };
 const save=async(data:RecipeData)=>mutate(async()=>{
  if(editing) await client.update(editing.id,editing.version,data);
  else {const fingerprint=JSON.stringify([data,parentId]);if(creation.current?.fingerprint!==fingerprint)creation.current={fingerprint,id:crypto.randomUUID()};await client.create(data,parentId,creation.current.id);creation.current=null;}
 });
 const remove=async()=>{
  setConfirm(false);let failed=false;
  await mutate(async()=>{for(const row of rows.filter(r=>selected.ids.has(r.id))){try{await client.remove(row.id,row.version);}catch{failed=true;}}}).catch(()=>{});
  if(live.current&&failed){setError(t.partial);setStatus('');}
 };
 const columns:GridColDef<RecipeRow>[] = config.columns.map(name=>({field:name,headerName:definition.fields.find(f=>f.name===name)!.label,flex:1,minWidth:130,sortable:!searchConfig,filterable:!searchConfig,valueGetter:(_value,row)=>row.data[name]}));
 columns.push({field:'actions',headerName:t.detail,sortable:false,filterable:false,width:180,renderCell:({row})=><><Button disabled={busy} aria-label={t.detail+' '+row.id} onClick={()=>setDetail(row)}>{t.detail}</Button><Button disabled={busy} aria-label={t.edit+' '+row.id} onClick={()=>{setEditing(row);setRevision(v=>v+1);}}>{t.edit}</Button></>});
 const visible=searchConfig?rows:rows.filter(row=>config.columns.some(name=>String(row.data[name]??'').toLocaleLowerCase(locale).includes(query.toLocaleLowerCase(locale))));
 return <Stack spacing={3} sx={{width:'100%',minWidth:0}} aria-label={definition.name}>
  <Typography variant="h4">{definition.name}</Typography>
  {error&&<Alert severity="error" role="alert">{error}</Alert>}
  {status&&<Typography role="status" aria-live="polite">{status}</Typography>}
  <Box component="section" aria-label={editing?t.edit:t.new}>
   <FeatureForm key={revision+':'+(editing?.id??'new')} initial={editing?.data} disabled={busy} onSubmit={save} locale={locale} scopeKey={scopeKey} context={JSON.stringify([parentId,editing?.id??'new',editing?.version??0])}/>
   {editing&&<Button disabled={busy} onClick={()=>{setEditing(null);setRevision(v=>v+1);}}>{t.cancel}</Button>}
  </Box>
  <TextField sx={{display:searchConfig?'none':undefined}} label={t.search} value={query} onChange={event=>{setQuery(event.target.value);setSelected({type:'include',ids:new Set()});}}/>
  {searchConfig&&<Stack direction={{xs:'column',sm:'row'}} spacing={1}>{searchConfig.fields.map(name=>{const field=definition.fields.find(f=>f.name===name)!;return <TextField key={name} label={field.label} select={field.type==='boolean'||field.type==='enum'} type={field.type==='date'?'date':field.type==='integer'?'number':'text'} slotProps={{inputLabel:field.type==='date'?{shrink:true}:undefined}} value={field.type==='money'&&typeof filters[name]==='number'?formatMoney(filters[name] as number,field.scale!):filters[name]??''} onChange={event=>{const value=event.target.value;setFilters(previous=>{const next={...previous};if(value==='')delete next[name];else try{next[name]=field.type==='money'?parseMoneyText(value,field.scale!):field.type==='integer'?Number(value):field.type==='boolean'?value==='true':value;}catch{setError(t.error);return previous;}try{return parseRecipeFilters(definition,next);}catch{setError(t.error);return previous;}});}}>{(field.type==='boolean'||field.type==='enum')&&[<MenuItem key="all" value="">*</MenuItem>,...(field.type==='boolean'?['true','false']:field.values!).map(value=><MenuItem key={value} value={value}>{value}</MenuItem>)]}</TextField>;})}<TextField select label={t.order} value={order} onChange={event=>setOrder(event.target.value as 'asc'|'desc')}><MenuItem value="asc">ID ↑</MenuItem><MenuItem value="desc">ID ↓</MenuItem></TextField><TextField select label={t.pageSize} value={pageSize} onChange={event=>setPageSize(Number(event.target.value))}>{[...new Set([1,5,10,25,50,searchConfig.pageSize])].filter(value=>value<=searchConfig.pageSize).sort((a,b)=>a-b).map(value=><MenuItem key={value} value={value}>{value}</MenuItem>)}</TextField></Stack>}
  <Typography variant="caption">{searchConfig?t.serverWindow:t.bounded}</Typography>
  {loading?<CircularProgress aria-label={t.loading}/>:<Box sx={{height:480,width:'100%',overflowX:'auto'}}><DataGrid aria-label={definition.name} rows={visible} columns={columns} paginationModel={searchConfig?{page:0,pageSize}:undefined} hideFooter={Boolean(searchConfig)} paginationMode={searchConfig?'server':'client'} sortingMode={searchConfig?'server':'client'} filterMode={searchConfig?'server':'client'} rowCount={searchConfig?-1:undefined} paginationMeta={searchConfig?{hasNextPage:hasNext}:undefined} density={config.density as 'compact'|'standard'} disableRowSelectionOnClick disableRowSelectionExcludeModel checkboxSelection={${Boolean(u.bulk)}} rowSelectionModel={selected} onRowSelectionModelChange={setSelected} isRowSelectable={()=>!busy} pageSizeOptions={searchConfig?[pageSize]:[5,10,25,50]} initialState={{pagination:{paginationModel:{page:0,pageSize:config.pageSize}}}} localeText={{noRowsLabel:t.empty}}/></Box>}
  <Stack direction={{xs:'column',sm:'row'}} spacing={1}>
   {pager&&<><Button disabled={busy||loading||page===0} onClick={()=>void pager.previous()}>{t.back}</Button><Typography aria-live="polite">{page+1}</Typography><Button disabled={busy||loading||!hasNext} onClick={()=>void pager.next()}>{t.next}</Button></>}
   <Button disabled={busy||loading} onClick={()=>void refresh()}>{t.refresh}</Button>
   ${u.bulk ? '<Button disabled={busy||loading||selected.ids.size===0} onClick={()=>setConfirm(true)}>{t.remove}</Button>' : ''}
  </Stack>
  <Dialog open={confirm} onClose={()=>{if(!busy)setConfirm(false);}} aria-labelledby="delete-title"><DialogTitle id="delete-title">{t.confirm}</DialogTitle><DialogContent>{selected.ids.size}</DialogContent><DialogActions><Button disabled={busy} onClick={()=>setConfirm(false)}>{t.cancel}</Button><Button disabled={busy} onClick={()=>void remove()}>{t.remove}</Button></DialogActions></Dialog>
  <Dialog open={Boolean(detail)} onClose={()=>setDetail(null)} aria-labelledby="detail-title"><DialogTitle id="detail-title">{t.detail}</DialogTitle><DialogContent><Box component="dl">{definition.fields.map(field=><React.Fragment key={field.name}><Typography component="dt">{field.label}</Typography><Typography component="dd">{String(detail?.data[field.name]??'')}</Typography></React.Fragment>)}</Box></DialogContent><DialogActions>{detail&&definition.transitions.filter(transition=>transition.from===detail.state).map(transition=><Button key={transition.to} disabled={busy} onClick={()=>void mutate(()=>client.transition(detail.id,detail.version,transition.to)).catch(()=>{})}>{transition.to}</Button>)}<Button onClick={()=>setDetail(null)}>{t.close}</Button></DialogActions></Dialog>
 </Stack>;
}
function FeatureForm({initial,disabled,onSubmit,locale,scopeKey,context}:{initial?:RecipeData;disabled:boolean;onSubmit:(data:RecipeData)=>Promise<void>;locale:Locale;scopeKey:string;context:string}) {
 const t=messages[locale];
 const store=useMemo(()=>config.persistProgress==='session'?createDraftStore(browserDraftStorage(),scopeKey,context,config.steps.length,JSON.stringify([definition,config.steps])):null,[scopeKey,context]);
 const [recovered]=useState(()=>store?.read()),[step,setStep]=useState(recovered?.step??0),[draft,setDraft]=useState<RecipeData>(recovered?.data??initial??{}),[draftError,setDraftError]=useState(false);
 const changed=(data:RecipeData)=>{const next={...draft,...data};setDraft(next);setDraftError(store?!store.save(step,next):false);};
 const steps:${'Array<{label:string;fields:string[]}> '}=config.steps;
 if(config.layout!=='wizard')return <RecipeForm definition={definition} initial={initial} disabled={disabled} onSubmit={onSubmit} text={t}/>;
 const current=steps[step];
 const part:RecipeDefinition={...definition,fields:definition.fields.filter(field=>current.fields.includes(field.name)),filters:[],rules:(definition.rules??[]).filter(rule=>current.fields.includes(rule.left)&&current.fields.includes(rule.right))};
 const values=Object.fromEntries(Object.entries(draft).filter(([name])=>current.fields.includes(name)));
 return <Stack spacing={2}>{draftError&&<Alert severity="warning" role="alert">{t.draftUnavailable}</Alert>}<Stepper activeStep={step} alternativeLabel>{steps.map(item=><Step key={item.label}><StepLabel>{item.label}</StepLabel></Step>)}</Stepper>
 <RecipeForm key={step} definition={part} initial={{...initialRecipeData(part),...values}} onChange={changed} disabled={disabled} text={{...t,save:step===steps.length-1?t.save:t.next}} onSubmit={async data=>{const next={...draft,...data};setDraft(next);if(step===steps.length-1){await onSubmit(parseRecipeData(definition,next));store?.clear();}else {store?.save(step+1,next);setStep(step+1);}}}/>
 <Button disabled={disabled||step===0} onClick={()=>{store?.save(step-1,draft);setStep(step-1);}}>{t.back}</Button></Stack>;
}
`,
		[`${base}/FeatureUI.stories.tsx`]: `// Portable controlled previews. Import these into a preview route or Storybook; no backend calls.
import React from 'react';
import { FeatureUI } from './FeatureUI';
import { definition } from './definition';
import { type RecipeClient, type RecipeRow } from '../../../core/ui/RecipePage';
export function previewClient(rows:RecipeRow[]=[],state:'ready'|'loading'|'error'|'conflict'='ready'):RecipeClient {
 let stored=structuredClone(rows),counter=0;
 const check=(id:string,version:number)=>{const row=stored.find(item=>item.id===id);if(state==='conflict'||!row||row.version!==version)throw new Error('controlled conflict');return row;};
 return {
  list:async()=>{if(state==='loading')return new Promise<RecipeRow[]>(()=>{});if(state==='error')throw new Error('controlled error');return structuredClone(stored);},
  create:async(data,parentId)=>{if(state==='conflict')throw new Error('controlled conflict');const row:RecipeRow={id:'preview-'+(++counter),parentId,version:1,state:definition.states[0],data:structuredClone(data)};stored.push(row);return structuredClone(row);},
  update:async(id,version,data)=>{const row=check(id,version);row.data=structuredClone(data);row.version++;return structuredClone(row);},
  transition:async(id,version,to)=>{const row=check(id,version);row.state=to;row.version++;return structuredClone(row);},
  remove:async(id,version)=>{check(id,version);stored=stored.filter(row=>row.id!==id);return {removed:true};}
 };
}
const empty=previewClient(),loading=previewClient([],'loading'),error=previewClient([],'error');
export const Empty=()=> <FeatureUI client={empty} scopeKey="preview"/>;
export const Loading=()=> <FeatureUI client={loading} scopeKey="preview"/>;
export const ErrorState=()=> <FeatureUI client={error} scopeKey="preview"/>;
const conflict=previewClient([],'conflict');
export const Conflict=()=> <FeatureUI client={conflict} scopeKey="preview"/>;
export default {title:${JSON.stringify(d.name + '/Feature')},component:FeatureUI};
`
	};
}
