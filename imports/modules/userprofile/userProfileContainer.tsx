import React, { useContext } from 'react';
import { IDefaultContainerProps } from '../../typings/BoilerplateDefaultTypings';
import { useNavigate, useParams } from '/imports/libs/router';
import UserProfileListController from '../../modules/userprofile/pages/UserProfileList/userProfileListController';
import UserProfileDetailController from './pages/UserProfileDetail/userProfileDetailController';
import AuthContext, { IAuthContext } from '/imports/app/authProvider/authContext';

export interface IUserProfileModuleContext {
	state?: string;
	id?: string;
}

export const UserProfileModuleContext = React.createContext<IUserProfileModuleContext>({});

export default (props: IDefaultContainerProps) => {
	const { user } = useContext<IAuthContext>(AuthContext);
	const navigate = useNavigate();
	let { screenState, userprofileId } = useParams();

	const state = screenState ? screenState : props.screenState;
	const id = userprofileId ?? user?._id;

	const validState = ['view', 'edit', 'create'];

	const renderPage = () => {
		if (!!!state || !validState.includes(state)) return <UserProfileListController />;
		return <UserProfileDetailController id={state === 'create' ? undefined : id} mode={state as 'view' | 'edit' | 'create'} onClose={() => navigate('/userprofile')} />;
	};

	const providerValue = {
		state,
		id
	};
	return <UserProfileModuleContext.Provider value={providerValue}>{renderPage()}</UserProfileModuleContext.Provider>;
};
