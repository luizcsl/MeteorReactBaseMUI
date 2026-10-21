import { defineConfig } from 'cypress';
export default defineConfig({
  video: false,
  screenshotsFolder: '.cypress/screenshots',
  e2e: {
    baseUrl: process.env.CYPRESS_BASE_URL || 'http://127.0.0.1:3200',
    specPattern: '.cypress/ai-ready/**/*.cy.js',
    supportFile: false,
    defaultCommandTimeout: 20000
  }
});
