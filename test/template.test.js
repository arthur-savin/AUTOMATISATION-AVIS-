import { describe, expect, it } from 'vitest';
import {
  EMPTY_REVIEW_TEXT,
  TEMPLATE_TEXT_MAX,
  buildInteractivePayload,
  buildTemplatePayload,
  formatReviewText,
  sanitizeTemplateParam,
  templateParamWasTruncated
} from '../whatsapp.js';

describe('variables de template WhatsApp', () => {
  it('retire les sauts de ligne, les tabulations et les suites de plus de 3 espaces', () => {
    const clean = sanitizeTemplateParam('Bonjour\n\nle   plat\tétait    bon');
    expect(clean).toBe('Bonjour le   plat était   bon');
    expect(clean).not.toMatch(/[\n\r\t]/);
    expect(clean).not.toMatch(/ {4,}/);
  });

  it('tronque un avis trop long avec une ellipse', () => {
    const clean = sanitizeTemplateParam('a'.repeat(50), 10);
    expect(clean).toBe(`${'a'.repeat(9)}…`);
    expect(clean).toHaveLength(10);
    expect(templateParamWasTruncated('a'.repeat(500), TEMPLATE_TEXT_MAX)).toBe(true);
    expect(templateParamWasTruncated('Avis court', TEMPLATE_TEXT_MAX)).toBe(false);
  });

  it('indique clairement une note sans commentaire', () => {
    expect(formatReviewText('')).toBe(EMPTY_REVIEW_TEXT);
    expect(formatReviewText('  \n ')).toBe(EMPTY_REVIEW_TEXT);
    expect(templateParamWasTruncated('', TEMPLATE_TEXT_MAX)).toBe(false);
  });

  it('met l\'action et le reviewId dans chaque bouton', () => {
    const template = buildTemplatePayload({
      to: '33601020304',
      reviewId: 'abc',
      params: ['4/5', 'Chez Marco', 'Note seule, sans commentaire', 'Merci pour la note.'],
      templateName: 'alerte_avis',
      templateLang: 'fr'
    });
    const payloads = template.template.components.slice(1).map((component) => component.parameters[0].payload);
    expect(template.template.name).toBe('alerte_avis');
    expect(template.template.language.code).toBe('fr');
    expect(payloads).toEqual(['PUBLISH:abc', 'EDIT:abc', 'IGNORE:abc']);
    expect(template.template.components[0].parameters.every((param) => !/[\n\t]/.test(param.text) && !/ {4,}/.test(param.text))).toBe(true);

    const interactive = buildInteractivePayload({ to: '33601020304', reviewId: 'abc', body: 'Avis' });
    expect(interactive.interactive.action.buttons.map((button) => button.reply.id)).toEqual([
      'PUBLISH:abc',
      'EDIT:abc',
      'IGNORE:abc'
    ]);
  });
});
