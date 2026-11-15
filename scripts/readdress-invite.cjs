const { readFileSync } = require('node:fs');
const { readdressInvitation } = require('../desktop/link.cjs');

try {
  const original = readFileSync(0, 'utf8');
  process.stdout.write(readdressInvitation(original, process.argv[2]) + '\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
