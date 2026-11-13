import { createGbpApiProvider } from './gbp-api.js';
import { createWebhookProvider } from './webhook.js';

export function createGoogleProvider(options = {}) {
  const kind = String(options.kind || process.env.GOOGLE_PROVIDER || 'api').toLowerCase();
  if (kind === 'webhook') return createWebhookProvider(options);
  if (kind === 'api') return createGbpApiProvider(options);
  throw new Error(`GOOGLE_PROVIDER inconnu : ${kind}. Valeurs acceptées : api, webhook.`);
}

export { ProviderError } from './errors.js';
export { normalizeGoogleReview, reviewIdOf, locationIdOf, accountIdOf } from './normalize.js';
