import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '../..');
test('Meteor router adapter retains public type API and selects upstream CommonJS build', () => {
  const source = fs.readFileSync(path.join(root, 'imports/libs/router.ts'), 'utf8');
  assert.match(source, /import type \* as RouterApi from 'react-router'/);
  assert.match(source, /require\('react-router\/dist\/development\/index.js'\)/);
  const filename = path.join(root, 'node_modules/react-router/dist/development/index.js');
  new vm.Script(fs.readFileSync(filename, 'utf8'));
  const router = require(filename);
  for (const key of ['BrowserRouter', 'Route', 'Routes', 'Link', 'MemoryRouter', 'useLocation', 'useNavigate', 'useParams']) assert.ok(router[key], `Missing public router export ${key}`);
});
test('application runtime imports route through the compatibility adapter', () => {
  const inspect = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(filename);
      else if (/\.tsx?$/.test(entry.name) && filename !== path.join(root, 'imports/libs/router.ts')) {
        assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /from ['"]react-router['"]/, filename);
      }
    }
  };
  inspect(path.join(root, 'imports'));
});
