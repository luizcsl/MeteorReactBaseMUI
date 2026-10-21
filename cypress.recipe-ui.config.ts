import { defineConfig } from 'cypress';

export default defineConfig({
	video: false,
	screenshotsFolder: '.cypress/screenshots/recipe-ui',
	viewportWidth: 1280,
	viewportHeight: 1000,
	e2e: {
		// The harness replaces this with its ephemeral loopback listener.
		baseUrl: 'http://127.0.0.1:4173',
		specPattern: '.cypress/recipe-ui/**/*.cy.js',
		supportFile: false,
		defaultCommandTimeout: 10000
	}
});
