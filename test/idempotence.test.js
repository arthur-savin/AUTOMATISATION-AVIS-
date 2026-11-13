import { describe, expect, it } from 'vitest';
import { countReviews, getReview, insertEstablishment, openDatabase } from '../db.js';
import { handleNotification, ingestReview } from '../queue.js';

describe('idempotence des avis', () => {
  it('n\'enregistre pas deux fois le même reviewId et ignore un avis déjà répondu', () => {
    const db = openDatabase(':memory:');
    const est = insertEstablishment(db, { name: 'Chez Marco', owner_phone: '33601020304' });

    const first = ingestReview(db, est, {
      reviewId: 'r1',
      stars: 5,
      text: 'Excellent',
      author: 'A',
      createdAt: '2024-01-01T00:00:00.000Z'
    });
    const second = ingestReview(db, est, {
      reviewId: 'r1',
      stars: 1,
      text: 'Changé',
      author: 'B',
      createdAt: '2024-02-01T00:00:00.000Z'
    });

    expect(first.created).toBe(true);
    expect(first.queued).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.created).toBe(false);
    expect(getReview(db, est.id, 'r1').stars).toBe(5);
    expect(getReview(db, est.id, 'r1').status).toBe('queued');

    const answered = ingestReview(db, est, {
      reviewId: 'r2',
      stars: 4,
      text: 'Déjà traité',
      hasReply: true,
      replyComment: 'Merci'
    });
    expect(answered.queued).toBe(false);
    expect(answered.skipped).toBe(true);
    expect(getReview(db, est.id, 'r2').status).toBe('already_replied');

    const again = ingestReview(db, est, {
      reviewId: 'r2',
      stars: 1,
      text: 'Autre',
      hasReply: true,
      replyComment: 'Merci'
    });
    expect(again.duplicate).toBe(true);
    expect(countReviews(db, est.id)).toBe(2);
  });

  it('ne relance pas un avis déjà vu, même s\'il revient par une notification', async () => {
    const db = openDatabase(':memory:');
    const est = insertEstablishment(db, { name: 'Chez Marco', owner_phone: '33601020304' });
    const sent = [];
    const deps = {
      db,
      now: () => Date.parse('2026-05-01T10:00:00Z'),
      google: {
        async getReview() { return { hasReply: false }; },
        async replyToReview() {},
        async getReplyState() { return { supported: true, state: 'PENDING' }; }
      },
      whatsapp: {
        async sendText() {},
        async sendReviewAlert(opts) {
          sent.push(opts.review.review_id);
          return { id: 'a', truncated: false };
        }
      },
      llm: {
        async generateDraft() {
          return { reply: 'Merci.', themes: ['autre'], langue: 'fr' };
        },
        async updateStyleGuide() { return ''; }
      }
    };

    const created = await handleNotification(deps, {
      establishmentId: est.id,
      reviewId: 'z',
      stars: 4,
      text: 'Bon plat',
      author: 'A'
    });
    const duplicate = await handleNotification(deps, {
      establishmentId: est.id,
      reviewId: 'z',
      stars: 1,
      text: 'Autre'
    });
    await handleNotification(deps, {
      establishmentId: est.id,
      reviewId: 'y',
      stars: 5,
      text: 'Déjà répondu',
      hasReply: true,
      replyComment: 'Merci'
    });

    expect(created.created).toBe(true);
    expect(duplicate.duplicate).toBe(true);
    expect(getReview(db, est.id, 'z').stars).toBe(4);
    expect(getReview(db, est.id, 'y').status).toBe('already_replied');
    expect(sent).toEqual(['z']);
  });
});
