# solwallet

Connect a Solana wallet from plain JavaScript. No dependencies, no build step,
no framework.

```js
import { wallet } from './solwallet.js';

await wallet.connect('phantom');
console.log(wallet.publicKey);   // '7xKq…' as a base58 string
```

About 3 KB. One file. Works from a `<script type="module">` tag with no
tooling at all.

## Why

`@solana/wallet-adapter` is excellent and brings a React tree, a provider
hierarchy and a few dozen packages with it. If your page is a page — not an
app — that is a lot of machinery to detect Phantom.

This does the four things that are actually hard, and nothing else:

- finds the wallets present in the page
- connects to one and handles a cancelled prompt as a normal outcome
- remembers the choice and reconnects silently next visit, with no prompt
- tells you when the account changes or the wallet disconnects on its own

It deliberately does **not** wrap signing. Once connected you hold the wallet's
own provider, so `signTransaction`, `signAndSendTransaction` and anything else
that wallet supports are available directly, with no layer in between to fall
behind:

```js
const signature = await wallet.provider.signAndSendTransaction(tx);
```

## Install

Copy the file, or:

```bash
npm install solwallet
```

## Use

### Connecting

```js
import { wallet, available } from './solwallet.js';

// show one button per wallet actually in the page
for (const { id, name } of available()) {
  addButton(name, () => wallet.connect(id));
}
```

With exactly one wallet present, `connect()` takes no argument.

### Reacting to state

`onChange` fires immediately with the current state, so there is no gap between
your first render and your first event:

```js
const stop = wallet.onChange(({ publicKey, reason }) => {
  button.textContent = publicKey ? wallet.short() : 'Connect wallet';
});
```

`reason` is `initial`, `connect`, `account`, `app` (you called `disconnect`) or
`wallet` (the wallet dropped the connection).

### Coming back

```js
await wallet.resume();   // reconnects without a prompt, or resolves to null
```

### Errors worth handling

Every failure carries a `code`:

| code | means |
| --- | --- |
| `NO_WALLET` | nothing is installed — show `installLinks()` |
| `REJECTED` | the person closed the prompt |
| `AMBIGUOUS` | several wallets present and none named; `error.available` lists them |
| `NOT_AVAILABLE` | you named a wallet that is not in this page |

```js
try {
  await wallet.connect();
} catch (e) {
  if (e.code === 'REJECTED') return;          // not an error worth showing
  if (e.code === 'NO_WALLET') showInstallers();
  else report(e);
}
```

## API

| | |
| --- | --- |
| `available(scope?)` | the wallets in the page, as `{ id, name, provider, url }` |
| `installLinks()` | download pages for the wallets it knows, for an empty state |
| `new SolWallet({ remember, storageKey })` | an instance; `remember: false` skips localStorage |
| `wallet` | a ready-made instance for the common case |
| `.connect(id?)` | opens the prompt, resolves to the address |
| `.resume()` | silent reconnect, resolves to the address or `null` |
| `.disconnect()` | |
| `.onChange(fn)` | subscribe, called once immediately, returns an unsubscribe |
| `.connected` `.publicKey` `.walletName` `.walletId` `.provider` | current state |
| `.short(chars = 4)` | `7xKq…9mAe` |
| `.signMessage(text)` | returns the raw signature bytes |

Also an `EventTarget`, so `connect`, `disconnect` and `change` work with
`addEventListener` if you prefer that.

## Wallets

Phantom, Solflare, Backpack, Glow and Coinbase Wallet are detected by name.
Anything else that injects `window.solana` is offered as "Browser wallet", so
a wallet this file has never heard of still works.

## Demo

Open `demo.html` from any static server:

```bash
npx serve .
```

## Tests

```bash
npm test
```

Thirteen tests, no network and no browser — the wallet is stood in for, so
the connect, account-change, disconnect, cancel and resume paths all run in
Node.

## Licence

MIT
