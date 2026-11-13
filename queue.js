import {
  clearAwaitingEdit,
  countEditedExamples,
  deleteExamplesForReview,
  dueFollowups,
  findEstablishmentByLocation,
  getEstablishment,
  getReview,
  getSession,
  hasInFlight,
  insertExample,
  insertReview,
  listEditedExamples,
  listExamples,
  listEstablishments,
  listEstablishmentsByPhone,
  listPendingFullText,
  markFollowup,
  nextApproved,
  nextQueuedDecision,
  publishedCountOn,
  queueStats,
  rememberInbound,
  scheduleFollowup,
  setAwaitingEdit,
  touchSession,
  updateEstablishment,
  updateReview
} from './db.js';
import { locationIdOf, accountIdOf, normalizeGoogleReview, reviewIdOf } from './google/index.js';
import {
  detectThemes,
  fallbackDraft,
  parseThemes,
  selectExamples
} from './llm.js';
import { dayKey, logError, normalizePhone, parseCommand, withLock } from './util.js';
import {
  extractWhatsAppEvents,
  fullReviewMessage,
  isSessionOpen,
  parseActionPayload
} from './whatsapp.js';

const FOLLOWUP_30_MS = 30 * 60 * 1000;
const FOLLOWUP_24_MS = 24 * 60 * 60 * 1000;
const ACTIONABLE = new Set(['sent_to_owner', 'awaiting_edit', 'rejected']);

const OUT_OF_SCOPE = 'Je m\'occupe seulement des avis Google de ton établissement : je te propose une réponse, et tu peux la publier, la modifier ou l\'ignorer.';
const CONFIRM = '✅ Réponse envoyée sur Google';
const ALREADY = 'Cet avis a déjà une réponse sur Google. Je ne publie rien et je passe au suivant.';
const EDIT_PROMPT = 'Envoie-moi le texte exact à publier. Je le mettrai sur Google tel quel.';
const IGNORE_ACK = 'D\'accord, j\'ignore cet avis.';
const NOT_PENDING = 'Cet avis n\'est plus en attente.';
const PUBLISH_FAIL = 'Je n\'ai pas réussi à publier sur Google. Réessaie dans un moment.';
const EMPTY_EDIT = 'Je n\'ai pas reçu de texte. Envoie la réponse à publier.';
const STOP_MSG = 'Backlog en pause. Je te préviens quand même des nouveaux avis. Envoie REPRENDRE pour relancer.';
const RESUME_MSG = 'C\'est reparti, je reprends les avis en attente.';
const STALE = 'Je ne retrouve pas cet avis.';

function nowMs(deps) {
  return deps.now ? deps.now() : Date.now();
}

function nowDate(deps) {
  return new Date(nowMs(deps));
}

function context(establishment, review) {
  return {
    establishmentId: establishment?.id ?? null,
    reviewId: review?.review_id || review?.reviewId || null
  };
}

function summarySentence(total, negative) {
  if (total === 0) {
    return 'J\'ai trouvé 0 avis sans réponse. Je te préviendrai dès qu\'un nouvel avis arrive.';
  }
  return `J'ai trouvé ${total} avis sans réponse (dont ${negative} négatifs). Je vais te les proposer un par un.`;
}

function themesOf(review) {
  const parsed = parseThemes(review?.themes);
  if (parsed.length) return parsed;
  return detectThemes(review?.text || review?.review_text || '');
}

function deferNotice(db, establishmentId, text) {
  const current = getEstablishment(db, establishmentId);
  const pending = current?.pending_notice ? `${current.pending_notice}\n\n${text}` : text;
  updateEstablishment(db, establishmentId, { pending_notice: pending });
}

