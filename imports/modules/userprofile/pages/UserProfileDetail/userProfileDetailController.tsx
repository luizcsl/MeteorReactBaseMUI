import React, { useCallback, useContext, useState } from 'react';
import UserProfileDetailView from './userProfileDetailView';
import { useTracker } from 'meteor/react-meteor-data';
import { userprofileApi } from '../../api/userProfileApi';
import { IUserProfile } from '../../api/userProfileSch';
import { IMeteorError } from '../../../../typings/BoilerplateDefaultTypings';
import { ISchema } from '../../../../typings/ISchema';
import AppLayoutContext, { IAppLayoutContext } from '/imports/app/appLayoutProvider/appLayoutContext';

interface IUserProfileDetailControllerContext {
	user: IUserProfile;
	loading: boolean;
	schema: ISchema<IUserProfile>;
	onSubmit: (doc: IUserProfile) => void;
	mode: 'create' | 'edit' | 'view';
	closeDialog: () => void;
}

interface IUserProfileDetailController {
	onClose?: () => void;
	mode: 'create' | 'edit' | 'view';
	id?: string;
}

export const UserProfileDetailControllerContext = React.createContext<IUserProfileDetailControllerContext>(
	{} as IUserProfileDetailControllerContext
);

const UserProfileDetailController = ({ id, mode, onClose }: IUserProfileDetailController) => {
	const { showNotification, closeDialog: closeModal } = useContext<IAppLayoutContext>(AppLayoutContext);
	const closeDialog = onClose ?? closeModal;
	const [loading, setLoading] = useState(false);

	const { user, trackerLoading } = useTracker(() => {
		const subHandle = userprofileApi.subscribe('userProfileDetail', { _id: id });
		const user = subHandle?.ready() ? userprofileApi.findOne({ _id: id }) : {};
		return {
			user: user as IUserProfile,
			trackerLoading: !!subHandle && !subHandle.ready()
		};
	}, [id]);

	const onSubmit = useCallback(
		(doc: IUserProfile) => {
			if (mode === 'view') return;
			setLoading(true);
			userprofileApi['upsert'](doc, (e: IMeteorError, r: IUserProfile) => {
				if (!e) {
					showNotification({
						type: 'success',
						title: 'Operação realizada!',
						message: `Usuario ${mode === 'create' ? 'criado' : 'atualizado'} com sucesso`
					});
				} else {
					console.error('Error:', e);
					showNotification({
						type: 'warning',
						title: 'Operação não realizada!',
						message: `Erro ao realizar a operação: ${e.reason}`
					});
				}
				closeDialog();
			});
		},
		[user, mode, closeDialog, showNotification]
	);

	return (
		<UserProfileDetailControllerContext.Provider
			value={{
				user,
				loading: loading || trackerLoading,
				onSubmit,
				schema: userprofileApi.getSchema(),
				mode,
				closeDialog
			}}>
			<UserProfileDetailView />
		</UserProfileDetailControllerContext.Provider>
	);
};

export default UserProfileDetailController;
