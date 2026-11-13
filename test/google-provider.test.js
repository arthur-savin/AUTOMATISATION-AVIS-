import { describe, expect, it } from 'vitest';
import { createGbpApiProvider } from '../google/gbp-api.js';
import { createGoogleProvider } from '../google/index.js';
import { normalizeGoogleReview } from '../google/normalize.js';
import { createWebhookProvider } from '../google/webhook.js';

const establishment = {
  id: 7,
  google_account_id: 'accounts/999',
  location_id: 'locations/888',
  google_tokens: JSON.stringify({ refresh_token: 'refresh-token' })
};

describe('fournisseurs Google', () => {
  it('pagine les avis par 50 et publie la réponse', async () => {
    const calls = [];
    const pages = [
      {
        reviews: [{
          reviewId: 'a',
          starRating: 'FIVE',
          comment: '(Translated by Google) Great\n\n(Original)\nSuper cadre',
          createTime: '2024-01-01T00:00:00.000Z',
          reviewer: { displayName: 'Lina' }
        }],
        nextPageToken: 't2'
      },
      {
        reviews: [{
          reviewId: 'b',
          starRating: 'ONE',
          comment: 'Mauvais',
          createTime: '2024-02-01T00:00:00.000Z',
          reviewer: { displayName: 'Paul' },
          reviewReply: { comment: 'Désolé' }
        }]
      }
    ];
    let page = 0;
    const provider = createGbpApiProvider({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: async (url, options = {}) => {
        calls.push({ url: String(url), method: options.method, body: options.body ? String(options.body) : '' });
        if (String(url).includes('oauth2.googleapis.com')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }) };
        }
        if (String(url).endsWith('/reply')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ comment: 'Merci' }) };
        }
        const body = pages[page] || { reviews: [] };
        page += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
    });

    const reviews = await provider.listReviews(establishment);
    expect(reviews).toHaveLength(2);
    expect(reviews[0].stars).toBe(5);
    expect(reviews[0].text).toBe('Super cadre');
    expect(reviews[1].hasReply).toBe(true);
    expect(calls.some((call) => call.url.includes('pageSize=50'))).toBe(true);
    expect(calls.some((call) => call.url.includes('pageToken=t2'))).toBe(true);

    await provider.replyToReview(establishment, 'abc', 'Merci pour le plat');
    const reply = calls.find((call) => call.url.includes('/reviews/abc/reply'));
    expect(reply.method).toBe('PUT');
    expect(JSON.parse(reply.body)).toEqual({ comment: 'Merci pour le plat' });
  });

  it('refuse le scan initial en mode webhook et délègue la publication', async () => {
    let posted = null;
    const provider = createWebhookProvider({
      webhookUrl: 'https://example.test/hook',
      fetchImpl: async (_url, options) => {
        posted = JSON.parse(options.body);
        return { ok: true, status: 200, text: async () => '' };
      }
    });
    await expect(provider.listReviews(establishment)).rejects.toMatchObject({ code: 'SCAN_UNSUPPORTED' });
    expect((await provider.getReplyState()).supported).toBe(false);
    await provider.replyToReview(establishment, 'rev1', 'Merci');
    expect(posted).toMatchObject({ action: 'publish_reply', reviewId: 'rev1', comment: 'Merci', establishmentId: 7 });
    expect(createGoogleProvider({ kind: 'webhook', webhookUrl: 'https://example.test/hook', fetchImpl: async () => ({ ok: true, text: async () => '' }) }).kind).toBe('webhook');
  });

  it('extrait le commentaire original', () => {
    const review = normalizeGoogleReview({
      name: 'accounts/1/locations/2/reviews/t',
      starRating: 'FOUR',
      comment: '(Translated by Google) Great\n\n(Original)\nSuper cadre'
    });
    expect(review.reviewId).toBe('t');
    expect(review.stars).toBe(4);
    expect(review.text).toBe('Super cadre');
  });
});
