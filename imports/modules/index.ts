import RequestsPage from './requests/ui/RequestsPage';
import { integratedRoutes, integratedMenu } from '../integration/routes';
import TasksPage from './tasks/ui/TasksPage';
import { IAppMenu, IModuleHub, IRoute } from './modulesTypings';
import Example from './example/config';
import Aniversario from './aniversario/config';
import UserProfile from './userprofile/config';

const pages: Array<IRoute | null> = [
	...integratedRoutes,
	{ path: '/requests', component: RequestsPage, isProtected: true, authenticatedOnly: true },
	{ path: '/tasks', component: TasksPage, isProtected: true, authenticatedOnly: true },
	...Example.pagesRouterList,
	...Aniversario.pagesRouterList,
	...UserProfile.pagesRouterList
];

const menuItens: Array<IAppMenu | null> = [
	...integratedMenu,
	{ path: '/requests', name: 'Solicitações', isProtected: true },
	{ path: '/tasks', name: 'Minhas tarefas', isProtected: true },
	...Example.pagesMenuItemList,
	...Aniversario.pagesMenuItemList,
	...UserProfile.pagesMenuItemList
];

const Modules: IModuleHub = {
	pagesMenuItemList: menuItens,
	pagesRouterList: pages
};

export default Modules;
