// Answer codes hidden in the working fixtures. Read by fixtures.mjs and grade.mjs only; never shown
// to the agent. They live in the gitignored bench-runs/ (created on first use), not in the repo,
// so a public copy of this file cannot leak them to an agent that searches the web.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bench-runs/robustness/codes.json');
const IDS = ['plain', 'slow-35s', 'flaky-first', 'pagination-6', 'heavy-dom', 'long-flow'];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const pick = n => Array.from(crypto.randomBytes(n), b => ALPHABET[b % ALPHABET.length]).join('');

if (!fs.existsSync(FILE)) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(IDS.map(id => [id, `${pick(2)}-${pick(4)}`])), null, 1) + '\n');
}
export const CODES = JSON.parse(fs.readFileSync(FILE, 'utf8'));
