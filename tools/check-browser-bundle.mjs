/** Parse the real Meteor classic-script assets before browser qualification.
 * This is a syntax gate, not a replacement for browser execution.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const root = path.resolve(process.argv[2] || '.meteor/local/build/programs/web.browser');
const program = JSON.parse(fs.readFileSync(path.join(root, 'program.json'), 'utf8'));
const scripts = program.manifest.filter(asset => asset.type === 'js');
if (!scripts.length) throw new Error('No browser scripts found: refuse empty syntax qualification');
for (const asset of scripts) {
  const filename = path.resolve(root, asset.path);
  if (!filename.startsWith(root + path.sep)) throw new Error('Browser manifest asset escapes program root');
  try { new vm.Script(fs.readFileSync(filename, 'utf8'), { filename }); }
  catch (error) { throw new Error(`Invalid Meteor classic script ${asset.path}: ${error.message}`); }
}
console.log(`Parsed ${scripts.length} emitted Meteor browser scripts successfully.`);
