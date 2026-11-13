import { describe, expect, it } from 'vitest';
import {
  getReview,
  insertEstablishment,
  insertExample,
  listExamples,
  openDatabase,
  scheduleFollowup,
  touchSession,
  updateReview
} from '../db.js';
import { handleInbound, ingestReview, runDueFollowups } from '../queue.js';

function depsFor(db, google, sent) {
  return {
    db,
    now: () => Date.parse('2026-06-01T12:00:00Z'),
    google,
    whatsapp: {
      async sendText(_to, body) { sent.push({ type: 'text', body }); },
      async sendReviewAlert(opts) {
        sent.push({ type: 'alert', reviewId: opts.review.review_id, draft: opts.draft });
        return { id: 'alert-1', truncated: false };
      }
    },
    llm: {
      async generateDraft() {
        return { reply: 'Nouvelle version sans promo.', themes: ['accueil'], langue: 'fr' };
      },
      async updateStyleGuide() { return '- signe Marco'; }
    }
  };
}

describe('Modifier → publication → exemple', () => {
  it('publie la version du patron et enregistre l\'exemple corrigé', async () => {
    const db = openDatabase(':memory:');
    const est = insertEstablishment(db, { name: 'Chez Marco', owner_phone: '33601020304', contact: '04 78 00 00 00' });
    ingestReview(db, est, {
      reviewId: 'rev-1',
      stars: 2,
      author: 'Lina',
      text: 'Tiramisu excellent mais attente trop longue',
      createdAt: '2026-05-01T00:00:00.000Z'
    });
    updateReview(db, est.id, 'rev-1', { status: 'sent_to_owner', draft: 'Brouillon initial' });

    const published = [];
    const sent = [];
    const deps = depsFor(db, {
      async getReview() { return { hasReply: false }; },
      async replyToReview(_est, reviewId, comment) { published.push({ reviewId, comment }); },
      async getReplyState() { return { supported: true, state: 'PENDING' }; }
    }, sent);

    const edit = await handleInbound(deps, {
      phone: '+33 6 01 02 03 04',
      messageId: 'm-edit',
      type: 'button',
      payload: 'EDIT:rev-1'
    });
    expect(edit.awaiting).toBe(true);
    expect(getReview(db, est.id, 'rev-1').status).toBe('awaiting_edit');

    const finalText = 'Merci pour le tiramisu, désolé pour l\'attente. Marco';
    const result = await handleInbound(deps, {
      phone: '33601020304',
      messageId: 'm-text',
      type: 'text',
      text: finalText
    });

    expect(result.published).toBe(true);
    expect(published).toEqual([{ reviewId: 'rev-1', comment: finalText }]);
    const examples = listExamples(db, est.id);
    expect(examples).toHaveLength(1);
    expect(examples[0].was_edited).toBe(true);
    expect(examples[0].source).toBe('edited');
    expect(examples[0].draft).toBe('Brouillon initial');
    expect(examples[0].final).toBe(finalText);
    expect(examples[0].review_text.toLowerCase()).toContain('tiramisu');
    expect(getReview(db, est.id, 'rev-1').status).toBe('published');
    expect(sent.some((message) => message.body === '✅ Réponse envoyée sur Google')).toBe(true);
    expect(db.prepare('SELECT kind FROM followups ORDER BY kind').all().map((row) => row.kind)).toEqual(['24h', '30m']);
  });

  it('ne publie pas si le patron a déjà répondu sur Google', async () => {
    const db = openDatabase(':memory:');
    const est = insertEstablishment(db, { name: 'Chez Marco', owner_phone: '33601020304' });
    ingestReview(db, est, { reviewId: 'rev-2', stars: 5, text: 'Top', author: 'Paul' });
    updateReview(db, est.id, 'rev-2', { status: 'sent_to_owner', draft: 'Merci Paul.' });
    const published = [];
    const sent = [];
    const deps = depsFor(db, {
      async getReview() { return { hasReply: true, replyComment: 'Déjà en ligne' }; },
      async replyToReview() { published.push('nope'); },
      async getReplyState() { return { supported: true, state: 'APPROVED' }; }
    }, sent);

    await handleInbound(deps, {
      phone: '33601020304',
      messageId: 'm-pub',
      type: 'button',
      payload: 'PUBLISH:rev-2'
    });

    expect(published).toHaveLength(0);
    expect(listExamples(db, est.id)).toHaveLength(0);
    expect(getReview(db, est.id, 'rev-2').status).toBe('already_replied');
    expect(sent.some((message) => message.body.includes('déjà une réponse'))).toBe(true);
  });
});

describe('contrôle du rejet Google', () => {
  it('prévient le patron et propose une nouvelle version', async () => {
    const db = openDatabase(':memory:');
    const est = insertEstablishment(db, { name: 'Chez Marco', owner_phone: '33601020304' });
    ingestReview(db, est, { reviewId: 'rev-3', stars: 1, text: 'Accueil froid', author: 'Inès' });
    updateReview(db, est.id, 'rev-3', { status: 'published', draft: 'Ancienne réponse', reply_state: 'PENDING' });
    insertExample(db, {
      establishment_id: est.id,
      review_id: 'rev-3',
      stars: 1,
      review_text: 'Accueil froid',
      themes: ['accueil'],
      draft: 'Ancienne réponse',
      final: 'Ancienne réponse',
      was_edited: 0,
      source: 'accepted'
    });
    scheduleFollowup(db, {
      establishment_id: est.id,
      review_id: 'rev-3',
      run_at: Date.parse('2026-06-01T11:00:00Z'),
      kind: '30m'
    });
    touchSession(db, '33601020304', Date.parse('2026-06-01T11:30:00Z'));

    const sent = [];
    const deps = depsFor(db, {
      async getReview() { return { hasReply: true }; },
      async replyToReview() {},
      async getReplyState() {
        return { supported: true, state: 'REJECTED', policyViolation: 'Contenu promotionnel', hasReply: true };
      }
    }, sent);

    await runDueFollowups(deps);
    const review = getReview(db, est.id, 'rev-3');
    expect(review.reply_state).toBe('REJECTED');
    expect(review.policy_violation).toBe('Contenu promotionnel');
    expect(review.draft).toBe('Nouvelle version sans promo.');
    expect(review.status).toBe('rejected');
    expect(listExamples(db, est.id)).toHaveLength(0);
    expect(sent.some((message) => message.body?.includes('Contenu promotionnel'))).toBe(true);
    expect(sent.some((message) => message.type === 'alert' && message.draft.includes('Nouvelle version'))).toBe(true);
  });
});
