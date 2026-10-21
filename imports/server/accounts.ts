import { Accounts } from 'meteor/accounts-base';
import { Meteor } from 'meteor/meteor';
import { getUserProfileSelector, userprofileServerApi } from '../modules/userprofile/api/userProfileServerApi';
import { getHTMLEmailTemplate } from './email';
import { serverSettings as settings } from '/imports/config/serverSettings';
import { Mongo } from 'meteor/mongo';

import { getBase64FromURLImage } from './socialAvatar';

const escapeHtml = (value: unknown) =>
	String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

async function updateUserProfileImageFromURL(userId: string | Mongo.ObjectID | Mongo.Selector<any>, urlImage: string) {
	try {
		const image = await getBase64FromURLImage(urlImage);
		await userprofileServerApi.getCollectionInstance().updateAsync(userId, {
			$set: { photo: image, lastupdate: new Date() }
		});
	} catch (error) {
		console.warn('Não foi possível atualizar a imagem do perfil social:', error);
	}
}

async function validateSocialLoginAndUpdateProfile(
	userProfile: {
		_id: string | Mongo.ObjectID | Mongo.Selector<any>;
		photo: any;
	},
	user: Mongo.OptionalId<any>,
	serviceName: string
) {
	const profiles = userprofileServerApi.getCollectionInstance();
	if (!userProfile) {
		// Never copy OAuth services, tokens or caller-defined roles to a profile.
		const profileId = await profiles.insertAsync({
			_id: user._id,
			accountId: user._id,
			username: String(user.username || user.profile?.name || ''),
			email: String(user.email || ''),
			roles: ['Usuario'],
			status: 'active',
			createdat: new Date(),
			lastupdate: new Date()
		});
		if (user.services?.google?.picture) await updateUserProfileImageFromURL(profileId, user.services.google.picture);
	} else if (!userProfile.photo && user.services?.google?.picture) {
		await updateUserProfileImageFromURL(userProfile._id, user.services.google.picture);
	}
	// Roles and status have one source of truth: userprofile, not OAuth or account payloads.
	await Meteor.users.updateAsync(
		{ _id: user._id },
		{
			$set: {
				profile: {
					name: String(user.profile?.name || user.username || ''),
					email: String(user.email || '')
				}
			}
		}
	);

	return true;
}

async function validateLoginGoogle(user: Meteor.User & { name?: string; email?: string }) {
	const google = user.services?.google;
	if (!google?.email) throw new Meteor.Error('invalid-social-profile', 'O Google não retornou um e-mail válido.');
	user.username = `${google.name ?? google.email}`;
	user.name = `${google.name ?? google.email}`;
	user.email = google.email;
	const serviceName = 'google';
	const userProfile = await userprofileServerApi.getCollectionInstance().findOneAsync({ accountId: user._id });

	return validateSocialLoginAndUpdateProfile(userProfile, user, serviceName);
}

async function validateLoginFacebook(user: Meteor.User & { name?: string; email?: string }): Promise<Boolean> {
	const serviceName = 'facebook';
	const facebook = user.services?.facebook;
	if (!facebook?.email) throw new Meteor.Error('invalid-social-profile', 'O Facebook não retornou um e-mail válido.');
	user.username = `${facebook.name ?? facebook.email}_facebook`;
	user.name = `${facebook.name ?? facebook.email}`;
	user.email = facebook.email;
	const userProfile = await userprofileServerApi.getCollectionInstance().findOneAsync({ accountId: user._id });

	return validateSocialLoginAndUpdateProfile(userProfile, user, serviceName);
}

