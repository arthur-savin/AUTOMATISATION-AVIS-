import crypto from 'node:crypto';
import { logError } from './util.js';

export const TEMPLATE_TEXT_MAX = 400;
export const TEMPLATE_DRAFT_MAX = 400;
export const EMPTY_REVIEW_TEXT = 'Note seule, sans commentaire';
const SESSION_MS = 24 * 60 * 60 * 1000;

export function verifyMetaSignature(rawBody, header, secret) {
  if (!secret || !header || rawBody == null) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(`sha256=${digest}`);
  const received = Buffer.from(String(header));
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

/**
 * Contraintes Meta sur les variables de template : pas de saut de ligne,
 * pas de tabulation, pas plus de 3 espaces consécutifs. Au-delà de maxLen,
 * le texte est coupé et terminé par une ellipse.
 */
export function sanitizeTemplateParam(value, maxLen = TEMPLATE_TEXT_MAX) {
  let text = String(value ?? '').replace(/[\r\n\t]+/g, ' ');
  text = text.replace(/ {4,}/g, '   ').trim();
  if (maxLen && text.length > maxLen) {
    if (maxLen <= 1) return '…';
    text = `${text.slice(0, maxLen - 1).trimEnd()}…`;
    text = text.replace(/ {4,}/g, '   ');
  }
  return text;
}

export function formatReviewText(text) {
  if (!text || !String(text).trim()) return EMPTY_REVIEW_TEXT;
  return String(text);
}

export function templateParamWasTruncated(value, maxLen) {
  const source = formatReviewText(value);
  const full = sanitizeTemplateParam(source, Number.MAX_SAFE_INTEGER);
  const cut = sanitizeTemplateParam(source, maxLen);
  return cut !== full;
}

export function isSessionOpen(session, nowMs) {
  if (!session?.last_inbound_at) return false;
  return nowMs - Number(session.last_inbound_at) < SESSION_MS;
}

export function parseActionPayload(payload) {
  if (!payload || !String(payload).includes(':')) return null;
  const raw = String(payload);
  const index = raw.indexOf(':');
  const action = raw.slice(0, index).trim().toUpperCase();
  const reviewId = raw.slice(index + 1).trim();
  if (!['PUBLISH', 'EDIT', 'IGNORE'].includes(action) || !reviewId) return null;
  return { action, reviewId };
}

export function fullReviewMessage(review) {
  return `Texte complet de l'avis :\n${formatReviewText(review.text)}`;
}

export function buildTemplatePayload({ to, reviewId, params, templateName, templateLang }) {
  const button = (index, payload) => ({
    type: 'button',
    sub_type: 'quick_reply',
    index: String(index),
    parameters: [{ type: 'payload', payload }]
  });
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLang },
      components: [
        {
          type: 'body',
          parameters: params.map((text) => ({ type: 'text', text }))
        },
        button(0, `PUBLISH:${reviewId}`),
        button(1, `EDIT:${reviewId}`),
        button(2, `IGNORE:${reviewId}`)
      ]
    }
  };
}

export function buildInteractiveBody({ establishment, review, draft }) {
  const text = formatReviewText(review.text);
  const author = review.author || 'Un client';
  const proposed = draft || '…';
  const header = `Avis ${review.stars}/5 — ${establishment.name}`;
  let body = `${header}\n${author} :\n${text}\n\nRéponse proposée :\n${proposed}\n\nTu peux publier, modifier ou ignorer.`;
  let truncated = false;
  if (body.length > 1024) {
    truncated = true;
    const overhead = header.length + author.length + 80;
    const budget = Math.max(40, 1024 - overhead - Math.min(proposed.length, 300));
    const cut = `${text.slice(0, budget - 1).trimEnd()}…`;
    const shortDraft = proposed.length > 300 ? `${proposed.slice(0, 299).trimEnd()}…` : proposed;
    body = `${header}\n${author} :\n${cut}\n\nRéponse proposée :\n${shortDraft}\n\nTu peux publier, modifier ou ignorer.`;
    if (body.length > 1024) body = `${body.slice(0, 1023)}…`;
  }
  return { body, truncated };
}

