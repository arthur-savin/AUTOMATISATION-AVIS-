import 'dotenv/config';
import { createDeps } from '../deps.js';
import { runOnboarding } from '../queue.js';
import { logError } from '../util.js';

function establishmentId(argv) {
  const index = argv.indexOf('--establishment');
  const value = index === -1 ? null : argv[index + 1];
  if (!value || Number.isNaN(Number(value))) {
    console.error('Usage : node scripts/onboard.js --establishment <id>');
    process.exit(1);
  }
  return Number(value);
}

const id = establishmentId(process.argv);
const deps = createDeps();

try {
  const result = await runOnboarding(deps, id);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  logError('onboard', error, { establishmentId: id });
  process.exit(1);
}