// if the database is empty on server start, create some sample data.
Meteor.startup(() => {
	Accounts.emailTemplates.from = settings.mail_system;
	Accounts.emailTemplates.siteName = settings.name;

	// region VERIFICAR_EMAIL
	Accounts.emailTemplates.verifyEmail.subject = () => {
		return settings.name;
	};
	Accounts.emailTemplates.verifyEmail.html = (user, url) => {
		const urlWithoutHash = escapeHtml(url.replace('#/', ''));
		const username = user.username || user.profile?.name || user.profile?.email || 'usuário';
		const email =
			`${
				`<p>Olá ${escapeHtml(username)},</p>` +
				'<p>Seja bem vindo ao &nbsp;<strong>MeteorReactBase-MUI</strong>.</p>' +
				'<p>Para confirmar seu cadastro clique no link abaixo:</p>' +
				'<p><ins><a href="'
			}${urlWithoutHash}">${urlWithoutHash}</a></ins></p>` +
			'<p>Ficamos felizes com o seu cadastro.</p>' +
			'<p><br/>Equipe <b>MeteorReactBase-MUI</b></p>';
		const footer = `Essa mensagem foi gerada automaticamente!`;
		return getHTMLEmailTemplate('Confirmação do cadastro', email, footer);
	};

	Accounts.emailTemplates.enrollAccount.subject = () => {
		return settings.name;
	};

	Accounts.emailTemplates.enrollAccount.html = (user, url) => {
		const urlWithoutHash = escapeHtml(url.replace('#/', ''));
		const username = user.username || user.profile?.name || user.profile?.email || 'usuário';

		const email =
			`${
				`<p>Olá ${escapeHtml(username)},</p>` +
				'<p>Seja bem vindo ao &nbsp;<strong>MeteorReactBase-MUI</strong>.</p>' +
				'<p>Para concluir seu cadastro clique no link abaixo e informe uma senha:</p>' +
				'<p><ins><a href="'
			}${urlWithoutHash}">${urlWithoutHash}</a></ins></p>` +
			'<p>Ficamos felizes com o seu cadastro.</p>' +
			'<p><br/>Equipe <b>MeteorReactBase-MUI</b></p>';
		const footer = `Essa mensagem foi gerada automaticamente!`;
		return getHTMLEmailTemplate('Conclua o seu cadastro', email, footer);
	};

	// endregion

	// region ALTERAR_SENHA
	Accounts.emailTemplates.resetPassword.subject = () => {
		return settings.name;
	};
	Accounts.emailTemplates.resetPassword.html = (user, url) => {
		const urlWithoutHash = escapeHtml(url.replace('#/', ''));
		const username = user.username || user.profile?.name || user.profile?.email || 'usuário';
		const email =
			`${
				`<p>Olá ${escapeHtml(username)},</p>` +
				'<p>Sua senha de acesso ao <strong>MeteorReactBase-MUI</strong> será alterada.</p>' +
				'<p>Clique no link abaixo e informe uma nova senha:</p>' +
				'<p><ins><a href="'
			}${urlWithoutHash}">${urlWithoutHash}</a></ins></p>` +
			'<p></p>' +
			'<p><br/>Equipe <b>MeteorReactBase-MUI</b></p>';
		const footer = `Essa mensagem foi gerada automaticamente!`;
		return getHTMLEmailTemplate('Alteração da senha atual', email, footer);
	};

	Accounts.onLogin(async (params: { user: Meteor.User; connection: { onClose: (arg0: () => void) => void } }) => {
		//@ts-ignore
		const userProfile = params.user
			? await userprofileServerApi.getCollectionInstance().findOneAsync({ accountId: params.user._id })
			: undefined;

		if (userProfile)
			await userprofileServerApi
				.getCollectionInstance()
				.updateAsync({ _id: userProfile._id }, { $set: { lastacess: new Date(), connected: true } });

		params.connection.onClose(
			Meteor.bindEnvironment(() => {
				if (userProfile)
					void userprofileServerApi
						.getCollectionInstance()
						.updateAsync({ _id: userProfile._id }, { $set: { lastacess: new Date(), connected: false } })
						.catch((error) => console.error('Falha ao registrar desconexão de usuário', error));
			})
		);
	});

	Accounts.onLogout(async (params) => {
		//@ts-ignore
		const userProfile = params.user
			? await userprofileServerApi.getCollectionInstance().findOneAsync({ accountId: params.user._id })
			: undefined;
		if (userProfile)
			await userprofileServerApi
				.getCollectionInstance()
				.updateAsync({ _id: userProfile._id }, { $set: { lastacess: new Date(), connected: false } });
	});

	Accounts.config({
		sendVerificationEmail: true,
		forbidClientAccountCreation: process.env.ALLOW_CLIENT_ACCOUNT_CREATION !== 'true'
	});

	Accounts.validateLoginAttempt(async ({ user, allowed }: { user: Meteor.User; allowed: boolean }) => {
		if (!allowed) return allowed;
		if (!user) return false;

		// ################################ FACEBOOK ################################################
		if (user.services?.facebook) {
			user.profile = {
				name: user.services.facebook.name,
				email: user.services.facebook.email
			};
			if (!(await validateLoginFacebook(user))) return false;
		} else if (user.services?.google) {
			// ################################ GOOGLE ################################################
			user.profile = {
				name: user.services.google.name,
				email: user.services.google.email
			};
			if (!(await validateLoginGoogle(user))) return false;
		} else if (!user.emails || !user.emails[0].verified) {
			throw new Meteor.Error('Email ñao verificado', `Este email ainda não foi verificado!`);
		}

		const profile = await userprofileServerApi.getCollectionInstance().findOneAsync(getUserProfileSelector(user), {
			fields: { _id: 1, status: 1 }
		});
		if (!profile) {
			throw new Meteor.Error('profile-not-found', 'Não existe um perfil vinculado a esta conta.');
		}
		if (profile.status === 'disabled') {
			throw new Meteor.Error('user-disabled', 'Este usuário está desativado.');
		}
		return true;
	});
});
