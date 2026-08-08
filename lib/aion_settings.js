// lib/aion_settings.js
// Mirrors AION v2 backend's app/settings.py — a frozen object built from env.
// All values are read at startup. AION_API_KEYS / AION_ADMIN_KEYS must be set in
// production or the auth layer refuses all requests.

import { createHash } from 'node:crypto';

function csv(v) { return (v || '').split(',').map(s => s.trim()).filter(Boolean); }

function fromEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === null) return def;
  return String(v).trim();
}

function num(name, def, min, max) {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

class AionSettings {
  constructor() {
    this.appName = 'AION';
    this.appVersion = fromEnv('APP_VERSION', '2.4.0');
    this.environment = fromEnv('ENVIRONMENT', 'production');
    this.apiKeys = csv(fromEnv('AION_API_KEYS', ''));
    this.adminKeys = csv(fromEnv('AION_ADMIN_KEYS', ''));
    this.corsOrigins = csv(fromEnv('CORS_ORIGINS', '*'));
    this.primaryModel = fromEnv('PRIMARY_MODEL', 'gpt-4o-mini');
    this.fallbackModels = csv(fromEnv('FALLBACK_MODELS', 'gpt-4o,nvidia/nemotron-3-super-120b-a12b,deepseek/deepseek-chat'));
    this.maxContextMessages = num('MAX_CONTEXT_MESSAGES', 40, 2, 200);
    this.maxMessageChars = num('MAX_MESSAGE_CHARS', 100_000, 1000, 1_000_000);
    this.minCompletionTokens = num('MIN_COMPLETION_TOKENS', 32, 1, 4096);
    this.maxCompletionTokens = num('MAX_COMPLETION_TOKENS', 4096, 64, 32768);
    this.requestTimeoutSeconds = num('REQUEST_TIMEOUT_SECONDS', 60, 5, 600);
  }

  isAdminKey(token) {
    return this.adminKeys.some(k => safeEq(k, token));
  }
  isUserKey(token) {
    return this.apiKeys.some(k => safeEq(k, token));
  }
  authRequired() {
    // Like the Python version: production must have keys; dev can opt out
    if (this.environment !== 'production') {
      return process.env.ALLOW_UNAUTHENTICATED_DEV === 'true' ? false : true;
    }
    return true;
  }
  subjectFor(token) {
    if (!token) return 'anonymous';
    return 'key_' + createHash('sha256').update(token).digest('hex').slice(0, 16);
  }
  validateStartup() {
    if (this.authRequired() && this.apiKeys.length === 0) {
      throw new Error('AION_API_KEYS must be configured in production');
    }
    if (this.authRequired() && this.adminKeys.length === 0) {
      throw new Error('AION_ADMIN_KEYS must be configured in production');
    }
    const overlap = this.apiKeys.filter(k => this.adminKeys.includes(k));
    if (overlap.length > 0) throw new Error('User and admin API keys must be distinct');
  }
}

function safeEq(a, b) {
  // Null-safe: missing tokens never match; never throw on undefined/null.
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const aionSettings = new AionSettings();
