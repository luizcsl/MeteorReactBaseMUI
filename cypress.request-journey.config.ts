import { defineConfig } from 'cypress';
export default defineConfig({
	video: false,
	screenshotsFolder: '.cypress/screenshots/request-journey',
	e2e: {
		baseUrl: 'http://127.0.0.1:3208',
		specPattern: '.cypress/request-journey/**/*.cy.js',
		supportFile: false,
		defaultCommandTimeout: 20000
	}
});
