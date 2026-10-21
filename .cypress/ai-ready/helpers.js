// Native Cypress helpers. Never log credentials or run against a non-loopback app.
export function syntheticCredentials() {
  const base = new URL(Cypress.config('baseUrl'));
  expect(['localhost', '127.0.0.1', '[::1]'], 'disposable loopback application').to.include(base.hostname);
  const email = Cypress.env('TEST_USER_EMAIL');
  const password = Cypress.env('TEST_USER_PASSWORD');
  expect(email, 'synthetic bootstrap email').to.match(/@example\.test$/);
  expect(typeof password, 'synthetic bootstrap password type').to.equal('string');
  expect(password.length, 'synthetic bootstrap password length').to.be.at.least(14);
  return { email, password };
}
export function loginWithForm() {
  const { email, password } = syntheticCredentials();
  cy.visit('/signin');
  cy.get('input[name="email"]').clear().type(email);
  cy.get('input[name="password"]').clear({ log: false }).type(password, { log: false });
  cy.contains('button', /^Entrar$/).click();
  cy.window().should(win => expect(win.Meteor.userId(), 'authenticated account').to.be.a('string'));
  // Wait for active profile subscription, not merely the login callback.
  cy.contains('Acesse o sistema').should('not.exist');
}
export function expectMethodDenied(name, args, code) {
  return cy.window().then(win => new Cypress.Promise((resolve, reject) => {
    win.Meteor.call(name, ...args, (error, result) => {
      try {
        expect(error, `${name} rejected`).to.exist;
        expect(error.error, `${name} error code`).to.equal(code);
        expect(result, 'no private result on denial').to.equal(undefined);
        resolve();
      } catch (failure) { reject(failure); }
    });
  }));
}
