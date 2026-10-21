import { loginWithForm, syntheticCredentials } from './helpers';

describe('password recovery and reset without external email', () => {
  beforeEach(() => { syntheticCredentials(); });

  it('opens recovery from login and returns without submitting an email', () => {
    cy.visit('/signin');
    cy.contains('button', 'Esqueci minha senha').click();
    cy.location('pathname').should('equal', '/password-recovery');
    cy.contains('Esqueceu sua senha?').should('be.visible');
    cy.get('input[name="email"]').should('have.attr', 'type', 'email');
    // Never click Confirmar here: no email delivery is authorized or configured.
    cy.contains('button', /^Cancelar$/).filter(':visible').click();
    cy.contains('Acesse o sistema').should('be.visible');
    cy.window().should(win => expect(win.Meteor.userId()).to.equal(null));
  });

  it('rejects mismatched reset passwords and keeps both fields editable', () => {
    cy.visit('/reset-password/synthetic-invalid-token');
    cy.contains('Redefinição de senha').should('be.visible');
    cy.get('input[name="password"]').type('Synthetic-new-password-2026', { log: false });
    cy.get('input[name="repassword"]').type('Synthetic-mismatch-password-2026', { log: false });
    cy.contains('button', /^Confirmar$/).click();
    cy.contains('As senhas não conferem!').should('be.visible');
    cy.get('input[name="password"]').should('not.be.disabled');
    cy.get('input[name="repassword"]').should('not.be.disabled');
    cy.window().should(win => expect(win.Meteor.userId()).to.equal(null));
  });

  it('rejects an invalid reset token without changing the synthetic account password', () => {
    cy.visit('/reset-password/synthetic-invalid-token');
    cy.get('input[name="password"]').type('Synthetic-new-password-2026', { log: false });
    cy.get('input[name="repassword"]').type('Synthetic-new-password-2026', { log: false });
    cy.contains('button', /^Confirmar$/).click();
    cy.contains('Não foi possível atualizar a sua senha').should('be.visible');
    cy.get('input[name="password"]').should('not.be.disabled');
    cy.window().should(win => expect(win.Meteor.userId()).to.equal(null));
    loginWithForm();
  });
});
