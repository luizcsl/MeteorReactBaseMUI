/* This is real browser rendering/interaction with a controlled remote adapter, NOT DDP E2E. */
const data = (title, extra = {}) => ({ title, quantity: 1, active: false, category: 'general', note: null, ...extra });
const row = (id, title, extra = {}) => ({
	id,
	version: 1,
	parentId: null,
	state: 'draft',
	data: data(title),
	...extra
});
const form = () => cy.get('form[aria-label="browserrecipes form"]');
const save = () => form().contains('button', /^Save$/);
// Re-query after React replaces a scoped form; actions require a jQuery subject, not a raw DOM snapshot.
Cypress.Commands.addQuery('controlForLabel', function (label) {
	return (document) => {
		const element = [...document.querySelectorAll('label')].find(
			(item) => item.textContent.replace(/\s*\*$/, '').trim() === label
		);
		const control = element?.control ?? document.getElementById(element?.getAttribute('for'));
		return Cypress.$(control ?? []);
	};
});
const field = (label) => cy.document().controlForLabel(label);
const choose = (label, value) => {
	field(label).click();
	cy.get('[role="listbox"]')
		.contains('[role="option"]', new RegExp(`^${value}$`))
		.click();
};
const mount = (options = {}) => {
	cy.window().then((window) => {
		const generation = window.recipeFixture.reset(options);
		cy.get('main').should('have.attr', 'data-fixture-generation', String(generation));
	});
	form().should('be.visible');
};
const calls = (method, count) =>
	cy
		.window()
		.should((window) => {
			expect(
				window.recipeFixture.calls.filter((call) => call.method === method),
				`${method} call count`
			).to.have.length(count);
		})
		.then((window) => window.recipeFixture.calls.filter((call) => call.method === method));
const held = (method, operation, index = 0) =>
	cy
		.window()
		.should((window) => {
			expect(
				window.recipeFixture.calls.filter((call) => call.method === method && call.status === 'pending').length
			).to.be.greaterThan(index);
		})
		.then((window) => {
			const call = window.recipeFixture.calls.filter((call) => call.method === method && call.status === 'pending')[
				index
			];
			operation(window.recipeFixture, call);
		});
const release = (method, index = 0) => held(method, (fixture, call) => fixture.release(call.id), index);

