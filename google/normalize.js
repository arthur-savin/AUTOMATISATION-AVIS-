const STAR_VALUES = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  STAR_RATING_UNSPECIFIED: null
};

export function locationIdOf(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/locations\/([^/]+)/);
  return match ? match[1] : text;
}

export function accountIdOf(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/accounts\/([^/]+)/);
  return match ? match[1] : text;
}

export function reviewIdOf(value) {
  if (!value) return '';
  const text = String(value);
  const match = text.match(/reviews\/([^/]+)/);
  return match ? match[1] : text;
}

export function normalizeStars(value) {
  if (typeof value === 'number' && value >= 1 && value <= 5) return value;
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    if (upper in STAR_VALUES) return STAR_VALUES[upper];
    const numeric = Number(value);
    if (numeric >= 1 && numeric <= 5) return numeric;
  }
  return null;
}

export function extractOriginalComment(comment) {
  if (!comment) return '';
  const marker = '(Original)';
  const index = comment.indexOf(marker);
  if (index === -1) return String(comment).trim();
  return comment.slice(index + marker.length).trim();
}

function mapReplyState(raw) {
  const reply = raw.reviewReply || raw.review_reply || {};
  const candidates = [raw.reviewReplyState, reply.state, reply.reviewReplyState, raw.state];
  const value = candidates.find((item) => typeof item === 'string' && item.trim());
  if (!value) return null;
  return value.trim().toUpperCase();
}

function mapPolicy(raw) {
  const reply = raw.reviewReply || raw.review_reply || {};
  const value = raw.policyViolation || reply.policyViolation || reply.rejectionReason || null;
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.reason || value.description || value.type || JSON.stringify(value);
}

export function normalizeGoogleReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reviewId = reviewIdOf(raw.reviewId || raw.review_id || raw.name);
  const stars = normalizeStars(raw.starRating ?? raw.stars ?? raw.star_rating);
  const reply = raw.reviewReply || raw.review_reply || null;
  const replyComment = reply?.comment || raw.replyComment || raw.reply_comment || null;
  return {
    reviewId,
    stars,
    author: raw.reviewer?.displayName || raw.author || 'Anonyme',
    text: extractOriginalComment(raw.comment ?? raw.text ?? ''),
    lang: raw.lang || raw.language || raw.commentLanguage || null,
    createdAt: raw.createTime || raw.createdAt || raw.created_at || raw.updateTime || null,
    hasReply: Boolean(replyComment) || Boolean(raw.hasReply),
    replyComment: replyComment || null,
    replyState: mapReplyState(raw),
    policyViolation: mapPolicy(raw)
  };
}
