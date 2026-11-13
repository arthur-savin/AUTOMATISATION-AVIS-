import { logError } from '../util.js';
import { ProviderError } from './errors.js';
import { reviewIdOf } from './normalize.js';

const SCAN_MESSAGE = 'Le fournisseur webhook ne sait pas lire les avis Google. Le scan initial est impossible : passez GOOGLE_PROVIDER=api, ou importez les avis un par un via POST /new-review.';

export function createWebhookProvider({
  fetchImpl = fetch,
  webhookUrl = process.env.PUBLISH_WEBHOOK_URL
} = {}) {
  return {
    kind: 'webhook',

    async listReviews() {
      throw new ProviderError('SCAN_UNSUPPORTED', SCAN_MESSAGE);
    },

    async getReview() {
      throw new ProviderError('READ_UNSUPPORTED', 'Le fournisseur webhook ne peut pas relire un avis Google.');
    },

    async getReplyState() {
      return { supported: false, state: null, policyViolation: null, hasReply: null, comment: null };
    },

    async replyToReview(establishment, reviewId, comment) {
      const url = webhookUrl || process.env.PUBLISH_WEBHOOK_URL;
      const context = { establishmentId: establishment.id, reviewId: reviewIdOf(reviewId) };
      if (!url) {
        const error = new ProviderError('CONFIG', 'PUBLISH_WEBHOOK_URL manquant');
        logError('google', error, context);
        throw error;
      }
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'publish_reply',
          establishmentId: establishment.id,
          accountId: establishment.google_account_id || null,
          locationId: establishment.location_id || null,
          reviewId: context.reviewId,
          comment
        }),
        signal: AbortSignal.timeout(20000)
      });
      const raw = await response.text();
      if (!response.ok) {
        const error = new ProviderError('HTTP', `Webhook publication HTTP ${response.status} : ${raw.slice(0, 300)}`);
        logError('google', error, context);
        throw error;
      }
      return { ok: true };
    }
  };
}