describe('schema-driven recipe UI with a controlled remote client', () => {
	beforeEach(() => {
		cy.visit('/');
		cy.window().its('recipeFixture').should('exist');
	});

	it('renders accessible schema controls and rejects invalid values before a remote write', () => {
		mount();
		field('Title').should((input) => {
			expect(input).to.have.attr('required');
			expect(input).to.have.attr('maxlength', '40');
		});
		field('Quantity').should((input) => {
			expect(input).to.have.attr('type', 'number');
			expect(input).to.have.attr('min', '1');
			expect(input).to.have.attr('max', '5');
			expect(input).to.have.attr('step', '1');
		});
		field('Category').should('have.attr', 'role', 'combobox');
		cy.contains('label', /^Active$/)
			.find('input')
			.should('have.attr', 'type', 'checkbox');
		field('Note').should((input) => {
			expect(input).not.to.have.attr('required');
			expect(input).to.have.attr('maxlength', '60');
		});
		save().click();
		calls('create', 0);
		field('Title').type('   ');
		form().submit(); // Bypass native validation to exercise the shared strict parser too.
		form().find('[role="alert"]').should('contain.text', 'Unable to save');
		calls('create', 0);
		field('Title').clear().type('Valid title');
		field('Quantity').clear();
		field('Quantity').should('have.value', '');
		form().submit();
		form().find('[role="alert"]').should('contain.text', 'Unable to save');
		calls('create', 0);
		field('Quantity').type('2.5');
		form().submit();
		form().find('[role="alert"]').should('contain.text', 'Unable to save');
		calls('create', 0);
		field('Quantity').clear().type('6');
		form().submit();
		form().find('[role="alert"]').should('contain.text', 'Unable to save');
		calls('create', 0);
	});

	it('shows loading, empty and remote error states and recovers with Refresh', () => {
		mount({ hold: ['list'] });
		cy.get('[aria-label="Loading records"]').should('be.visible');
		cy.contains('No records found.').should('not.exist');
		cy.contains('button', /^Refresh$/).should('be.disabled');
		held('list', (fixture, call) => fixture.reject(call.id));
		cy.get('[role="alert"]').should('contain.text', 'Unable to load records');
		cy.get('[aria-label="Loading records"]').should('not.exist');
		cy.window().then((window) => window.recipeFixture.hold('list', false));
		cy.contains('button', /^Refresh$/).click();
		cy.contains('No records found.').should('be.visible');
		cy.get('[role="alert"]').should('not.exist');
		calls('list', 2);
	});

	it('creates typed schema data, blocks repeated pending submissions, and updates with a version', () => {
		mount({ rows: [row('existing', 'Existing')], hold: ['create', 'update'] });
		cy.get('article').should('have.length', 1);
		field('Title').type('New record');
		field('Quantity').clear();
		field('Quantity').should('have.value', '').type('3');
		field('Quantity').should('have.value', '3');
		cy.contains('label', /^Active$/)
			.click()
			.find('input')
			.should('be.checked');
		choose('Category', 'urgent');
		save().click();
		form().contains('button', 'Saving').should('be.disabled');
		field('Title').should('be.disabled');
		cy.get('article button').each((button) => cy.wrap(button).should('be.disabled'));
		form().submit();
		calls('create', 1).then(([call]) => {
			expect(call.args[0]).to.deep.equal(data('New record', { quantity: 3, active: true, category: 'urgent' }));
			expect(call.args[1]).to.equal(null);
			expect(call.args[2]).to.match(/^[0-9a-f-]{36}$/i);
		});
		release('create');
		cy.get('article').should('have.length', 2);
		cy.contains('article', 'Title: New record')
			.contains('button', /^Edit$/)
			.click();
		field('Title').should('have.value', 'New record').clear().type('Edited record');
		save().click();
		cy.contains('button', /^Cancel edit$/).should('be.disabled');
		cy.get('article button').each((button) => cy.wrap(button).should('be.disabled'));
		calls('update', 1).then(([call]) => {
			expect(call.args.slice(0, 2)).to.deep.equal(['created-1', 1]);
			expect(call.args[2].title).to.equal('Edited record');
		});
		release('update');
		cy.contains('article', 'Title: Edited record').should('be.visible');
		cy.contains('button', /^Cancel edit$/).should('not.exist');
		cy.window()
			.its('recipeFixture.rows')
			.then((rows) => expect(rows.find((item) => item.id === 'created-1').version).to.equal(2));
	});

	it('cancels edits without writing and discards unsaved values', () => {
		mount({ rows: [row('existing', 'Original')] });
		cy.contains('article', 'Original')
			.contains('button', /^Edit$/)
			.click();
		field('Title').clear().type('Unsaved');
		cy.contains('button', /^Cancel edit$/).click();
		field('Title').should('have.value', '');
		cy.contains('article', 'Title: Original').should('be.visible');
		calls('update', 0);
		cy.contains('article', 'Original')
			.contains('button', /^Edit$/)
			.click();
		field('Title').should('have.value', 'Original');
	});

	it('retains a create mutation ID on uncertain retry and replaces it after success', () => {
		mount({ hold: ['create'] });
		field('Title').type('Replay-safe');
		save().click();
		held('create', (fixture, call) => fixture.reject(call.id, true));
		form().find('[role="alert"]').should('be.visible');
		cy.window().its('recipeFixture.rows').should('have.length', 1);
		save().click();
		calls('create', 2).then(([first, retry]) => expect(retry.args[2]).to.equal(first.args[2]));
		release('create');
		cy.get('article').should('have.length', 1);
		field('Title').should('be.enabled').clear().type('Replay-safe');
		save().should('be.enabled').click();
		calls('create', 3).then(([first, , newWrite]) => expect(newWrite.args[2]).not.to.equal(first.args[2]));
		release('create');
		cy.get('article').should('have.length', 2);
	});

	it('uses a new create mutation ID if the user changes a failed request', () => {
		mount({ hold: ['create'] });
		field('Title').type('First attempt');
		save().click();
		held('create', (fixture, call) => fixture.reject(call.id));
		form().find('[role="alert"]').should('be.visible');
		field('Title').clear().type('Changed attempt');
		save().click();
		calls('create', 2).then(([first, second]) => expect(second.args[2]).not.to.equal(first.args[2]));
		release('create');
		cy.contains('article', 'Title: Changed attempt').should('be.visible');
		cy.get('article').should('have.length', 1);
	});

	it('ignores older filtered list successes after a newer query has completed', () => {
		mount({ rows: [row('a', 'A'), row('b', 'B')] });
		cy.get('article').should('have.length', 2);
		cy.window().then((window) => window.recipeFixture.hold('list'));
		field('Filter Title').type('A');
		calls('list', 2);
		field('Filter Title').clear().type('B');
		calls('list', 4);
		release('list', 2); // B completes ahead of A and the intervening empty filter.
		cy.get('article').should('have.length', 1).and('contain.text', 'Title: B');
		release('list', 0);
		release('list', 0);
		cy.get('article').should('have.length', 1).and('contain.text', 'Title: B');
		field('Filter Title').should('have.value', 'B');
	});

	it('ignores stale list failures after a newer query succeeds', () => {
		mount({ rows: [row('a', 'A'), row('b', 'B')] });
		cy.get('article').should('have.length', 2);
		cy.window().then((window) => window.recipeFixture.hold('list'));
		field('Filter Title').type('A');
		calls('list', 2);
		field('Filter Title').clear().type('B');
		calls('list', 4);
		release('list', 2);
		cy.contains('article', 'Title: B').should('be.visible');
		held('list', (fixture, call) => fixture.reject(call.id));
		held('list', (fixture, call) => fixture.reject(call.id));
		cy.get('[role="alert"]').should('not.exist');
		cy.get('article').should('have.length', 1).and('contain.text', 'Title: B');
	});

	it('sends typed exact-match filters and the bounded list limit', () => {
		mount({
			rows: [
				row('chosen', 'Chosen', { data: data('Chosen', { quantity: 2, active: true, category: 'urgent' }) }),
				row('other', 'Other')
			]
		});
		cy.get('article').should('have.length', 2);
		field('Filter Quantity').type('2');
		choose('Filter Active', 'true');
		choose('Filter Category', 'urgent');
		cy.get('article').should('have.length', 1).and('contain.text', 'Chosen');
		cy.window().then((window) => {
			const call = window.recipeFixture.calls.filter((call) => call.method === 'list').at(-1);
			expect(call.args).to.deep.equal([{ quantity: 2, active: true, category: 'urgent' }, 100, null]);
		});
		choose('Filter Category', 'All');
		choose('Filter Active', 'All');
		field('Filter Quantity').clear();
		cy.get('article').should('have.length', 2);
	});

	it('preserves the edit on a version conflict and loads fresh values after cancel and refresh', () => {
		mount({ rows: [row('conflict', 'Original')] });
		cy.contains('article', 'Original')
			.contains('button', /^Edit$/)
			.click();
		field('Title').clear().type('My edit');
		cy.window().then((window) => window.recipeFixture.change('conflict', data('Newer remote value')));
		save().click();
		form().find('[role="alert"]').should('contain.text', 'Unable to save');
		field('Title').should('have.value', 'My edit').and('be.enabled');
		calls('update', 1).then(([call]) => expect(call.status).to.equal('rejected'));
		cy.window()
			.its('recipeFixture.rows')
			.then((rows) => expect(rows[0].data.title).to.equal('Newer remote value'));
		cy.contains('button', /^Cancel edit$/).click();
		cy.contains('button', /^Refresh$/).click();
		cy.contains('article', 'Newer remote value')
			.contains('button', /^Edit$/)
			.click();
		field('Title').should('have.value', 'Newer remote value');
	});

	it('does not overwrite newer filter results when a pending save completes', () => {
		mount({ rows: [row('a', 'A'), row('b', 'B')], hold: ['update'] });
		cy.contains('article', 'Title: A')
			.contains('button', /^Edit$/)
			.click();
		field('Title').clear().type('A updated');
		save().click();
		calls('update', 1);
		field('Filter Title').type('B');
		cy.get('article').should('have.length', 1).and('contain.text', 'Title: B');
		release('update');
		save().should('be.enabled');
		cy.get('article').should('have.length', 1).and('contain.text', 'Title: B');
		field('Filter Title').should('have.value', 'B');
		calls('list', 2);
	});

	it('shows only current-state approval actions and handles rejection without optimistic approval', () => {
		mount({ profile: 'approval', rows: [row('approval', 'Review me')], hold: ['transition'] });
		cy.get('article')
			.contains('button', /^pending$/)
			.click();
		calls('transition', 1).then(([call]) => expect(call.args).to.deep.equal(['approval', 1, 'pending']));
		cy.get('article').should('contain.text', 'State: draft');
		cy.get('article button').each((button) => cy.wrap(button).should('be.disabled'));
		release('transition');
		cy.get('article').should('contain.text', 'State: pending');
		cy.get('article')
			.contains('button', /^pending$/)
			.should('not.exist');
		cy.get('article')
			.contains('button', /^approved$/)
			.click();
		held('transition', (fixture, call) => fixture.reject(call.id));
		cy.get('[role="alert"]').should('contain.text', 'Operation failed or record changed');
		cy.get('article').should('contain.text', 'State: pending');
		cy.get('article')
			.contains('button', /^approved$/)
			.should('be.enabled')
			.click();
		release('transition');
		cy.get('article').should('contain.text', 'State: approved');
		cy.get('article')
			.contains('button', /^approved$/)
			.should('not.exist');
		cy.get('article')
			.contains('button', /^rejected$/)
			.should('not.exist');
		calls('transition', 3).then(([, denied, retry]) => {
			expect(denied.args).to.deep.equal(['approval', 2, 'approved']);
			expect(retry.args).to.deep.equal(denied.args);
		});
	});

	it('keeps deletion pending and denied records visible, then removes a successful record', () => {
		mount({ rows: [row('remove-me', 'Remove me')], hold: ['remove'] });
		cy.get('article')
			.contains('button', /^Delete$/)
			.click();
		cy.get('article').should('have.length', 1);
		cy.get('article button').each((button) => cy.wrap(button).should('be.disabled'));
		held('remove', (fixture, call) => fixture.reject(call.id));
		cy.get('[role="alert"]').should('contain.text', 'Operation failed or record changed');
		cy.get('article')
			.contains('button', /^Delete$/)
			.should('be.enabled')
			.click();
		calls('remove', 2).then((calls) => calls.forEach((call) => expect(call.args).to.deep.equal(['remove-me', 1])));
		release('remove');
		cy.get('article').should('not.exist');
		cy.contains('No records found.').should('be.visible');
		cy.get('[role="alert"]').should('not.exist');
	});

	it('scopes master-detail lists and create calls to the selected parent and resets editing', () => {
		mount({
			profile: 'master-detail',
			rows: [row('a', 'Child A', { parentId: 'parent-a' }), row('b', 'Child B', { parentId: 'parent-b' })]
		});
		cy.get('article').should('have.length', 1).and('contain.text', 'Child A');
		cy.get('article')
			.contains('button', /^Edit$/)
			.click();
		field('Title').clear().type('Unsaved child A');
		cy.get('select[aria-label="Parent record"]').select('parent-b');
		cy.get('article').should('have.length', 1).and('contain.text', 'Child B');
		field('Title').should('have.value', '');
		cy.contains('button', /^Cancel edit$/).should('not.exist');
		field('Title').type('New child B');
		save().click();
		cy.get('article').should('have.length', 2);
		calls('create', 1).then(([call]) => expect(call.args[1]).to.equal('parent-b'));
		calls('update', 0);
		cy.get('select[aria-label="Parent record"]').select('parent-a');
		cy.get('article').should('have.length', 1).and('contain.text', 'Child A');
		cy.window().then((window) => {
			const call = window.recipeFixture.calls.filter((call) => call.method === 'list').at(-1);
			expect(call.args[2]).to.equal('parent-a');
		});
	});

	it('ignores an old parent list and a successful old parent save after switching', () => {
		mount({
			profile: 'master-detail',
			rows: [row('a', 'Child A', { parentId: 'parent-a' }), row('b', 'Child B', { parentId: 'parent-b' })],
			hold: ['update']
		});
		cy.get('article')
			.contains('button', /^Edit$/)
			.click();
		field('Title').clear().type('Changed child A');
		save().click();
		calls('update', 1);
		cy.window().then((window) => window.recipeFixture.hold('list'));
		cy.get('select[aria-label="Parent record"]').select('parent-b');
		cy.get('[aria-label="Loading records"]').should('be.visible');
		cy.get('article').should('not.exist');
		release('list');
		cy.get('article').should('have.length', 1).and('contain.text', 'Child B');
		release('update');
		save().should('be.enabled');
		cy.get('article').should('have.length', 1).and('contain.text', 'Child B');
		calls('list', 2);
		// A separate out-of-order parent list must also never replace the new parent's rows.
		cy.get('select[aria-label="Parent record"]').select('parent-a');
		calls('list', 3);
		cy.get('select[aria-label="Parent record"]').select('parent-b');
		calls('list', 4);
		release('list', 1);
		cy.contains('article', 'Child B').should('be.visible');
		release('list');
		cy.get('article').should('have.length', 1).and('contain.text', 'Child B');
	});

	it('does not surface a denied old-parent action as an error on the new parent', () => {
		mount({
			profile: 'master-detail',
			rows: [row('a', 'Child A', { parentId: 'parent-a' }), row('b', 'Child B', { parentId: 'parent-b' })],
			hold: ['remove']
		});
		cy.get('article')
			.contains('button', /^Delete$/)
			.click();
		calls('remove', 1);
		cy.get('select[aria-label="Parent record"]').select('parent-b');
		cy.contains('article', 'Child B').should('be.visible');
		held('remove', (fixture, call) => fixture.reject(call.id));
		cy.contains('button', /^Refresh$/).should('be.enabled');
		cy.get('[role="alert"]').should('not.exist');
		cy.get('article').should('have.length', 1).and('contain.text', 'Child B');
	});

	it('clears private edits on client changes and ignores an old-client save completion', () => {
		mount({ rows: [row('old', 'Private old account')], hold: ['update'] });
		cy.contains('article', 'Private old account')
			.contains('button', /^Edit$/)
			.click();
		field('Title').clear().type('Private pending edit');
		save().click();
		calls('update', 1);
		cy.window().then((window) => window.recipeFixture.switchClient({ rows: [row('new', 'New account record')] }));
		cy.contains('article', 'New account record').should('be.visible');
		cy.contains('Private old account').should('not.exist');
		cy.contains('button', /^Cancel edit$/).should('not.exist');
		field('Title').should('have.value', '').and('be.enabled').type('New account draft');
		cy.window().then((window) => {
			const pending = window.recipeFixture.previousCalls.find((call) => call.method === 'update');
			window.recipeFixture.releasePrevious(pending.id);
		});
		field('Title').should('have.value', 'New account draft');
		cy.get('article').should('have.length', 1).and('contain.text', 'New account record');
		calls('list', 1);
		calls('update', 0);
		cy.window().should((window) =>
			expect(window.recipeFixture.previousCalls.filter((call) => call.method === 'list')).to.have.length(1)
		);
	});

	it('does not reuse another client’s uncertain create receipt', () => {
		mount({ hold: ['create'] });
		field('Title').type('Same business data');
		save().click();
		held('create', (fixture, call) => fixture.reject(call.id, true));
		form().find('[role="alert"]').should('be.visible');
		cy.window().then((window) => window.recipeFixture.switchClient({ hold: ['create'] }));
		field('Title').should('have.value', '').type('Same business data');
		form().find('[role="alert"]').should('not.exist');
		save().click();
		calls('create', 1).then(([current]) =>
			cy.window().then((window) => {
				const old = window.recipeFixture.previousCalls.find((call) => call.method === 'create');
				expect(current.args[2]).not.to.equal(old.args[2]);
			})
		);
		release('create');
		cy.get('article').should('have.length', 1);
	});

	it('resets edits for changed metadata but preserves them across equivalent new objects', () => {
		mount({ rows: [row('record', 'Original')] });
		cy.contains('article', 'Original')
			.contains('button', /^Edit$/)
			.click();
		field('Title').clear().type('Unsaved private edit');
		cy.window().then((window) => window.recipeFixture.rerender());
		field('Title').should('have.value', 'Unsaved private edit');
		calls('list', 1);
		cy.window().then((window) => window.recipeFixture.changeDefinition('approval'));
		field('Title').should('have.value', '');
		cy.contains('button', /^Cancel edit$/).should('not.exist');
		cy.get('article')
			.contains('button', /^pending$/)
			.should('be.visible');
		calls('list', 2);
	});
});
