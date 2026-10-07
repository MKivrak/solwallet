/**
 * solwallet — connect a Solana wallet from plain JavaScript.
 *
 * No dependencies, no build step, no framework. One ES module that finds the
 * injected wallets in the page, connects to one, remembers the choice, and
 * tells you when the account changes.
 *
 * It deliberately does not wrap signing. Once connected you hold the wallet's
 * own provider object, so `signTransaction`, `signAndSendTransaction` and the
 * rest are whatever that wallet implements, with no layer in between to go out
 * of date.
 *
 * MIT licensed.
 */

const STORAGE_KEY = 'solwallet.last';

/** Wallets that announce themselves on `window`, in the order we prefer them. */
const KNOWN = [
  {
    id: 'phantom', name: 'Phantom', url: 'https://phantom.app/download',
    find: (w) => (w.phantom?.solana?.isPhantom ? w.phantom.solana : w.solana?.isPhantom ? w.solana : null),
  },
  { id: 'solflare', name: 'Solflare', url: 'https://solflare.com/download', find: (w) => (w.solflare?.isSolflare ? w.solflare : null) },
  { id: 'backpack', name: 'Backpack', url: 'https://backpack.app/download', find: (w) => (w.backpack?.isBackpack ? w.backpack : null) },
  { id: 'glow', name: 'Glow', url: 'https://glow.app', find: (w) => w.glow ?? null },
  { id: 'coinbase', name: 'Coinbase Wallet', url: 'https://www.coinbase.com/wallet', find: (w) => w.coinbaseSolana ?? null },
];

/** Every wallet currently present in the page. */
export function available(scope = globalThis) {
  const out = [];
  for (const entry of KNOWN) {
    const provider = entry.find(scope);
    if (provider) out.push({ id: entry.id, name: entry.name, provider, url: entry.url });
  }
  // something injected `window.solana` without identifying itself
  if (!out.length && scope.solana) {
    out.push({ id: 'injected', name: 'Browser wallet', provider: scope.solana, url: null });
  }
  return out;
}

/** Download pages for the wallets we know about, for an empty state. */
export const installLinks = () => KNOWN.map(({ id, name, url }) => ({ id, name, url }));

export class SolWallet extends EventTarget {
  #provider = null;
  #id = null;
  #name = null;
  #publicKey = null;
  #onDisconnect = null;
  #onAccountChanged = null;

  /** @param {{ remember?: boolean, storageKey?: string }} [options] */
  constructor({ remember = true, storageKey = STORAGE_KEY } = {}) {
    super();
    this.remember = remember;
    this.storageKey = storageKey;
  }

