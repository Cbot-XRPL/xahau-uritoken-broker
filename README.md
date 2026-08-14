# Xahau URIToken Broker Hook

An **ephemeral broker hook** for URIToken (NFT) marketplace sales on [Xahau](https://xahau.network).

A buyer sends a single native-XAH `Payment` to the broker account carrying the token id and their max
acceptable ask. The hook does the rest on-chain — it buys the listed URIToken, delivers it to the buyer, and
routes a broker fee to a configured wallet. No custody, no escrow account, no off-chain keeper: the broker
account only ever holds the token for the moment between buying it and remitting it.

## How it works

Trigger: an incoming **native-XAH `Payment`** to the broker account with these transaction parameters:

| Param  | Type              | Meaning                                    |
|--------|-------------------|--------------------------------------------|
| `NFTID`| 32-byte URITokenID| the token the buyer wants                  |
| `BUY`  | 8-byte uint64     | max live ask (drops) the buyer will accept |

Runtime flow:

1. Read the live URIToken object for `NFTID`.
2. Require a native-XAH open sell offer, and require the payment to equal **live ask + broker fee** exactly.
3. Emit `URITokenBuy` from the broker account.
4. On callback success, emit `Remit` to send the bought token to the buyer.
5. On callback success, emit `Payment` of the net broker fee to the fee wallet.
6. On buy failure, emit a refund `Payment` back to the buyer.

### Known limitation (read this)

Emitted transactions settle on later ledgers, so the hook can fully auto-refund a **failed buy**, but it cannot
guarantee a perfect atomic rollback if a later remit/fee leg fails **after** a successful buy. It preflights the
known receipt blockers aggressively to make remit failure rare, and preserves stuck callback state under the
broker account for operator recovery. Treat the broker as an intermediary you monitor, not a trustless vault.

## Install parameters

Set when the hook is installed (see `scripts/install.js`):

| Param    | Type          | Meaning                                              |
|----------|---------------|------------------------------------------------------|
| `FEEDEST`| ascii r-addr  | wallet that receives the broker fee (required)       |
| `FEEBPS` | uint32        | fee in basis points, `0..10000` (e.g. `250` = 2.5%)  |

## Build

The hook compiles on the public Xahau **buildbox** — no local C toolchain, Docker, or `hookapi.h` needed
(the buildbox supplies the header server-side; the source only includes `hookapi.h` + `<stdint.h>`).

```bash
npm install        # pulls @transia/hooks-toolkit-cli
npm run build      # src/broker.c -> build/broker.wasm, prints the HookHash
```

Override the buildbox with `HOOKS_COMPILE_HOST` if you run your own. A prebuilt `build/broker.wasm` is
included so you can install without building.

## Deploy

The broker must be a **fresh, dedicated account** — it briefly holds sold tokens, so don't reuse a funded wallet.

1. Generate a new Xahau account and fund it with ~5 XAH.
2. Provide its seed via `BROKER_SEED` (env) or `config/broker.json` (`{"seed":"s..."}` — gitignored).
3. Set `FEEDEST` (fee wallet) and optionally `FEEBPS` (default 250).

```bash
# dry run — prints the plan, signs nothing
FEEDEST=rYourFeeWallet... BROKER_SEED=s... node scripts/install.js --network mainnet

# apply — signs the SetHook from the broker account and submits
FEEDEST=rYourFeeWallet... BROKER_SEED=s... node scripts/install.js --network mainnet --apply
```

`--network testnet` targets Xahau testnet. The installer refuses to run if the broker already carries a hook
(it expects a clean account) and caps the SetHook fee at 20 XAH.

### Keep the seed off any server

Run the installer **locally**. A public API/marketplace server never needs the broker seed — the hook signs its
own emitted transactions on-chain; the server only builds the buyer's unsigned `Payment` and reads chain state.
Keep `BROKER_SEED` / `config/broker.json` out of git (already in `.gitignore`).

## Layout

```
src/broker.c        the hook source (C)
build/broker.wasm   prebuilt binary (rebuild with `npm run build`)
scripts/build.js    compile via the Xahau buildbox
scripts/install.js  install on a dedicated broker account (mainnet/testnet)
```

## Provenance

Derived from the "Ephemeral Broker Hook" reference in the Xahau hooks toolkit example set. A reference
deployment runs on Xahau mainnet as the marketplace broker for the Odin's Eyes raven-license NFT.

## License

MIT
