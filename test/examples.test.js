import { describe, expect, it } from 'vitest';
import { selectExamples } from '../llm.js';

describe('sélection des exemples d\'apprentissage', () => {
  it('prend 3 à 5 exemples proches et fait passer les corrections du patron devant', () => {
    const review = {
      stars: 2,
      text: 'Service très lent et accueil froid, on a attendu 40 minutes',
      themes: ['attente', 'accueil']
    };
    const examples = [
      { id: 1, stars: 5, review_text: 'Excellent burger', themes: ['qualité_plats'], final: 'Merci pour le burger', was_edited: true, source: 'edited' },
      { id: 2, stars: 2, review_text: 'Accueil froid', themes: ['accueil'], final: 'Désolé pour l accueil', was_edited: false, source: 'accepted' },
      { id: 3, stars: 1, review_text: 'Attente interminable et accueil désagréable', themes: ['attente', 'accueil'], final: 'On a trop tardé, rappelle-nous', was_edited: true, source: 'edited' },
      { id: 4, stars: 2, review_text: 'Prix élevés et attente', themes: ['prix', 'attente'], final: 'Les prix sont affichés', was_edited: false, source: 'accepted' },
      { id: 5, stars: 4, review_text: 'Super ambiance', themes: ['ambiance'], final: 'Merci pour l ambiance', was_edited: true, source: 'edited' },
      { id: 6, stars: 3, review_text: 'Attente longue au service', themes: ['attente', 'service'], final: 'Désolé pour l attente', was_edited: true, source: 'edited' },
      { id: 7, stars: 2, review_text: 'Propreté moyenne', themes: ['propreté'], final: 'On va revoir le ménage', was_edited: false, source: 'accepted' },
      { id: 8, stars: 5, review_text: 'Cadre magnifique', themes: ['cadre'], final: 'Merci pour le cadre', was_edited: false, source: 'google_history' }
    ];

    const picked = selectExamples(examples, review);
    expect(picked.length).toBeGreaterThanOrEqual(3);
    expect(picked.length).toBeLessThanOrEqual(5);
    expect(picked[0].id).toBe(3);
    expect(picked.map((item) => item.id)).toContain(6);
    expect(picked[0].was_edited).toBe(true);
  });

  it('classe une correction devant un brouillon accepté au texte identique', () => {
    const review = { stars: 5, text: 'burger excellent', themes: ['qualité_plats'] };
    const picked = selectExamples([
      { id: 1, stars: 5, review_text: 'burger excellent', themes: ['qualité_plats'], final: 'version acceptée', was_edited: false, source: 'accepted' },
      { id: 2, stars: 5, review_text: 'burger excellent', themes: ['qualité_plats'], final: 'version corrigée', was_edited: true, source: 'edited' }
    ], review);
    expect(picked.map((item) => item.id)).toEqual([2, 1]);
  });
});
