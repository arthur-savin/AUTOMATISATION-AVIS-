import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, createLlm, loadSystemPromptTemplate } from '../llm.js';

function anthropic(text, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify({ content: [{ type: 'text', text }] })
  };
}

describe('rédaction Claude', () => {
  it('remplace les variables du prompt système', () => {
    const prompt = buildSystemPrompt({
      template: loadSystemPromptTemplate(),
      establishment: {
        name: 'Chez Marco',
        type: 'restaurant',
        city: 'Lyon',
        contact: '04 78 00 00 00',
        style_guide: '- tutoie jamais'
      },
      review: { stars: 5, author: 'Lina', text: 'Super tiramisu', created_at: '2024-01-02T00:00:00.000Z' },
      examples: []
    });
    expect(prompt).not.toMatch(/\{\{/);
    expect(prompt).toContain('Chez Marco');
    expect(prompt).toContain('tutoie jamais');
    expect(prompt).toContain('Super tiramisu');
    expect(prompt).toContain('04 78 00 00 00');
  });

  it('réessaie une fois puis accepte un JSON valide', async () => {
    const outputs = ['pas du json', '{"reply":"Merci pour le tiramisu.","themes":["qualité_plats"],"langue":"fr"}'];
    let calls = 0;
    const llm = createLlm({
      apiKey: 'test-key',
      fetchImpl: async () => {
        const text = outputs[calls];
        calls += 1;
        return anthropic(text);
      }
    });
    const draft = await llm.generateDraft(
      { id: 1, name: 'Chez Marco', type: 'restaurant', city: 'Lyon', contact: '', style_guide: '' },
      { stars: 5, author: 'Lina', text: 'Super tiramisu', lang: 'fr' },
      []
    );
    expect(calls).toBe(2);
    expect(draft.reply).toBe('Merci pour le tiramisu.');
    expect(draft.themes).toEqual(['qualité_plats']);
    expect(draft.fallback).toBe(false);
  });

  it('utilise une réponse de secours si le JSON échoue deux fois', async () => {
    let calls = 0;
    const llm = createLlm({
      apiKey: 'test-key',
      fetchImpl: async () => {
        calls += 1;
        return anthropic('toujours invalide');
      }
    });
    const draft = await llm.generateDraft(
      { id: 1, name: 'Chez Marco', type: 'restaurant', city: 'Lyon', contact: '', style_guide: '' },
      { stars: 2, author: 'Lina', text: 'Attente trop longue', lang: 'fr' },
      []
    );
    expect(calls).toBe(2);
    expect(draft.fallback).toBe(true);
    expect(draft.reply.length).toBeGreaterThan(10);
  });
});
