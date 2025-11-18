// Input validation and utility functions

const { RATE_LIMIT_WINDOW, RATE_LIMIT_MAX_MESSAGES } = require('../config/constants');

const rateLimits = new Map();

// Sanitize user input (remove dangerous content)
function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    .trim()
    .slice(0, 100);
}

// Sanitize user names
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return 'Anon';
  return name
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+=/gi, '')
    .trim()
    .slice(0, 20) || 'Anon';
}

// Check rate limits
function checkRateLimit(connectionId) {
  const now = Date.now();
  const limit = rateLimits.get(connectionId);
  
  if (!limit || now > limit.resetTime) {
    rateLimits.set(connectionId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  if (limit.count >= RATE_LIMIT_MAX_MESSAGES) {
    return false;
  }
  
  limit.count++;
  return true;
}

// Clean up expired rate limit entries
function cleanupRateLimit(connectionId) {
  rateLimits.delete(connectionId);
}

// Pick first non-empty value from candidates
function pickFirst(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

// Extract headers from request (whitelist)
function pickHeaders(headers, allowSet) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = String(k).toLowerCase();
    if (allowSet.has(key)) out[k] = v;
  }
  return out;
}

// Build upstream URL
function buildUpstreamUrl(base, suffix, search) {
  const path = String(suffix || '').replace(/^\//, '');
  const qs = search ? String(search) : '';
  return `${base}${path}${qs}`;
}

module.exports = {
  sanitizeInput,
  sanitizeName,
  checkRateLimit,
  cleanupRateLimit,
  pickFirst,
  pickHeaders,
  buildUpstreamUrl
};

