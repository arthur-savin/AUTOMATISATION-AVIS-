const locks = new Map();

export function normalizePhone(phone) {
  let value = String(phone || '').replace(/[^\d+]/g, '');
  if (value.startsWith('+')) value = value.slice(1);
  if (value.startsWith('00')) value = value.slice(2);
  return value;
}

export function dayKey(date = new Date(), timeZone = process.env.BUSINESS_TZ || 'Europe/Paris') {
  const value = date instanceof Date ? date : new Date(date);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(value);
  } catch {
    return value.toISOString().slice(0, 10);
  }
}

export function formatDate(iso, timeZone = process.env.BUSINESS_TZ || 'Europe/Paris') {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone, dateStyle: 'long' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function parseCommand(text) {
  const value = String(text || '').trim().toLowerCase().replace(/[!?.\s]+$/g, '');
  if (value === 'stop') return 'stop';
  if (value === 'reprendre') return 'reprendre';
  return null;
}

export function logError(scope, err, context = {}) {
  console.error(JSON.stringify({
    level: 'error',
    scope,
    message: err?.message || String(err),
    reviewId: context.reviewId || null,
    establishmentId: context.establishmentId ?? null,
    stack: err?.stack || null
  }));
}

export function logInfo(scope, message, context = {}) {
  console.log(JSON.stringify({
    level: 'info',
    scope,
    message,
    reviewId: context.reviewId || null,
    establishmentId: context.establishmentId ?? null
  }));
}

/**
 * Sérialise les traitements d'un établissement. Le verrou n'est pas réentrant :
 * une fonction qui le tient ne doit pas le reprendre.
 */
export function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const settled = run.then(() => {}, () => {});
  locks.set(key, settled);
  return run;
}
