import { defineConfig } from 'cypress';
export default defineConfig({
	video: false,
	screenshotsFolder: '.cypress/screenshots/example',
	e2e: {
		baseUrl: 'http://127.0.0.1:3210',
		specPattern: '.cypress/example/fields.cy.js',
		supportFile: false,
		defaultCommandTimeout: 20000
	}
});
