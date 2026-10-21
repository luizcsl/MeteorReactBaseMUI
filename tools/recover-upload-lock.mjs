#!/usr/bin/env node
// Run only during a maintenance window with ALL upload-serving processes stopped.
import { readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const lock = path.join(os.tmpdir(), 'boilerplate-example-uploads-v2', '.lock');
const args = process.argv.slice(2);
if (args.some((arg) => !['--apply', '--confirm-all-app-processes-stopped'].includes(arg))) throw new Error('Unknown option');
const info = await stat(lock).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
if (!info) { console.log('No stale upload lock.'); process.exit(0); }
const raw = await readFile(path.join(lock, 'owner.json'), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
const owner = raw ? JSON.parse(raw) : null;
console.log(JSON.stringify({ lock, owner, ageSeconds: Math.floor((Date.now() - info.mtimeMs) / 1000), mode: args.includes('--apply') ? 'apply' : 'dry-run' }));
if (!args.includes('--apply')) process.exit(0);
if (!args.includes('--confirm-all-app-processes-stopped')) throw new Error('Stop ALL app processes sharing this staging directory and confirm explicitly.');
if (owner && owner.hostname !== os.hostname()) throw new Error('Recover this lock on the originating host after stopping all shared-volume writers.');
if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
 try { process.kill(owner.pid, 0); throw new Error('Lock owner PID is still alive; refusing recovery.'); }
 catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const latest = await stat(lock);
if (latest.ino !== info.ino || latest.mtimeMs !== info.mtimeMs || (await readFile(path.join(lock, 'owner.json'), 'utf8').catch(() => null)) !== raw) throw new Error('Lock changed during inspection; refusing recovery.');
await rm(lock, { recursive: true });
console.log('Stale lock removed. No upload data was removed. Restart the app.');