export function buildInteractivePayload({ to, reviewId, body }) {
  const button = (id, title) => ({ type: 'reply', reply: { id, title } });
  return {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: {
        buttons: [
          button(`PUBLISH:${reviewId}`, 'Publier'),
          button(`EDIT:${reviewId}`, 'Modifier'),
          button(`IGNORE:${reviewId}`, 'Ignorer')
        ]
      }
    }
  };
}

export function createWhatsAppClient({
  fetchImpl = fetch,
  token = process.env.WHATSAPP_TOKEN,
  phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID,
  version = process.env.WHATSAPP_API_VERSION || 'v21.0',
  templateName = process.env.TEMPLATE_NAME || 'alerte_avis',
  templateLang = process.env.TEMPLATE_LANG || 'fr'
} = {}) {
  async function postMessage(payload, context) {
    if (!token || !phoneNumberId) {
      const error = new Error('WHATSAPP_TOKEN ou WHATSAPP_PHONE_NUMBER_ID manquant');
      logError('whatsapp', error, context);
      throw error;
    }
    const url = `https://graph.facebook.com/${version}/${phoneNumberId}/messages`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`WhatsApp HTTP ${response.status} : ${raw.slice(0, 500)}`);
      logError('whatsapp', error, context);
      throw error;
    }
    const data = raw ? JSON.parse(raw) : {};
    return data.messages?.[0]?.id || null;
  }

  return {
    async sendText(to, body, context = {}) {
      return postMessage({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body, preview_url: false }
      }, context);
    },

    async sendReviewAlert({ to, establishment, review, draft, sessionOpen, context = {} }) {
      const reviewId = review.review_id || review.reviewId;
      const note = `${review.stars}/5`;
      const reviewText = formatReviewText(review.text);
      const proposed = draft || '…';
      const logContext = {
        reviewId,
        establishmentId: establishment.id,
        ...context
      };

      if (!sessionOpen) {
        const params = [
          sanitizeTemplateParam(note, 20) || '…',
          sanitizeTemplateParam(establishment.name, 80) || '…',
          sanitizeTemplateParam(reviewText, TEMPLATE_TEXT_MAX) || EMPTY_REVIEW_TEXT,
          sanitizeTemplateParam(proposed, TEMPLATE_DRAFT_MAX) || '…'
        ];
        const truncated = templateParamWasTruncated(review.text, TEMPLATE_TEXT_MAX)
          || templateParamWasTruncated(proposed, TEMPLATE_DRAFT_MAX);
        const id = await postMessage(buildTemplatePayload({
          to,
          reviewId,
          params,
          templateName,
          templateLang
        }), logContext);
        return { id, truncated, mode: 'template' };
      }

      const built = buildInteractiveBody({ establishment, review, draft: proposed });
      const id = await postMessage(buildInteractivePayload({
        to,
        reviewId,
        body: built.body
      }), logContext);
      return { id, truncated: built.truncated, mode: 'interactive' };
    }
  };
}

export function extractWhatsAppEvents(body) {
  const events = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      for (const message of change.value?.messages || []) {
        const phone = message.from;
        const messageId = message.id;
        if (message.type === 'text') {
          events.push({ phone, messageId, type: 'text', text: message.text?.body || '' });
        } else if (message.type === 'interactive' && message.interactive?.button_reply) {
          const button = message.interactive.button_reply;
          events.push({ phone, messageId, type: 'button', payload: button.id, title: button.title });
        } else if (message.type === 'button') {
          events.push({
            phone,
            messageId,
            type: 'button',
            payload: message.button?.payload,
            title: message.button?.text
          });
        }
      }
    }
  }
  return events;
}
