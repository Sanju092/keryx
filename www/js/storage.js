(function (globalScope) {
  'use strict';

  const DB_NAME = 'keryx_platform_db';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  const STATE_RECORD_KEY = 'primary_state';
  const LEGACY_LS_KEY = 'keryx_platform_state_v1';

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open error'));
    });
  }

  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, val) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(val, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  function loadLegacyLocalStorage() {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(LEGACY_LS_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  async function loadPersistedState() {
    try {
      const fromIdb = await idbGet(STATE_RECORD_KEY);
      if (fromIdb && typeof fromIdb === 'object') {
        return { state: fromIdb, source: 'indexeddb' };
      }
    } catch (e) {}
    const legacy = loadLegacyLocalStorage();
    if (legacy) {
      try { await idbSet(STATE_RECORD_KEY, legacy); } catch (e) {}
      return { state: legacy, source: 'localstorage-migrated' };
    }
    return { state: null, source: 'default' };
  }

  async function savePersistedState(state) {
    let savedIdb = false;
    try {
      await idbSet(STATE_RECORD_KEY, state);
      savedIdb = true;
    } catch (e) {}
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(LEGACY_LS_KEY, JSON.stringify(state));
      }
    } catch (e) {
      // Ignore QuotaExceededError on mirror when IndexedDB already persisted
      if (!savedIdb) throw e;
    }
    return savedIdb ? 'indexeddb' : 'localstorage';
  }

  // Optional WebCrypto AES-GCM Passphrase Encryption for Vault Secrets
  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveAesKey(passphrase, saltBytes) {
    const cryptoObj = globalScope.crypto;
    if (!cryptoObj || !cryptoObj.subtle) {
      throw new Error('WebCrypto subtle API unavailable');
    }
    const enc = new TextEncoder();
    const baseKey = await cryptoObj.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return cryptoObj.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptVaultSecrets(secretsObj, passphrase) {
    const cryptoObj = globalScope.crypto;
    const salt = cryptoObj.getRandomValues(new Uint8Array(16));
    const iv = cryptoObj.getRandomValues(new Uint8Array(12));
    const key = await deriveAesKey(passphrase, salt);
    const enc = new TextEncoder();
    const ctBuf = await cryptoObj.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      enc.encode(JSON.stringify(secretsObj))
    );
    return {
      v: 1,
      alg: 'AES-GCM',
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ctBuf))
    };
  }

  async function decryptVaultSecrets(payload, passphrase) {
    if (!payload || !payload.ct || !payload.salt || !payload.iv) {
      throw new Error('Invalid encrypted vault payload');
    }
    const salt = base64ToBytes(payload.salt);
    const iv = base64ToBytes(payload.iv);
    const ct = base64ToBytes(payload.ct);
    const key = await deriveAesKey(passphrase, salt);
    const plainBuf = await globalScope.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct
    );
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(plainBuf));
  }

  function exportBackupJson(state, includeSecrets) {
    const clone = JSON.parse(JSON.stringify(state));
    if (!includeSecrets) {
      if (clone.providers) {
        Object.values(clone.providers).forEach(p => { if (p && p.apiKey) p.apiKey = '***REDACTED***'; });
      }
      if (Array.isArray(clone.connectors)) {
        clone.connectors.forEach(c => {
          if (c.botToken) c.botToken = '***REDACTED***';
          if (c.webhookUrl) c.webhookUrl = '***REDACTED***';
        });
      }
      if (clone.search && clone.search.apiKey) clone.search.apiKey = '***REDACTED***';
    }
    return JSON.stringify(clone, null, 2);
  }

  function parseBackupJson(rawText) {
    const parsed = JSON.parse(String(rawText || ''));
    if (!parsed || typeof parsed !== 'object' || !parsed.ui || !Array.isArray(parsed.agents) || !Array.isArray(parsed.wiki)) {
      throw new Error('Invalid Keryx backup JSON (missing ui, agents, or wiki)');
    }
    return parsed;
  }

  const api = {
    loadPersistedState,
    savePersistedState,
    encryptVaultSecrets,
    decryptVaultSecrets,
    exportBackupJson,
    parseBackupJson
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.KeryxStorage = api;
})(typeof window !== 'undefined' ? window : globalThis);
