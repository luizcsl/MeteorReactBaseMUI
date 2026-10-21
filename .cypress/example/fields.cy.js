// Invoke through the disposable Example runner; never reuse an application database.
const invoke = (name, input) =>
	cy
		.window()
		.then(
			(win) =>
				new Cypress.Promise((resolve, reject) =>
					win.Meteor.call('example.' + name, input, (error, value) => (error ? reject(error) : resolve(value)))
				)
		);
function choose(name, label) {
	cy.get('#' + name).click();
	cy.get('[role="listbox"]')
		.contains('[role="option"]', new RegExp('^' + label + '$'))
		.click();
}
function login() {
	cy.visit('/example');
	cy.window()
		.its('Meteor')
		.should('exist')
		.then(
			(Meteor) =>
				new Cypress.Promise((resolve, reject) =>
					Meteor.loginWithPassword(Cypress.env('TEST_USER_EMAIL'), Cypress.env('TEST_USER_PASSWORD'), (error) =>
						error ? reject(error) : resolve()
					)
				)
		);
	cy.contains('Lista de Itens').scrollIntoView().should('be.visible');
}
describe('Example field domain, UI and real persistence', () => {
	before(() => {
		expect(new URL(Cypress.config('baseUrl')).hostname).to.equal('127.0.0.1');
		expect(Cypress.env('EXAMPLE_FIXTURE')).to.equal(true);
		expect(Cypress.env('TEST_USER_EMAIL')).to.match(/@example\.test$/);
	});
	it('creates through the real form and retains the literal after detail/list reload and editing', () => {
		login();
		cy.contains('button', 'Adicionar').click();
		cy.contains('Adicionar Item').should('be.visible');
		cy.get('#title').type('Example UI field acceptance');
		choose('type', 'Categoria A');
		cy.contains('label', 'Alta').click();
		cy.contains('button', /^Salvar$/).click();
		cy.contains('Lista de Itens').scrollIntoView().should('be.visible');
		cy.contains('Operação realizada!').should('be.visible');
		cy.contains('Operação realizada!').should('not.exist');
		cy.get('[role="row"]')
			.contains('Example UI field acceptance')
			.parents('[role="row"]')
			.should('contain.text', 'Categoria A');
		// Read the stored literal over the actual publication, then open its detail on a fresh page.
		cy.window().then((win) => {
			const row = win.$app.api.example.find({ title: 'Example UI field acceptance' }).fetch()[0];
			expect(row.type).to.equal('Categoria A');
			cy.wrap(row._id).as('id');
		});
		cy.get('@id').then((id) => cy.visit('/example/view/' + id));
		cy.contains('Categoria').parent().should('contain.text', 'Categoria A');
		cy.reload();
		cy.contains('Categoria').parent().should('contain.text', 'Categoria A');
		cy.get('@id').then((id) => cy.visit('/example/edit/' + id));
		cy.get('#type').should('contain.text', 'Categoria A');
		choose('type', 'Categoria B');
		cy.contains('button', /^Salvar$/).click();
		cy.contains('Editar Item').should('not.exist');
		cy.get('@id').then((id) => cy.visit('/example/view/' + id));
		cy.contains('Categoria').parent().should('contain.text', 'Categoria B');
		cy.visit('/example');
		cy.reload();
		cy.get('[role="row"]')
			.contains('Example UI field acceptance')
			.parents('[role="row"]')
			.should('contain.text', 'Categoria B');
	});
	it('rejects malformed direct DDP values and keeps the prior value after browser reload', () => {
		login();
		const id = 'example-browser-negative';
		const base = { _id: id, title: 'Example negative acceptance', type: 'Categoria A', typeMulti: 'alta' };
		invoke('insert', base);
		for (const value of [null, '', 'invalid', {}, ['Categoria A']])
			cy.window().then(
				(win) =>
					new Cypress.Promise((resolve, reject) =>
						win.Meteor.call('example.update', { ...base, type: value }, (error) => {
							try {
								expect(error?.error).to.equal('invalid-field-value');
								resolve();
							} catch (failure) {
								reject(failure);
							}
						})
					)
			);
		cy.visit('/example/view/' + id);
		cy.contains('Categoria').parent().should('contain.text', 'Categoria A');
		cy.reload();
		cy.contains('Categoria').parent().should('contain.text', 'Categoria A');
		cy.visit('/example');
		cy.get('[role="row"]')
			.contains('Example negative acceptance')
			.parents('[role="row"]')
			.should('contain.text', 'Categoria A');
	});
});
