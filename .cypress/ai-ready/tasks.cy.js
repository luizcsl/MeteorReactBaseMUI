import { syntheticCredentials } from './helpers';
// Synthetic isolated account only. The runner must bootstrap it in its disposable DB.
describe('canonical owner CRUD in the real browser', () => {
  it('authenticates, creates, edits, completes and deletes a task', () => {
    const { email, password } = syntheticCredentials();
    cy.visit('/');
    cy.window().its('Meteor').should('exist').then(Meteor => new Cypress.Promise((resolve, reject) => {
      Meteor.loginWithPassword(email, password, error => error ? reject(error) : resolve());
    }));
    cy.visit('/tasks');
    cy.contains('h1', 'Tarefas').should('be.visible');
    const title = `Smoke ${Date.now()}`;
    cy.get('input').filter('[maxlength="200"]').first().type(title);
    cy.contains('button', /^Criar$/).click();
    cy.contains('button', `${title} (aberta)`).click();
    cy.get('[role="dialog"]').within(() => {
      cy.get('input').clear().type(`${title} updated`);
      cy.contains('button', /^Salvar$/).click();
    });
    cy.contains('button', `${title} updated (aberta)`).click();
    cy.get('[role="dialog"]').contains('button', /^Concluir$/).click();
    cy.contains('button', `${title} updated (concluída)`).should('be.visible');
    cy.get(`button[aria-label="Excluir ${title} updated"]`).click();
    cy.get('[role="dialog"]').contains('button', /^Excluir$/).click();
    cy.contains('button', `${title} updated (concluída)`).should('not.exist');
  });
});
