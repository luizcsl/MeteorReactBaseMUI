// Run only through tools/verify-request-journey.mjs against its disposable app/database.
const method = (name, input) =>
	cy
		.window()
		.then(
			(win) =>
				new Cypress.Promise((resolve, reject) =>
					win.Meteor.call('requests.' + name, input, (error, result) => (error ? reject(error) : resolve(result)))
				)
		);
const denied = (name, input, code) =>
	cy.window().then(
		(win) =>
			new Cypress.Promise((resolve, reject) =>
				win.Meteor.call('requests.' + name, input, (error, result) => {
					try {
						expect(error?.error).to.equal(code);
						expect(result).to.equal(undefined);
						resolve();
					} catch (e) {
						reject(e);
					}
				})
			)
	);
function login(actor) {
	cy.visit('/requests');
	cy.window()
		.its('Meteor')
		.should('exist')
		.then(
			(Meteor) =>
				new Cypress.Promise((resolve, reject) =>
					Meteor.logout(() =>
						Meteor.loginWithPassword(Cypress.env(actor + 'Email'), Cypress.env('journeyPassword'), (error) =>
							error ? reject(error) : resolve()
						)
					)
				)
		);
	cy.contains('h1', 'Solicitações').should('be.visible');
	cy.get('[aria-label="Carregando solicitações"]').should('not.exist');
}
describe('request → items → separate approval → history over real browser/DDP/Mongo', () => {
	before(() => {
		expect(new URL(Cypress.config('baseUrl')).hostname).to.equal('127.0.0.1');
		expect(Cypress.env('disposableJourney')).to.equal(true);
	});
	it('persists a complete journey across requester/reviewer sessions and reload', () => {
		login('requester');
		cy.get('input').filter('[maxlength="200"]').first().type('Browser office supplies');
		cy.contains('button', /^Criar solicitação$/).click();
		cy.get('section[aria-label="Detalhes da solicitação"]').within(() => {
			cy.get('input').filter('[maxlength="200"]').type('Paper');
			cy.get('input[type="number"]').clear().type('2');
			cy.get('input[inputmode="decimal"]').type('10.10');
			cy.contains('button', /^Adicionar item$/).click();
			cy.contains('Total: BRL 20.20').should('be.visible');
			cy.contains('button', /^Enviar para aprovação$/).click();
			cy.contains('Status: Enviada').should('be.visible');
		});
		method('list', { limit: 100 }).then((rows) => {
			const row = rows.find((row) => row.title === 'Browser office supplies');
			expect(row.version).to.equal(3);
			return denied('decide', { id: row.id, version: row.version, decision: 'approved' }, 'forbidden');
		});
		login('reviewer');
		cy.contains('button', 'Browser office supplies').click();
		cy.contains('button', /^Aprovar$/).click();
		cy.contains('Status: Aprovada').should('be.visible');
		cy.reload();
		cy.contains('button', 'Browser office supplies').click();
		cy.get('[aria-label="Histórico da solicitação"] li')
			.should('have.length', 4)
			.last()
			.should('contain.text', 'Aprovada');
		login('requester');
		cy.contains('button', 'Browser office supplies').click();
		cy.contains('Status: Aprovada').should('be.visible');
		cy.contains('Total: BRL 20.20').should('be.visible');
		cy.contains('button', /^Adicionar item$/).should('not.exist');
		method('list', { limit: 100 }).then((rows) => {
			const row = rows.find((row) => row.title === 'Browser office supplies');
			return denied(
				'addItem',
				{ id: row.id, version: row.version, item: { description: 'Frozen', quantity: 1, unitPrice: 1 } },
				'forbidden'
			);
		});
	});
	it('denies an unrelated account and detects a stale item edit in the interface', () => {
		login('requester');
		method('create', { title: 'Browser concurrent edit', mutationId: 'browser-cas' }).then((row) => {
			cy.contains('button', /^Atualizar solicitações$/).click();
			cy.contains('button', 'Browser concurrent edit').click();
			method('addItem', {
				id: row.id,
				version: 1,
				item: { description: 'Concurrent item', quantity: 1, unitPrice: 100 }
			});
			cy.get('section').within(() => {
				cy.get('input').filter('[maxlength="200"]').type('Stale item');
				cy.get('input[inputmode="decimal"]').type('1.00');
				cy.contains('button', /^Adicionar item$/).click();
			});
			cy.get('[role="alert"]').should('contain.text', 'A solicitação mudou');
			cy.contains('button', /^Atualizar solicitações$/).click();
			cy.contains('Versão 2').should('be.visible');
			method('get', { id: row.id }).then((current) => expect(current.items).to.have.length(1));
			login('outsider');
			denied('get', { id: row.id }, 'not-found');
			method('list', { limit: 100 }).then((rows) => expect(rows).to.deep.equal([]));
		});
	});
});
