import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDate, logError, logInfo } from './util.js';

const ALLOWED_THEMES = [
  'attente', 'accueil', 'service', 'qualité_plats', 'quantité', 'prix', 'propreté',
  'ambiance', 'bruit', 'réservation', 'livraison', 'cadre', 'rapport_qualité_prix', 'autre'
];
const ALLOWED = new Set(ALLOWED_THEMES);

const THEME_RULES = [
  ['attente', ['attente', 'attendu', 'lenteur', 'lent', 'lente', 'wait', 'waiting', 'slow']],
  ['accueil', ['accueil', 'accueilli', 'welcome']],
  ['service', ['service', 'serveur', 'serveuse', 'personnel', 'waiter', 'staff']],
  ['qualité_plats', ['plat', 'plats', 'cuisine', 'gout', 'goût', 'fade', 'burger', 'pizza', 'dessert', 'tiramisu', 'food', 'dish']],
  ['quantité', ['portion', 'quantité', 'copieux']],
  ['prix', ['prix', 'cher', 'chere', 'chère', 'addition', 'tarif', 'expensive', 'price']],
  ['propreté', ['propre', 'sale', 'salete', 'saleté', 'hygiene', 'hygiène', 'dirty']],
  ['ambiance', ['ambiance', 'atmosphere', 'atmosphère']],
  ['bruit', ['bruit', 'bruyant', 'noisy', 'loud']],
  ['réservation', ['reservation', 'réservation', 'reserve', 'réservé']],
  ['livraison', ['livraison', 'livreur', 'delivery']],
  ['cadre', ['cadre', 'decor', 'décor', 'terrasse']],
  ['rapport_qualité_prix', ['rapport qualite', 'rapport qualité', 'qualite prix', 'qualité prix', 'value for money']]
];

const templatePath = join(dirname(fileURLToPath(import.meta.url)), 'prompts', 'reply-system.md');

export function loadSystemPromptTemplate() {
  return readFileSync(templatePath, 'utf8');
}

export function fillPrompt(template, vars) {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.split(`{{${key}}}`).join(value == null ? '' : String(value));
  }
  return output;
}

