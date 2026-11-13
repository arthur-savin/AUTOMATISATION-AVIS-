import 'dotenv/config';
import { insertEstablishment, openDatabase } from '../db.js';

function args(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[name] = true;
      continue;
    }
    out[name] = next;
    i += 1;
  }
  return out;
}

const flags = args(process.argv);
if (!flags.name || !flags.phone) {
  console.error('Usage : node scripts/add-establishment.js --name "Chez Marco" --phone 33612345678 [--account 123] [--location 456] [--city Lyon] [--type restaurant] [--contact "01 23 45 67 89"] [--limit 10]');
  process.exit(1);
}

const db = openDatabase();
const tokens = flags['use-env-token'] && process.env.GOOGLE_REFRESH_TOKEN
  ? { refresh_token: process.env.GOOGLE_REFRESH_TOKEN }
  : null;

const establishment = insertEstablishment(db, {
  name: flags.name,
  ownerPhone: flags.phone,
  googleAccountId: flags.account || null,
  locationId: flags.location || null,
  city: flags.city || '',
  type: flags.type || 'restaurant',
  contact: flags.contact || '',
  dailyLimit: flags.limit ? Number(flags.limit) : undefined,
  googleTokens: tokens
});

console.log(JSON.stringify({
  id: establishment.id,
  name: establishment.name,
  owner_phone: establishment.owner_phone,
  location_id: establishment.location_id
}, null, 2));
