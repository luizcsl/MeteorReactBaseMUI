import { expectMethodDenied, loginWithForm, syntheticCredentials } from './helpers';

describe('authentication and profile security through the browser', () => {
  beforeEach(() => { syntheticCredentials(); });

  it('guards task and profile pages before login and rejects forged public-user privileges', () => {
    cy.visit('/tasks');
    cy.contains('Acesse o sistema').should('be.visible');
    cy.contains('h1', 'Tarefas').should('not.exist');
    expectMethodDenied('tasks.list', [{ after: null, limit: 5 }], 'unauthenticated');
    expectMethodDenied('tasks.list', [{ after: null, limit: 5 }, { userId: 'synthetic-admin', roles: ['Administrador'] }], 'invalid-input');
    expectMethodDenied('userprofile.exportCollection', [{ user: { roles: ['Administrador'] } }], 'invalid-arguments');
    cy.visit('/userprofile');
    cy.contains('Acesse o sistema').should('be.visible');
    cy.contains('Lista de usuários').should('not.exist');
  });

  it('shows invalid-credential feedback without creating a session', () => {
    const { email } = syntheticCredentials();
    cy.visit('/signin');
    cy.get('input[name="email"]').type(email);
    cy.get('input[name="password"]').type('Synthetic-wrong-password-2026', { log: false });
    cy.contains('button', /^Entrar$/).click();
    cy.contains('Email ou senha inválidos').should('be.visible');
    cy.window().should(win => expect(win.Meteor.userId()).to.equal(null));
    cy.contains('Acesse o sistema').should('be.visible');
  });

  it('signs in through the form, opens the admin profile and preserves immutable email', () => {
    const { email } = syntheticCredentials();
    loginWithForm();
    cy.visit('/userprofile');
    cy.contains('Lista de usuários').should('be.visible');
    // CI bootstrap is the sole account. Scope the edit action to its actual card.
    cy.contains('p', email).parent().within(() => {
      cy.get('button[aria-label="Editar"]').click();
    });
    cy.get('[role="dialog"]').within(() => {
      cy.contains('Editar usuário').should('be.visible');
      cy.get('input[name="email"]').should('have.value', email).and('be.disabled');
      cy.get('input[name="username"]').should('not.have.value', '');
      cy.contains('button', /^Cancelar$/).click();
    });
    cy.get('[role="dialog"]').should('not.exist');
  });

  it('routes profile edit/view to profile fields rather than the example module', () => {
    const { email } = syntheticCredentials();
    loginWithForm();
    cy.window().then(win => { cy.visit(`/userprofile/edit/${win.Meteor.userId()}`); });
    cy.contains('Editar usuário').should('be.visible');
    cy.get('input[name="username"]').should('be.visible');
    cy.get('input[name="email"]').should('have.value', email).and('be.disabled');
    cy.contains('button', /^Cancelar$/).click();
    cy.location('pathname').should('equal', '/userprofile');
    cy.window().then(win => { cy.visit(`/userprofile/view/${win.Meteor.userId()}`); });
    cy.contains('Visualizar usuário').should('be.visible');
    cy.contains('button', /^Salvar$/).should('not.exist');
    cy.contains('button', /^Cancelar$/).click();
    cy.contains('Lista de usuários').should('be.visible');
  });

  it('rejects account binding and email rewrites even from the synthetic admin', () => {
    loginWithForm();
    cy.window().then(win => {
      const id = win.Meteor.userId(); // Bootstrap deliberately uses equal account/profile IDs.
      expectMethodDenied('userprofile.update', [{ _id: id, accountId: 'forged-account' }], 'not-authorized');
      expectMethodDenied('userprofile.update', [{ _id: id, otheraccounts: [{ _id: 'forged-account' }] }], 'not-authorized');
      expectMethodDenied('userprofile.update', [{ _id: id, email: 'changed@example.test' }], 'email-change-not-supported');
    });
    cy.visit('/userprofile');
    cy.contains(syntheticCredentials().email).should('be.visible');
  });

  it('logs out through the user menu and removes access to protected pages and methods', () => {
    loginWithForm();
    cy.visit('/tasks');
    cy.contains('h1', 'Tarefas').should('be.visible');
    // Existing avatar has no accessible button label; use the stable MUI slot,
    // not an emotion hash. This selector is documented until avatar accessibility improves.
    cy.get('.MuiAvatar-root').filter(':visible').first().click();
    cy.get('.MuiMenu-root').contains('p', /^Sair$/).click();
    cy.window().should(win => expect(win.Meteor.userId()).to.equal(null));
    cy.contains('Acesse o sistema').should('be.visible');
    expectMethodDenied('tasks.list', [{ after: null, limit: 5 }], 'unauthenticated');
    cy.visit('/tasks');
    cy.contains('h1', 'Tarefas').should('not.exist');
    cy.contains('Acesse o sistema').should('be.visible');
    cy.visit('/userprofile');
    cy.contains('Lista de usuários').should('not.exist');
  });
});
