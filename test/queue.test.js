import { describe, expect, it } from 'vitest';
import { getEstablishment, getReview, insertEstablishment, openDatabase, updateReview } from '../db.js';
import { ingestReview, nextDecision, pauseBacklog, resumeBacklog, canPublishToday, runOnboarding, handleInbound } from '../queue.js';
import { dayKey } from '../util.js';

function review(partial) {
  return {
    author: 'Client',
    text: 'Avis',
    createdAt: '2024-01-01T00:00:00.000Z',
    hasReply: false,
    ...partial
  };
}

describe('file d\'attente et priorités', () => {
  it('sert le temps réel avant le backlog, un seul avis à la fois, négatifs d\'abord', () => {
    const db = openDatabase(':memory:');
    const est = insertEstablishment(db, {
      name: 'Chez Marco',
      owner_phone: '33601020304',
      daily_limit: 2
    });

    ingestReview(db, est, review({ reviewId: 'old-pos', stars: 5, text: 'Bien', createdAt: '2024-01-01T00:00:00.000Z' }), { priority: 1, now: new Date('2024-08-01T00:00:00Z') });
    ingestReview(db, est, review({ reviewId: 'new-pos', stars: 5, text: 'Super', createdAt: '2024-06-01T00:00:00.000Z' }), { priority: 1, now: new Date('2024-08-01T00:00:01Z') });
    ingestReview(db, est, review({ reviewId: 'neg', stars: 2, text: 'Trop lent', createdAt: '2024-02-01T00:00:00.000Z' }), { priority: 1, now: new Date('2024-08-01T00:00:02Z') });
    ingestReview(db, est, review({ reviewId: 'live', stars: 4, text: 'Nouveau', createdAt: '2024-07-01T00:00:00.000Z' }), { priority: 0, now: new Date('2024-08-02T00:00:00Z') });

    expect(nextDecision(db, est).review_id).toBe('live');

    updateReview(db, est.id, 'live', { status: 'sent_to_owner' });
    expect(nextDecision(db, est)).toBeNull();

    ingestReview(db, est, review({ reviewId: 'live-2', stars: 5, text: 'Encore', createdAt: '2024-07-02T00:00:00.000Z' }), { priority: 0, now: new Date('2024-08-02T01:00:00Z') });
    const day = dayKey(new Date());
    updateReview(db, est.id, 'live', { status: 'published', published_day: day });
    expect(nextDecision(db, est).review_id).toBe('live-2');

    updateReview(db, est.id, 'live-2', { status: 'published', published_day: day });
    expect(nextDecision(db, est).review_id).toBe('neg');
    expect(canPublishToday(db, est, day)).toBe(false);

    pauseBacklog(db, est.id);
    expect(nextDecision(db, est)).toBeNull();

    ingestReview(db, est, review({ reviewId: 'live-3', stars: 3, text: 'Tout juste', createdAt: '2024-07-03T00:00:00.000Z' }), { priority: 0, now: new Date('2024-08-02T02:00:00Z') });
    expect(nextDecision(db, est).review_id).toBe('live-3');

    updateReview(db, est.id, 'live-3', { status: 'ignored' });
    resumeBacklog(db, est.id);
    expect(nextDecision(db, est).review_id).toBe('neg');

    updateReview(db, est.id, 'neg', { status: 'ignored' });
    expect(nextDecision(db, est).review_id).toBe('new-pos');
  });

  it('scanne la fiche, garde les avis sans réponse et s\'appuie sur les réponses déjà publiées', async () => {
    const db = openDatabase(':memory:');
    const est = insertEstablishment(db, {
      name: 'Chez Marco',
      owner_phone: '33601020304',
      city: 'Lyon',
      type: 'restaurant'
    });
    const sent = [];
    let drafts = 0;
    const deps = {
      db,
      now: () => Date.parse('2026-05-01T10:00:00Z'),
      google: {
        async listReviews() {
          return [
            review({ reviewId: 'pos', stars: 5, text: 'Super burger', author: 'A', createdAt: '2024-05-01T00:00:00.000Z' }),
            review({ reviewId: 'neg', stars: 1, text: 'Attente horrible', author: 'B', createdAt: '2024-04-01T00:00:00.000Z' }),
            review({
              reviewId: 'done',
              stars: 4,
              text: 'Bon cadre',
              author: 'C',
              createdAt: '2024-03-01T00:00:00.000Z',
              hasReply: true,
              replyComment: 'Merci pour le cadre, à bientôt. Marco'
            })
          ];
        },
        async getReview() { return { hasReply: false }; },
        async replyToReview() {},
        async getReplyState() { return { state: 'PENDING', supported: true }; }
      },
      whatsapp: {
        async sendText(_to, body) { sent.push(body); },
        async sendReviewAlert(opts) {
          sent.push(`ALERT:${opts.review.review_id}`);
          return { id: 'm1', truncated: false };
        }
      },
      llm: {
        async generateDraft() {
          drafts += 1;
          return { reply: 'Merci pour le plat.', themes: ['qualité_plats'], langue: 'fr', fallback: false };
        },
        async updateStyleGuide() { return ''; }
      }
    };

    const result = await runOnboarding(deps, est.id);
    expect(result.sentence).toBe('J\'ai trouvé 2 avis sans réponse (dont 1 négatifs). Je vais te les proposer un par un.');
    expect(getEstablishment(db, est.id).pending_notice).toBe(result.sentence);
    expect(sent).toEqual(['ALERT:neg']);
    expect(drafts).toBe(1);
    expect(db.prepare('SELECT final FROM learning_examples').all()).toEqual([
      { final: 'Merci pour le cadre, à bientôt. Marco' }
    ]);

    await runOnboarding(deps, est.id);
    expect(drafts).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM learning_examples').get().n).toBe(1);

    await handleInbound(deps, { phone: '33601020304', messageId: 'bonjour-1', type: 'text', text: 'bonjour' });
    expect(sent.some((line) => line.includes('J\'ai trouvé 2 avis sans réponse'))).toBe(true);
    expect(sent.some((line) => line.includes('avis Google'))).toBe(true);
    expect(getEstablishment(db, est.id).pending_notice).toBeNull();
    expect(getReview(db, est.id, 'neg').status).toBe('sent_to_owner');
  });
});
