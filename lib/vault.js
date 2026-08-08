// lib/vault.js
// intentionally-sync: vault hydrate/set is a one-time startup/operator concern.
// Encrypted secret store for the Node brain. AES-256-GCM at rest.
// Master key: AION_VAULT_MASTER_KEY (32+ bytes, or hex/base64). Env is seed only;
// values live in $LLM_GATEWAY_DATA_DIR/vault.enc.json encrypted.

import { createCipheriv, createDecipheriv, randomBytes, createHash, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(master) {
  const raw = String(master || '');
  if (!raw) throw new Error('AION_VAULT_MASTER_KEY required');
  // Accept hex (64 chars), base64, or passphrase
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch { /* fall through */ }
  return scryptSync(raw, 'aion-vault-v1', 32);
}

function encrypt(key, plaintext) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(key, blob) {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export class Vault {
  constructor({ path, masterKey } = {}) {
    this.path = path || join(process.env.LLM_GATEWAY_DATA_DIR || './data', 'vault.enc.json');
    this.masterKey = masterKey || process.env.AION_VAULT_MASTER_KEY || '';
    this._key = null;
    this._entries = {}; // name -> { ciphertext, fingerprint, category, label, updated_at }
    this._load();
  }

  get enabled() {
    return Boolean(this.masterKey);
  }

  _ensureKey() {
    if (!this._key) {
      if (!this.masterKey) throw new Error('vault_disabled');
      this._key = deriveKey(this.masterKey);
    }
    return this._key;
  }

  _load() {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      this._entries = raw.entries || {};
    } catch {
      this._entries = {};
    }
  }

  _save() {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, entries: this._entries }, null, 2));
  }

  list({ category } = {}) {
    const out = [];
    for (const [name, e] of Object.entries(this._entries)) {
      if (category && e.category !== category) continue;
      out.push({
        name,
        label: e.label || name,
        category: e.category || 'other',
        fingerprint: e.fingerprint,
        has_value: true,
        updated_at: e.updated_at,
        value_length: e.value_length || null,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    const e = this._entries[name];
    if (!e) return null;
    const key = this._ensureKey();
    return decrypt(key, e.ciphertext);
  }

  set(name, value, { category = 'other', label } = {}) {
    if (!name || value == null || value === '') throw new Error('name_and_value_required');
    const key = this._ensureKey();
    const ciphertext = encrypt(key, value);
    this._entries[name] = {
      ciphertext,
      fingerprint: fingerprint(value),
      category,
      label: label || name,
      updated_at: Date.now(),
      value_length: String(value).length,
    };
    this._save();
    // Hot-load into process.env for the running process (optional convenience)
    process.env[name] = String(value);
    return { name, fingerprint: this._entries[name].fingerprint, category };
  }

  delete(name) {
    if (!this._entries[name]) return false;
    delete this._entries[name];
    delete process.env[name];
    this._save();
    return true;
  }

  /** Apply all vault secrets into process.env (boot-time hydration). */
  hydrateEnv() {
    if (!this.enabled) return 0;
    let n = 0;
    for (const name of Object.keys(this._entries)) {
      try {
        process.env[name] = this.get(name);
        n++;
      } catch { /* skip corrupt */ }
    }
    return n;
  }
}

export function createVault(opts) {
  return new Vault(opts);
}
