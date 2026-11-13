import { logError } from '../util.js';
import { ProviderError } from './errors.js';
import { accountIdOf, locationIdOf, normalizeGoogleReview, reviewIdOf } from './normalize.js';

const tokenCache = new Map();

function paths(establishment) {
  const account = accountIdOf(establishment.google_account_id);
  const location = locationIdOf(establishment.location_id);
  if (!account || !location) {
    throw new ProviderError('CONFIG', 'google_account_id ou location_id manquant pour cet établissement');
  }
  return { account, location };
}

function refreshTokenOf(establishment) {
  let stored = establishment.google_tokens;
  if (typeof stored === 'string' && stored.trim()) {
    try {
      stored = JSON.parse(stored);
    } catch {
      stored = { refresh_token: stored };
    }
  }
  return stored?.refresh_token || process.env.GOOGLE_REFRESH_TOKEN || '';
}

export function createGbpApiProvider({
  fetchImpl = fetch,
  clientId = process.env.GOOGLE_CLIENT_ID,
  clientSecret = process.env.GOOGLE_CLIENT_SECRET,
  tokenUrl = 'https://oauth2.googleapis.com/token',
  apiBase = 'https://mybusiness.googleapis.com'
} = {}) {
  async function accessToken(establishment, context) {
    const refreshToken = refreshTokenOf(establishment);
    if (!refreshToken) {
      throw new ProviderError('AUTH', 'Refresh token Google manquant (google_tokens ou GOOGLE_REFRESH_TOKEN)');
    }
    if (!clientId || !clientSecret) {
      throw new ProviderError('AUTH', 'GOOGLE_CLIENT_ID ou GOOGLE_CLIENT_SECRET manquant');
    }
    const cached = tokenCache.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20000)
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new ProviderError('AUTH', `OAuth Google HTTP ${response.status} : ${raw.slice(0, 300)}`);
      logError('google', error, context);
      throw error;
    }
    const data = JSON.parse(raw);
    tokenCache.set(refreshToken, {
      token: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000)
    });
    return data.access_token;
  }

  async function request(establishment, url, options, context) {
    const token = await accessToken(establishment, context);
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(20000)
    });
    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const detail = data?.error?.message || raw.slice(0, 300);
      const error = new ProviderError('HTTP', `Google HTTP ${response.status} : ${detail}`);
      error.status = response.status;
      logError('google', error, context);
      throw error;
    }
    return data;
  }

  function reviewsUrl(establishment) {
    const { account, location } = paths(establishment);
    return `${apiBase}/v4/accounts/${encodeURIComponent(account)}/locations/${encodeURIComponent(location)}/reviews`;
  }

  return {
    kind: 'api',

    async listReviews(establishment) {
      const all = [];
      const seenTokens = new Set();
      let pageToken = '';
      let pages = 0;
      do {
        if (pageToken) {
          if (seenTokens.has(pageToken)) break;
          seenTokens.add(pageToken);
        }
        const url = new URL(reviewsUrl(establishment));
        url.searchParams.set('pageSize', '50');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const page = await request(establishment, url, { method: 'GET' }, {
          establishmentId: establishment.id
        });
        for (const item of page?.reviews || []) {
          const normalized = normalizeGoogleReview(item);
          if (normalized?.reviewId) all.push(normalized);
        }
        pageToken = page?.nextPageToken || '';
        pages += 1;
      } while (pageToken && pages < 100);
      return all;
    },

    async getReview(establishment, reviewId) {
      const id = reviewIdOf(reviewId);
      const context = { establishmentId: establishment.id, reviewId: id };
      const direct = `${reviewsUrl(establishment)}/${encodeURIComponent(id)}`;
      try {
        const data = await request(establishment, direct, { method: 'GET' }, context);
        const normalized = normalizeGoogleReview(data?.review || data);
        if (normalized?.reviewId) return normalized;
      } catch (error) {
        if (error.status !== 404 && error.status !== 400) throw error;
      }

      let pageToken = '';
      let pages = 0;
      do {
        const url = new URL(reviewsUrl(establishment));
        url.searchParams.set('pageSize', '50');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const page = await request(establishment, url, { method: 'GET' }, context);
        for (const item of page?.reviews || []) {
          const normalized = normalizeGoogleReview(item);
          if (normalized?.reviewId === id) return normalized;
        }
        pageToken = page?.nextPageToken || '';
        pages += 1;
      } while (pageToken && pages < 20);

      throw new ProviderError('NOT_FOUND', `Avis ${id} introuvable sur la fiche Google`);
    },

    async replyToReview(establishment, reviewId, comment) {
      const id = reviewIdOf(reviewId);
      const context = { establishmentId: establishment.id, reviewId: id };
      const url = `${reviewsUrl(establishment)}/${encodeURIComponent(id)}/reply`;
      return request(establishment, url, {
        method: 'PUT',
        body: JSON.stringify({ comment })
      }, context);
    },

    async getReplyState(establishment, reviewId) {
      const review = await this.getReview(establishment, reviewId);
      return {
        supported: true,
        state: review.replyState || null,
        policyViolation: review.policyViolation || null,
        hasReply: review.hasReply,
        comment: review.replyComment || null
      };
    }
  };
}