export function ingestReview(db, establishment, input, options = {}) {
  const normalized = normalizeGoogleReview(input);
  if (!normalized?.reviewId) throw new Error('reviewId manquant');
  if (!normalized.stars) throw new Error(`Note invalide pour l'avis ${normalized.reviewId}`);

  const existing = getReview(db, establishment.id, normalized.reviewId);
  if (existing) {
    if (normalized.hasReply && existing.status === 'queued' && !existing.approved_reply) {
      updateReview(db, establishment.id, normalized.reviewId, {
        has_reply: 1,
        status: 'already_replied',
        final_reply: normalized.replyComment || existing.final_reply
      });
      return {
        created: false,
        duplicate: true,
        queued: false,
        cancelled: true,
        review: getReview(db, establishment.id, normalized.reviewId)
      };
    }
    return { created: false, duplicate: true, queued: false, review: existing };
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const hasReply = Boolean(normalized.hasReply);
  insertReview(db, {
    review_id: normalized.reviewId,
    establishment_id: establishment.id,
    stars: normalized.stars,
    author: normalized.author,
    text: normalized.text,
    lang: normalized.lang,
    created_at: normalized.createdAt || now.toISOString(),
    has_reply: hasReply,
    status: hasReply ? 'already_replied' : 'queued',
    final_reply: hasReply ? normalized.replyComment : null,
    reply_state: normalized.replyState,
    priority: hasReply ? 1 : (options.priority ?? 1),
    sort_negative: normalized.stars <= 3,
    enqueued_at: now.toISOString()
  });

  if (hasReply && options.learnFromReply && normalized.replyComment) {
    insertExample(db, {
      establishment_id: establishment.id,
      review_id: normalized.reviewId,
      stars: normalized.stars,
      review_text: normalized.text,
      themes: detectThemes(normalized.text),
      draft: normalized.replyComment,
      final: normalized.replyComment,
      was_edited: 0,
      source: 'google_history',
      created_at: now.toISOString()
    });
  }

  return {
    created: true,
    duplicate: false,
    queued: !hasReply,
    skipped: hasReply,
    review: getReview(db, establishment.id, normalized.reviewId)
  };
}

export function nextDecision(db, establishmentOrId) {
  const id = typeof establishmentOrId === 'object' ? establishmentOrId.id : establishmentOrId;
  const establishment = getEstablishment(db, id);
  if (!establishment) return null;
  if (hasInFlight(db, establishment.id)) return null;
  return nextQueuedDecision(db, establishment);
}

export function pauseBacklog(db, establishmentId) {
  return updateEstablishment(db, establishmentId, { backlog_paused: true });
}

export function resumeBacklog(db, establishmentId) {
  return updateEstablishment(db, establishmentId, { backlog_paused: false });
}

export function canPublishToday(db, establishment, day = dayKey(new Date())) {
  const fresh = getEstablishment(db, establishment.id || establishment);
  return publishedCountOn(db, fresh.id, day) < fresh.daily_limit;
}

function findReviewForPhone(db, phone, reviewId) {
  for (const establishment of listEstablishmentsByPhone(db, phone)) {
    const review = getReview(db, establishment.id, reviewId);
    if (review) return { establishment, review };
  }
  return null;
}

async function replyToPhone(deps, phone, text, establishment, review) {
  try {
    await deps.whatsapp.sendText(phone, text, context(establishment, review));
  } catch (error) {
    logError('whatsapp', error, context(establishment, review));
  }
}

async function notifyText(deps, establishment, text, review) {
  const session = getSession(deps.db, establishment.owner_phone);
  if (!isSessionOpen(session, nowMs(deps))) {
    const current = getEstablishment(deps.db, establishment.id)?.pending_notice || '';
    if (!current.includes(text)) deferNotice(deps.db, establishment.id, text);
    return { deferred: true };
  }
  await replyToPhone(deps, establishment.owner_phone, text, establishment, review);
  return { deferred: false };
}

async function flushNotices(deps, phone) {
  for (const establishment of listEstablishmentsByPhone(deps.db, phone)) {
    if (!establishment.pending_notice) continue;
    try {
      await deps.whatsapp.sendText(phone, establishment.pending_notice, context(establishment));
      updateEstablishment(deps.db, establishment.id, { pending_notice: null });
    } catch (error) {
      logError('whatsapp', error, context(establishment));
    }
  }
}

async function flushFullTexts(deps, phone) {
  for (const establishment of listEstablishmentsByPhone(deps.db, phone)) {
    for (const review of listPendingFullText(deps.db, establishment.id)) {
      try {
        await deps.whatsapp.sendText(phone, fullReviewMessage(review), context(establishment, review));
        updateReview(deps.db, establishment.id, review.review_id, { pending_full_text: 0 });
      } catch (error) {
        logError('whatsapp', error, context(establishment, review));
      }
    }
  }
}

async function readRemote(deps, establishment, reviewId) {
  try {
    return await deps.google.getReview(establishment, reviewId);
  } catch (error) {
    if (error.code === 'READ_UNSUPPORTED') return null;
    throw error;
  }
}

async function maybeUpdateGuide(deps, establishment) {
  const count = countEditedExamples(deps.db, establishment.id);
  if (!count || count % 5 !== 0) return;
  try {
    const examples = listEditedExamples(deps.db, establishment.id, 20);
    const guide = await deps.llm.updateStyleGuide(getEstablishment(deps.db, establishment.id), examples);
    if (guide && guide.trim()) {
      updateEstablishment(deps.db, establishment.id, { style_guide: guide.trim() });
    }
  } catch (error) {
    logError('llm', error, context(establishment));
  }
}

async function publishNow(deps, establishment, review, text, wasEdited, { userTurn = false } = {}) {
  const send = (body) => (userTurn
    ? replyToPhone(deps, establishment.owner_phone, body, establishment, review)
    : notifyText(deps, establishment, body, review));

  let remote = null;
  try {
    remote = await readRemote(deps, establishment, review.review_id);
  } catch (error) {
    logError('google', error, context(establishment, review));
    await send(PUBLISH_FAIL);
    return { published: false, reason: 'read_failed' };
  }

  if (remote?.hasReply) {
    updateReview(deps.db, establishment.id, review.review_id, {
      has_reply: 1,
      status: 'already_replied',
      final_reply: remote.replyComment || remote.comment || review.final_reply,
      approved_reply: null
    });
    clearAwaitingEdit(deps.db, establishment.owner_phone, review.review_id);
    await send(ALREADY);
    return { published: false, reason: 'already_replied' };
  }

  const day = dayKey(nowDate(deps));
  const fresh = getEstablishment(deps.db, establishment.id);
  if (publishedCountOn(deps.db, fresh.id, day) >= fresh.daily_limit) {
    updateReview(deps.db, establishment.id, review.review_id, {
      status: 'queued',
      approved_reply: text,
      publish_was_edited: wasEdited,
      final_reply: text
    });
    clearAwaitingEdit(deps.db, establishment.owner_phone, review.review_id);
    await send(`Limite du jour atteinte (${fresh.daily_limit} réponses). Je publierai celle-ci dès demain.`);
    return { published: false, deferred: true };
  }

  try {
    await deps.google.replyToReview(establishment, review.review_id, text);
  } catch (error) {
    logError('google', error, context(establishment, review));
    await send(PUBLISH_FAIL);
    return { published: false, reason: 'publish_failed' };
  }

  const publishedAt = nowDate(deps).toISOString();
  updateReview(deps.db, establishment.id, review.review_id, {
    status: 'published',
    has_reply: 1,
    final_reply: text,
    approved_reply: null,
    publish_was_edited: 0,
    published_at: publishedAt,
    published_day: day,
    reply_state: 'PENDING',
    pending_full_text: 0
  });
  insertExample(deps.db, {
    establishment_id: establishment.id,
    review_id: review.review_id,
    stars: review.stars,
    review_text: review.text,
    themes: themesOf(review),
    draft: review.draft || '',
    final: text,
    was_edited: wasEdited,
    source: wasEdited ? 'edited' : 'accepted',
    created_at: publishedAt
  });
  scheduleFollowup(deps.db, {
    establishment_id: establishment.id,
    review_id: review.review_id,
    run_at: nowMs(deps) + FOLLOWUP_30_MS,
    kind: '30m'
  });
  scheduleFollowup(deps.db, {
    establishment_id: establishment.id,
    review_id: review.review_id,
    run_at: nowMs(deps) + FOLLOWUP_24_MS,
    kind: '24h'
  });
  clearAwaitingEdit(deps.db, establishment.owner_phone, review.review_id);
  if (wasEdited) await maybeUpdateGuide(deps, establishment);
  await send(CONFIRM);
  return { published: true };
}

async function draftFor(deps, establishment, review) {
  const themes = themesOf(review);
  const examples = selectExamples(listExamples(deps.db, establishment.id), {
    stars: review.stars,
    text: review.text,
    themes,
    lang: review.lang,
    author: review.author,
    created_at: review.created_at
  });
  try {
    const draft = await deps.llm.generateDraft(establishment, {
      stars: review.stars,
      author: review.author,
      text: review.text,
      lang: review.lang,
      created_at: review.created_at,
      themes
    }, examples);
    if (draft?.reply) return draft;
  } catch (error) {
    logError('llm', error, context(establishment, review));
  }
  return fallbackDraft(establishment, review);
}

async function sendNext(deps, establishment) {
  const fresh = getEstablishment(deps.db, establishment.id);
  if (!fresh || hasInFlight(deps.db, fresh.id)) return;
  const next = nextQueuedDecision(deps.db, fresh);
  if (!next) return;

  const draft = await draftFor(deps, fresh, next);
  const session = getSession(deps.db, fresh.owner_phone);
  const open = isSessionOpen(session, nowMs(deps));
  let sent;
  try {
    sent = await deps.whatsapp.sendReviewAlert({
      to: fresh.owner_phone,
      establishment: fresh,
      review: next,
      draft: draft.reply,
      sessionOpen: open
    });
  } catch (error) {
    logError('whatsapp', error, context(fresh, next));
    return;
  }

  updateReview(deps.db, fresh.id, next.review_id, {
    status: 'sent_to_owner',
    draft: draft.reply,
    themes: draft.themes?.length ? draft.themes : themesOf(next),
    lang: draft.langue || next.lang,
    wa_message_id: sent.id || null,
    pending_full_text: sent.truncated ? 1 : 0
  });

  if (sent.truncated && open) {
    try {
      await deps.whatsapp.sendText(fresh.owner_phone, fullReviewMessage(next), context(fresh, next));
      updateReview(deps.db, fresh.id, next.review_id, { pending_full_text: 0 });
    } catch (error) {
      logError('whatsapp', error, context(fresh, next));
    }
  }
}

async function flushApproved(deps, establishment) {
  let guard = 0;
  while (guard < 50) {
    guard += 1;
    const fresh = getEstablishment(deps.db, establishment.id);
    if (publishedCountOn(deps.db, fresh.id, dayKey(nowDate(deps))) >= fresh.daily_limit) return;
    const row = nextApproved(deps.db, fresh.id);
    if (!row) return;
    const result = await publishNow(deps, fresh, row, row.approved_reply, Boolean(row.publish_was_edited), {
      userTurn: false
    });
    if (!result.published) return;
  }
}

async function drain(deps, establishmentId) {
  const establishment = getEstablishment(deps.db, establishmentId);
  if (!establishment) return;
  await flushApproved(deps, establishment);
  await sendNext(deps, establishment);
}

export function dispatchEstablishment(deps, establishmentId) {
  return withLock(`est:${establishmentId}`, () => drain(deps, establishmentId));
}

export async function dispatchAll(deps) {
  for (const establishment of listEstablishments(deps.db)) {
    await dispatchEstablishment(deps, establishment.id);
  }
}

async function continueAfterDecision(deps, establishmentId) {
  await sendNext(deps, getEstablishment(deps.db, establishmentId));
}

export async function handleInbound(deps, event) {
  const phone = normalizePhone(event.phone);
  const establishments = listEstablishmentsByPhone(deps.db, phone);
  if (!establishments.length) return { ignored: true };

  if (event.messageId && !rememberInbound(deps.db, event.messageId, nowMs(deps))) {
    return { duplicate: true };
  }

  touchSession(deps.db, phone, nowMs(deps));
  await flushNotices(deps, phone);
  await flushFullTexts(deps, phone);

  if (event.type === 'button') {
    const parsed = parseActionPayload(event.payload);
    if (!parsed) {
      await replyToPhone(deps, phone, OUT_OF_SCOPE, establishments[0]);
      return { outOfScope: true };
    }
    return handleAction(deps, phone, parsed);
  }

  const command = parseCommand(event.text);
  if (command === 'stop') {
    for (const establishment of establishments) pauseBacklog(deps.db, establishment.id);
    const session = getSession(deps.db, phone);
    const text = session?.awaiting_edit_review_id
      ? `${STOP_MSG} J'attends toujours ta version pour l'avis en cours.`
      : STOP_MSG;
    await replyToPhone(deps, phone, text, establishments[0]);
    return { paused: true };
  }
  if (command === 'reprendre') {
    for (const establishment of establishments) resumeBacklog(deps.db, establishment.id);
    await replyToPhone(deps, phone, RESUME_MSG, establishments[0]);
    for (const establishment of establishments) await dispatchEstablishment(deps, establishment.id);
    return { resumed: true };
  }

  const session = getSession(deps.db, phone);
  if (session?.awaiting_edit_review_id) {
    return publishOwnerEdit(deps, phone, session, event.text);
  }

  await replyToPhone(deps, phone, OUT_OF_SCOPE, establishments[0]);
  return { outOfScope: true };
}

async function publishOwnerEdit(deps, phone, session, text) {
  const clean = String(text || '').trim();
  const establishment = getEstablishment(deps.db, session.awaiting_edit_establishment_id);
  if (!clean) {
    await replyToPhone(deps, phone, EMPTY_EDIT, establishment);
    return { empty: true };
  }
  const review = establishment && getReview(deps.db, establishment.id, session.awaiting_edit_review_id);
  if (!establishment || !review) {
    clearAwaitingEdit(deps.db, phone);
    await replyToPhone(deps, phone, STALE, establishment);
    return { missing: true };
  }
  return withLock(`est:${establishment.id}`, async () => {
    const current = getReview(deps.db, establishment.id, review.review_id);
    const result = await publishNow(deps, establishment, current, clean, true, { userTurn: true });
    if (result.published || result.deferred || result.reason === 'already_replied') {
      await continueAfterDecision(deps, establishment.id);
    }
    return result;
  });
}

async function handleAction(deps, phone, parsed) {
  const match = findReviewForPhone(deps.db, phone, parsed.reviewId);
  if (!match) {
    await replyToPhone(deps, phone, STALE, listEstablishmentsByPhone(deps.db, phone)[0]);
    return { missing: true };
  }
  return withLock(`est:${match.establishment.id}`, async () => {
    const establishment = getEstablishment(deps.db, match.establishment.id);
    const review = getReview(deps.db, establishment.id, parsed.reviewId);
    if (!review || !ACTIONABLE.has(review.status)) {
      await replyToPhone(deps, phone, NOT_PENDING, establishment, review);
      return { stale: true };
    }
    if (parsed.action === 'IGNORE') {
      updateReview(deps.db, establishment.id, review.review_id, { status: 'ignored', pending_full_text: 0 });
      clearAwaitingEdit(deps.db, phone, review.review_id);
      await replyToPhone(deps, phone, IGNORE_ACK, establishment, review);
      await continueAfterDecision(deps, establishment.id);
      return { ignored: true };
    }
    if (parsed.action === 'EDIT') {
      updateReview(deps.db, establishment.id, review.review_id, { status: 'awaiting_edit' });
      setAwaitingEdit(deps.db, phone, review.review_id, establishment.id);
      await replyToPhone(deps, phone, EDIT_PROMPT, establishment, review);
      return { awaiting: true };
    }
    if (!review.draft) {
      updateReview(deps.db, establishment.id, review.review_id, { status: 'awaiting_edit' });
      setAwaitingEdit(deps.db, phone, review.review_id, establishment.id);
      await replyToPhone(deps, phone, EDIT_PROMPT, establishment, review);
      return { awaiting: true };
    }
    const result = await publishNow(deps, establishment, review, review.draft, false, { userTurn: true });
    if (result.published || result.deferred || result.reason === 'already_replied') {
      await continueAfterDecision(deps, establishment.id);
    }
    return result;
  });
}

export async function runOnboarding(deps, establishmentId) {
  const establishment = getEstablishment(deps.db, Number(establishmentId));
  if (!establishment) throw new Error(`Établissement ${establishmentId} introuvable`);
  const listed = await deps.google.listReviews(establishment);
  const now = nowDate(deps);
  for (const item of listed || []) {
    try {
      ingestReview(deps.db, establishment, item, { priority: 1, now, learnFromReply: true });
    } catch (error) {
      logError('onboard', error, { establishmentId: establishment.id, reviewId: item?.reviewId || item?.review_id });
    }
  }
  updateEstablishment(deps.db, establishment.id, { onboarded_at: now.toISOString() });
  const stats = queueStats(deps.db, establishment.id);
  const sentence = summarySentence(stats.total, stats.negative);
  await notifyText(deps, getEstablishment(deps.db, establishment.id), sentence);
  await dispatchEstablishment(deps, establishment.id);
  return { ...stats, sentence };
}

async function handleRejection(deps, establishment, review, reason) {
  deleteExamplesForReview(deps.db, establishment.id, review.review_id);
  const draft = await draftFor(deps, establishment, review);
  const reasonText = `Google a refusé la réponse à l'avis de ${review.author || 'ce client'} (${review.stars}/5). Raison : ${reason}.`;
  const basePatch = {
    reply_state: 'REJECTED',
    policy_violation: reason,
    draft: draft.reply,
    themes: draft.themes?.length ? draft.themes : themesOf(review),
    final_reply: null,
    approved_reply: null
  };

  if (hasInFlight(deps.db, establishment.id)) {
    updateReview(deps.db, establishment.id, review.review_id, {
      ...basePatch,
      status: 'queued',
      priority: 0,
      enqueued_at: nowDate(deps).toISOString()
    });
    await notifyText(deps, establishment, `${reasonText} Je te la repropose juste après l'avis en cours.`, review);
    return true;
  }

  updateReview(deps.db, establishment.id, review.review_id, { ...basePatch, status: 'published' });
  const session = getSession(deps.db, establishment.owner_phone);
  const open = isSessionOpen(session, nowMs(deps));
  try {
    if (open) await replyToPhone(deps, establishment.owner_phone, reasonText, establishment, review);
    else deferNotice(deps.db, establishment.id, reasonText);
    const sent = await deps.whatsapp.sendReviewAlert({
      to: establishment.owner_phone,
      establishment,
      review: { ...review, text: review.text },
      draft: draft.reply,
      sessionOpen: open
    });
    updateReview(deps.db, establishment.id, review.review_id, {
      status: 'rejected',
      wa_message_id: sent.id || null,
      pending_full_text: sent.truncated ? 1 : 0
    });
    return true;
  } catch (error) {
    logError('whatsapp', error, context(establishment, review));
    updateReview(deps.db, establishment.id, review.review_id, {
      ...basePatch,
      status: 'queued',
      priority: 0
    });
    return false;
  }
}

async function runOneFollowup(deps, row) {
  const establishment = getEstablishment(deps.db, row.establishment_id);
  const review = establishment && getReview(deps.db, establishment.id, row.review_id);
  if (!establishment || !review || review.status !== 'published') {
    markFollowup(deps.db, row.id, { done: true, attempts: row.attempts });
    return;
  }
  try {
    const state = await deps.google.getReplyState(establishment, review.review_id);
    if (!state?.supported) {
      markFollowup(deps.db, row.id, { done: true, attempts: row.attempts });
      return;
    }
    if (state.state === 'REJECTED') {
      const ok = await handleRejection(
        deps,
        establishment,
        review,
        state.policyViolation || 'non précisée'
      );
      if (!ok) {
        const attempts = Number(row.attempts || 0) + 1;
        markFollowup(deps.db, row.id, { done: attempts >= 3, attempts });
        return;
      }
      markFollowup(deps.db, row.id, { done: true, attempts: row.attempts });
      return;
    }
    if (state.state) {
      updateReview(deps.db, establishment.id, review.review_id, {
        reply_state: state.state,
        policy_violation: state.policyViolation || null
      });
    } else if (state.hasReply) {
      updateReview(deps.db, establishment.id, review.review_id, { reply_state: 'UNKNOWN' });
    }
    markFollowup(deps.db, row.id, { done: true, attempts: row.attempts });
  } catch (error) {
    logError('google', error, context(establishment, review));
    const attempts = Number(row.attempts || 0) + 1;
    markFollowup(deps.db, row.id, { done: attempts >= 3, attempts });
  }
}

export async function runDueFollowups(deps, now = nowMs(deps)) {
  const rows = dueFollowups(deps.db, now);
  for (const row of rows) {
    await withLock(`est:${row.establishment_id}`, () => runOneFollowup(deps, row));
  }
}

export function startScheduler(deps, intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS || 60000)) {
  const timer = setInterval(() => {
    runDueFollowups(deps).catch((error) => logError('scheduler', error, {}));
    dispatchAll(deps).catch((error) => logError('scheduler', error, {}));
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

function decodePubSub(body) {
  if (body?.message?.data) {
    return JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8'));
  }
  return body || {};
}

export async function handleNotification(deps, data) {
  const type = String(data.notificationType || data.type || '').toUpperCase();
  const reviewName = data.reviewName || (typeof data.review === 'string' ? data.review : null);
  if (type && !['NEW_REVIEW', 'UPDATED_REVIEW'].includes(type) && !reviewName && !data.reviewId && !data.review) {
    return { ignored: true };
  }

  const locationSource = data.locationName || data.location || data.locationId || '';
  const location = locationIdOf(locationSource);
  const account = accountIdOf(data.accountName || data.accountId || data.account || locationSource);
  let establishment = data.establishmentId ? getEstablishment(deps.db, data.establishmentId) : null;
  if (!establishment && location) establishment = findEstablishmentByLocation(deps.db, location, account || null);
  if (!establishment && data.ownerPhone) {
    establishment = listEstablishmentsByPhone(deps.db, data.ownerPhone)[0] || null;
  }
  if (!establishment) {
    logError('review-ingest', new Error('Établissement introuvable pour la notification'), {});
    return { missing: true };
  }

  let review = data.review && typeof data.review === 'object' ? data.review : null;
  if (!review && (data.reviewId || data.stars || data.starRating)) review = data;
  if (!review && reviewName) {
    try {
      review = await deps.google.getReview(establishment, reviewIdOf(reviewName));
    } catch (error) {
      logError('google', error, { establishmentId: establishment.id, reviewId: reviewIdOf(reviewName) });
      return { error: true };
    }
  }
  if (!review) return { ignored: true };

  const result = ingestReview(deps.db, establishment, review, { priority: 0, now: nowDate(deps) });
  if (result.queued || result.cancelled) await dispatchEstablishment(deps, establishment.id);
  return result;
}

export async function handlePubSub(deps, body) {
  try {
    return await handleNotification(deps, decodePubSub(body));
  } catch (error) {
    logError('pubsub', error, {});
    return { error: true };
  }
}

export function handleNewReview(deps, body) {
  return handleNotification(deps, body || {});
}

export async function handleWhatsAppWebhook(deps, body) {
  for (const event of extractWhatsAppEvents(body)) {
    try {
      await handleInbound(deps, event);
    } catch (error) {
      logError('whatsapp', error, {});
    }
  }
}
