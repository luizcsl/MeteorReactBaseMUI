# Historical Gherkin scenarios

The old `.cypress/integration/**/*.feature` and support step definitions are retained as migration reference only. Several describe an unrelated simulated-company site and were not an executable qualification suite for this boilerplate. They are not loaded by either Cypress config.

The maintained browser qualification is `.cypress/ai-ready/tasks.cy.js`. Recreate any needed historical scenario as a deterministic Cypress `.cy.js` spec using synthetic accounts and explicit assertions, then review it before inclusion. Do not reinstall the retired Cucumber preprocessing stack automatically: its discovery dependency chain had an unpatched high-severity braces advisory on 2026-10-21. Removing this unused runner does not establish coverage of historical scenarios.