  get connected() { return Boolean(this.#publicKey); }
  /** base58 address, or null */
  get publicKey() { return this.#publicKey; }
  get walletName() { return this.#name; }
  get walletId() { return this.#id; }
  /** The wallet's own provider. Sign with this. */
  get provider() { return this.#provider; }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #store(id) {
    if (!this.remember) return;
    try {
      if (id) localStorage.setItem(this.storageKey, id);
      else localStorage.removeItem(this.storageKey);
    } catch { /* private mode or blocked storage: not worth failing over */ }
  }

  #read() {
    if (!this.remember) return null;
    try { return localStorage.getItem(this.storageKey); } catch { return null; }
  }

  #attach(entry, publicKey) {
    this.#provider = entry.provider;
    this.#id = entry.id;
    this.#name = entry.name;
    this.#publicKey = publicKey?.toString?.() ?? null;

    this.#onDisconnect = () => this.#teardown('wallet');
    this.#onAccountChanged = (key) => {
      const next = key?.toString?.() ?? null;
      if (!next) return this.#teardown('wallet');
      this.#publicKey = next;
      this.#emit('change', { publicKey: next, reason: 'account' });
    };
    entry.provider.on?.('disconnect', this.#onDisconnect);
    entry.provider.on?.('accountChanged', this.#onAccountChanged);

    this.#store(entry.id);
    this.#emit('connect', { publicKey: this.#publicKey, wallet: this.#name });
    this.#emit('change', { publicKey: this.#publicKey, reason: 'connect' });
  }

  #teardown(reason) {
    const provider = this.#provider;
    if (provider?.off) {
      if (this.#onDisconnect) provider.off('disconnect', this.#onDisconnect);
      if (this.#onAccountChanged) provider.off('accountChanged', this.#onAccountChanged);
    }
    this.#provider = null;
    this.#id = null;
    this.#name = null;
    this.#publicKey = null;
    this.#onDisconnect = null;
    this.#onAccountChanged = null;
    this.#store(null);
    this.#emit('disconnect', { reason });
    this.#emit('change', { publicKey: null, reason });
  }

  /**
   * Connect, opening the wallet's approval prompt.
   * @param {string} [walletId] which wallet; omit when only one is present.
   * @returns {Promise<string>} the connected address
   */
  async connect(walletId) {
    const found = available();
    if (!found.length) {
      const error = new Error('No Solana wallet is installed in this browser.');
      error.code = 'NO_WALLET';
      throw error;
    }
    const entry = walletId
      ? found.find((w) => w.id === walletId)
      : (found.length === 1 ? found[0] : null);

    if (!entry) {
      const error = new Error(walletId
        ? `${walletId} is not available in this browser.`
        : 'Several wallets are available — pass one of their ids to connect().');
      error.code = walletId ? 'NOT_AVAILABLE' : 'AMBIGUOUS';
      error.available = found.map(({ id, name }) => ({ id, name }));
      throw error;
    }

    try {
      const result = await entry.provider.connect();
      const key = result?.publicKey ?? entry.provider.publicKey;
      if (!key) throw new Error('The wallet connected without returning an address.');
      this.#attach(entry, key);
      return this.#publicKey;
    } catch (cause) {
      if (/reject|denied|cancel|user/i.test(cause?.message || '')) {
        const error = new Error('You cancelled the connection.');
        error.code = 'REJECTED';
        error.cause = cause;
        throw error;
      }
      throw cause;
    }
  }

  /**
   * Reconnect silently if this browser already trusts the site. Opens no prompt.
   * @returns {Promise<string|null>} the address, or null if there was nothing to resume
   */
  async resume() {
    const id = this.#read();
    if (!id) return null;
    const entry = available().find((w) => w.id === id);
    if (!entry?.provider?.connect) return null;
    try {
      const result = await entry.provider.connect({ onlyIfTrusted: true });
      const key = result?.publicKey ?? entry.provider.publicKey;
      if (!key) return null;
      this.#attach(entry, key);
      return this.#publicKey;
    } catch {
      return null;   // not trusted, or the wallet is locked
    }
  }

  async disconnect() {
    try { await this.#provider?.disconnect?.(); } catch { /* already gone */ }
    if (this.connected) this.#teardown('app');
  }

  /**
   * Subscribe to every state change. Called once immediately with the current
   * state, so there is no gap between first render and first event.
   * @returns {() => void} unsubscribe
   */
  onChange(listener) {
    const wrapped = (event) => listener(event.detail);
    this.addEventListener('change', wrapped);
    listener({ publicKey: this.#publicKey, reason: 'initial' });
    return () => this.removeEventListener('change', wrapped);
  }

  /** `7xKq…9mAe` — for buttons. */
  short(chars = 4) {
    if (!this.#publicKey) return '';
    return this.#publicKey.slice(0, chars) + '…' + this.#publicKey.slice(-chars);
  }

  /** Sign a UTF-8 string. Returns the raw signature bytes. */
  async signMessage(message, encoding = 'utf8') {
    if (!this.#provider?.signMessage) throw new Error('This wallet cannot sign messages.');
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    const result = await this.#provider.signMessage(bytes, encoding);
    return result?.signature ?? result;
  }
}

/** A ready-made instance for the common case. */
export const wallet = new SolWallet();
export default SolWallet;