export function normalizeLoose(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function detectThemes(text) {
  const norm = normalizeLoose(text);
  if (!norm.trim()) return [];
  const found = [];
  for (const [theme, words] of THEME_RULES) {
    if (words.some((word) => norm.includes(normalizeLoose(word)))) found.push(theme);
  }
  return found.slice(0, 4);
}

export function filterThemes(themes) {
  const out = [];
  for (const theme of themes || []) {
    const value = String(theme || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (ALLOWED.has(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

export function parseThemes(value) {
  if (Array.isArray(value)) return filterThemes(value);
  if (typeof value === 'string' && value.trim()) {
    try {
      return filterThemes(JSON.parse(value));
    } catch {
      return filterThemes(value.split(/[,;]/));
    }
  }
  return [];
}

function tokenize(text) {
  return normalizeLoose(text).split(/[^a-z0-9]+/).filter((token) => token.length > 2);
}

function hash32(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function embed(text, dims = 48) {
  const vector = new Float64Array(dims);
  const tokens = tokenize(text);
  const grams = tokens.slice();
  for (let i = 0; i < tokens.length - 1; i += 1) grams.push(`${tokens[i]}_${tokens[i + 1]}`);
  for (const gram of grams) {
    const hash = hash32(gram);
    vector[hash % dims] += (hash & 1) ? 1 : -1;
  }
  return vector;
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function tokenCosine(leftText, rightText) {
  const left = new Set(tokenize(leftText));
  const right = new Set(tokenize(rightText));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.sqrt(left.size * right.size);
}

export function textSimilarity(left, right) {
  const embedded = Math.max(0, cosine(embed(left), embed(right)));
  return (embedded * 0.5) + (tokenCosine(left, right) * 0.5);
}

function sourceWeight(example) {
  if (example.was_edited) return 5;
  if (example.source === 'google_history') return 2;
  return 0.5;
}

export function scoreExample(example, review) {
  const reviewThemes = new Set(parseThemes(review.themes).length ? parseThemes(review.themes) : detectThemes(review.text));
  const exampleThemes = new Set(parseThemes(example.themes));
  let overlap = 0;
  for (const theme of exampleThemes) if (reviewThemes.has(theme)) overlap += 1;
  const reviewBand = Number(review.stars) <= 3 ? 'low' : 'high';
  const exampleBand = Number(example.stars) <= 3 ? 'low' : 'high';
  let score = sourceWeight(example);
  if (Number(example.stars) === Number(review.stars)) score += 3;
  else if (exampleBand === reviewBand) score += 1.5;
  score += overlap * 2;
  score += textSimilarity(example.review_text || '', review.text || '') * 3;
  return score;
}

/**
 * 3 à 5 exemples les plus proches. Les versions corrigées par le patron passent devant.
 * S'il y en a moins de 3 en base, on renvoie tout ce qui existe.
 */
export function selectExamples(examples, review, { max = 5 } = {}) {
  const ranked = [...examples].sort((left, right) => {
    const delta = scoreExample(right, review) - scoreExample(left, review);
    if (delta !== 0) return delta;
    return Number(left.id || 0) - Number(right.id || 0);
  });
  return ranked.slice(0, max);
}

export function formatExamples(examples) {
  if (!examples.length) return 'Aucun exemple pour l\'instant.';
  return examples.map((example, index) => [
    `Exemple ${index + 1}`,
    `Note : ${example.stars}/5`,
    `Avis : ${example.review_text?.trim() || 'Note seule, sans commentaire'}`,
    `Réponse finale du patron : ${example.final || ''}`,
    `Proposition corrigée par le patron : ${example.was_edited ? 'oui' : 'non'}`
  ].join('\n')).join('\n\n');
}

export function buildSystemPrompt({ template, establishment, review, examples }) {
  const guide = establishment.style_guide?.trim()
    || 'Pas encore de guide : ton professionnel et sobre, sans emoji, sans signature.';
  return fillPrompt(template, {
    nom_etablissement: establishment.name,
    type_etablissement: establishment.type || 'restaurant',
    ville: establishment.city || 'ville non précisée',
    guide_de_style: guide,
    exemples: formatExamples(examples),
    note: String(review.stars ?? ''),
    auteur: review.author || 'Anonyme',
    date: formatDate(review.created_at || review.createdAt || ''),
    texte_avis: review.text?.trim() ? review.text.trim() : 'Note seule, sans commentaire',
    contact: establishment.contact?.trim() || 'le contact indiqué sur la fiche Google'
  });
}

export function parseDraftJson(text) {
  if (!text || !String(text).trim()) throw new Error('Réponse vide');
  let raw = String(text).trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) raw = fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('JSON introuvable');
  const data = JSON.parse(raw.slice(start, end + 1));
  if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Champ reply manquant');
  let themes = filterThemes(Array.isArray(data.themes) ? data.themes : []);
  if (!themes.length) themes = detectThemes(data.reply);
  const langue = typeof data.langue === 'string' && data.langue.trim()
    ? data.langue.trim().slice(0, 8)
    : 'fr';
  return { reply: data.reply.trim(), themes, langue };
}

export function fallbackDraft(establishment, review) {
  const author = review.author ? `${review.author}, ` : '';
  const english = String(review.lang || '').toLowerCase().startsWith('en');
  const name = establishment.name || 'notre établissement';
  let reply;
  if (!review.text || !String(review.text).trim()) {
    reply = english
      ? `${author}thank you for the rating. We hope to welcome you again at ${name}.`
      : `${author}merci pour votre note. Au plaisir de vous accueillir de nouveau à ${name}.`;
  } else if (Number(review.stars) <= 3) {
    const contact = establishment.contact ? ` Vous pouvez nous joindre au ${establishment.contact}.` : '';
    reply = english
      ? `${author}thank you for telling us. We are sorry this visit fell short.${contact}`
      : `${author}merci de nous l'avoir signalé. Nous sommes désolés que cette visite n'ait pas été à la hauteur.${contact}`;
  } else {
    reply = english
      ? `${author}thank you for your kind words. We would be glad to see you again at ${name}.`
      : `${author}merci pour ces mots. Ce sera un plaisir de vous revoir à ${name}.`;
  }
  return {
    reply: reply.replace(/\s+/g, ' ').trim(),
    themes: detectThemes(review.text),
    langue: english ? 'en' : (review.lang || 'fr'),
    fallback: true
  };
}

export function normalizeStyleGuide(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rules = [];
  for (const line of lines) {
    const cleaned = line.replace(/^[-*•\d.)\s]+/, '').trim();
    if (!cleaned) continue;
    rules.push(`- ${cleaned}`);
    if (rules.length === 10) break;
  }
  return rules.join('\n');
}

export function extractStyleGuide(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return normalizeStyleGuide(parsed.join('\n'));
    if (Array.isArray(parsed.rules)) return normalizeStyleGuide(parsed.rules.join('\n'));
    if (typeof parsed.guide === 'string') return normalizeStyleGuide(parsed.guide);
  } catch {
    // Texte libre : une règle par ligne.
  }
  return normalizeStyleGuide(raw);
}

function stylePrompt(establishment, examples) {
  const history = [...examples].reverse().map((example) => (
    `Note ${example.stars}. Avis : ${example.review_text || '(sans texte)'}\nProposition : ${example.draft || '(aucune)'}\nVersion du patron : ${example.final}`
  )).join('\n\n');
  return [
    `Tu observes les corrections du patron de ${establishment.name}.`,
    'Écris un guide de style de 10 règles maximum, une règle par ligne, chacune commençant par "- ".',
    'Règles concrètes uniquement : tutoiement, signature, formules à garder ou à éviter, contact, longueur.',
    'Pas de commentaire autour.',
    '',
    establishment.style_guide ? `Guide actuel :\n${establishment.style_guide}` : 'Pas encore de guide.',
    '',
    'Corrections du patron :',
    history || '(aucune)'
  ].join('\n');
}

export function createLlm({
  fetchImpl = fetch,
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  maxTokens = Number(process.env.ANTHROPIC_MAX_TOKENS || 1024),
  template = loadSystemPromptTemplate()
} = {}) {
  async function callModel(system, user, context) {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }]
      }),
      signal: AbortSignal.timeout(45000)
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`Claude HTTP ${response.status} : ${raw.slice(0, 300)}`);
      logError('llm', error, context);
      throw error;
    }
    const data = raw ? JSON.parse(raw) : {};
    const text = (data.content || []).map((block) => block.text || '').join('\n').trim();
    if (!text) throw new Error('Réponse Claude vide');
    return text;
  }

  return {
    async generateDraft(establishment, review, examples = []) {
      const context = { establishmentId: establishment.id };
      if (!apiKey) {
        logInfo('llm', 'ANTHROPIC_API_KEY absente, réponse de secours', context);
        return fallbackDraft(establishment, review);
      }
      const system = buildSystemPrompt({ template, establishment, review, examples });
      try {
        const first = await callModel(system, 'Rédige la réponse. JSON uniquement.', context);
        return { ...parseDraftJson(first), fallback: false };
      } catch (firstError) {
        logError('llm', firstError, context);
        try {
          const second = await callModel(
            system,
            'Ta réponse précédente était invalide. Réponds uniquement avec {"reply","themes","langue"}.',
            context
          );
          return { ...parseDraftJson(second), fallback: false };
        } catch (secondError) {
          logError('llm', secondError, context);
          return fallbackDraft(establishment, review);
        }
      }
    },

    async updateStyleGuide(establishment, examples) {
      const context = { establishmentId: establishment.id };
      if (!apiKey) return establishment.style_guide || '';
      try {
        const text = await callModel(
          'Tu écris des règles de style courtes pour un restaurateur. 10 lignes maximum.',
          stylePrompt(establishment, examples),
          context
        );
        return extractStyleGuide(text);
      } catch (error) {
        logError('llm', error, context);
        return establishment.style_guide || '';
      }
    }
  };
}
