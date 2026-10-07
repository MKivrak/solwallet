import test from 'node:test';
import assert from 'node:assert/strict';
import { SolWallet, available, installLinks } from './solwallet.js';

/** A stand-in for an injected wallet, so the whole flow can run without a browser. */
function fakeWallet(address = 'Fake1111111111111111111111111111111111111111') {
  const handlers = {};
  return {
    isPhantom: true,
    publicKey: { toString: () => address },
    on(event, fn) { handlers[event] = fn; },
    off(event) { delete handlers[event]; },
    connect: async ({ onlyIfTrusted } = {}) => {
      if (onlyIfTrusted && !handlers.__trusted) throw new Error('not trusted');
      return { publicKey: { toString: () => address } };
    },
    disconnect: async () => {},
    signMessage: async (bytes) => ({ signature: bytes }),
    handlers,
  };
}

const withPhantom = (provider, run) => {
  globalThis.phantom = { solana: provider };
  try { return run(); } finally { delete globalThis.phantom; }
};

test('an empty page offers no wallets but does list installers', () => {
  assert.deepEqual(available({}), []);
  const links = installLinks();
  assert.ok(links.length >= 3);
  assert.ok(links.every((l) => l.name && l.id));
  assert.ok(links.find((l) => l.id === 'phantom').url.startsWith('https://'));
});

test('an unidentified window.solana still counts as a wallet', () => {
  const found = available({ solana: { connect: async () => ({}) } });
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'injected');
});

test('a fresh instance is empty and safe to read', () => {
  const w = new SolWallet({ remember: false });
  assert.equal(w.connected, false);
  assert.equal(w.publicKey, null);
  assert.equal(w.walletName, null);
  assert.equal(w.provider, null);
  assert.equal(w.short(), '');
});

test('connecting with nothing installed says so, by code', async () => {
  const w = new SolWallet({ remember: false });
  await assert.rejects(() => w.connect(), (e) => e.code === 'NO_WALLET');
});

test('naming a wallet that is not there says so, by code', async () => {
  const w = new SolWallet({ remember: false });
  await withPhantom(fakeWallet(), async () => {
    await assert.rejects(() => w.connect('solflare'), (e) => e.code === 'NOT_AVAILABLE');
  });
});

test('two wallets without a choice is an error that lists them', async () => {
  const w = new SolWallet({ remember: false });
  globalThis.phantom = { solana: fakeWallet() };
  globalThis.solflare = { isSolflare: true, connect: async () => ({}) };
  try {
    await assert.rejects(() => w.connect(), (e) => {
      assert.equal(e.code, 'AMBIGUOUS');
      assert.deepEqual(e.available.map((x) => x.id), ['phantom', 'solflare']);
      return true;
    });
  } finally {
    delete globalThis.phantom;
    delete globalThis.solflare;
  }
});

test('connect, account change and disconnect each report once', async () => {
  const provider = fakeWallet();
  const w = new SolWallet({ remember: false });
  const reasons = [];
  w.onChange((s) => reasons.push(s.reason));
  assert.deepEqual(reasons, ['initial'], 'onChange must fire immediately');

  await withPhantom(provider, async () => {
    const key = await w.connect('phantom');
    assert.equal(key, 'Fake1111111111111111111111111111111111111111');
    assert.equal(w.connected, true);
    assert.equal(w.walletName, 'Phantom');
    assert.equal(w.walletId, 'phantom');
    assert.equal(w.provider, provider, 'the wallet’s own provider must be exposed for signing');
    assert.equal(w.short(), 'Fake…1111');
    assert.equal(w.short(6), 'Fake11…111111');

    provider.handlers.accountChanged({ toString: () => 'Other222222222222222222222222222222222222222' });
    assert.equal(w.publicKey, 'Other222222222222222222222222222222222222222');

    await w.disconnect();
    assert.equal(w.connected, false);
    assert.equal(w.publicKey, null);
  });

  assert.deepEqual(reasons, ['initial', 'connect', 'account', 'app']);
});

test('the wallet disconnecting on its own is reported too', async () => {
  const provider = fakeWallet();
  const w = new SolWallet({ remember: false });
  await withPhantom(provider, async () => {
    await w.connect('phantom');
    const seen = [];
    w.addEventListener('disconnect', (e) => seen.push(e.detail.reason));
    provider.handlers.disconnect();
    assert.deepEqual(seen, ['wallet']);
    assert.equal(w.connected, false);
  });
});

test('a cancelled prompt is a REJECTED error, not a raw wallet message', async () => {
  const provider = fakeWallet();
  provider.connect = async () => { throw new Error('User rejected the request.'); };
  const w = new SolWallet({ remember: false });
  await withPhantom(provider, async () => {
    await assert.rejects(() => w.connect('phantom'), (e) => {
      assert.equal(e.code, 'REJECTED');
      assert.match(e.message, /cancelled/);
      return true;
    });
  });
  assert.equal(w.connected, false);
});

test('resume returns null rather than throwing when there is nothing to resume', async () => {
  const w = new SolWallet({ remember: false });
  assert.equal(await w.resume(), null);
});

test('unsubscribing stops the listener', async () => {
  const provider = fakeWallet();
  const w = new SolWallet({ remember: false });
  let count = 0;
  const off = w.onChange(() => count++);
  assert.equal(count, 1);
  off();
  await withPhantom(provider, () => w.connect('phantom'));
  assert.equal(count, 1, 'no further calls after unsubscribing');
});

test('signMessage encodes a string and hands back the signature', async () => {
  const provider = fakeWallet();
  const w = new SolWallet({ remember: false });
  await withPhantom(provider, async () => {
    await w.connect('phantom');
    const signature = await w.signMessage('hello');
    assert.deepEqual([...signature], [...new TextEncoder().encode('hello')]);
  });
});

test('signMessage refuses clearly when the wallet cannot sign', async () => {
  const provider = fakeWallet();
  delete provider.signMessage;
  const w = new SolWallet({ remember: false });
  await withPhantom(provider, async () => {
    await w.connect('phantom');
    await assert.rejects(() => w.signMessage('hi'), /cannot sign messages/);
  });
});
