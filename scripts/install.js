/* INSTALL the broker hook on a DEDICATED broker account (Xahau mainnet or testnet).
 *
 * The broker is a FRESH, dedicated intermediary account — it momentarily holds a sold URIToken between the
 * URITokenBuy and the Remit to the buyer. Give it its OWN account; do not reuse a wallet that holds funds.
 *
 * Config (env, or a gitignored config/broker.json):
 *   BROKER_SEED   — the broker account's family seed (s...). REQUIRED. Never commit it.
 *                   (Alternatively put {"seed":"s...","address":"r..."} in config/broker.json.)
 *   FEEDEST       — r-address that receives the broker fee. REQUIRED.
 *   FEEBPS        — fee in basis points, 0..10000 (default 250 = 2.5%).
 *   NAMESPACE     — label hashed to the hook namespace (default "uritoken-broker"; any value works, it only
 *                   isolates this account's hook state).
 *
 *   node scripts/install.js --network mainnet            # DRY RUN (prints, signs nothing)
 *   node scripts/install.js --network mainnet --apply    # sign SetHook from the broker + submit
 *
 * Fund the broker with ~5 XAH first. Run this locally — it signs with the broker seed; a public server should
 * never hold this seed (the hook signs its own emitted txns on-chain, the server just reads state).
 */
const fs = require("fs"), path = require("path"), crypto = require("crypto"), xrpl = require("@transia/xrpl");
const ROOT = path.resolve(__dirname, "..");
const APPLY = process.argv.includes("--apply");
const NET = (process.argv.includes("--network") ? process.argv[process.argv.indexOf("--network") + 1] : "mainnet").toLowerCase();
const NETS = { mainnet: { ws: "wss://xahau.org", id: 21337 }, testnet: { ws: "wss://xahau-test.net", id: 21338 } };
if (!NETS[NET]) { console.error("--network must be mainnet | testnet"); process.exit(1); }
const { ws: WS, id: NETID } = NETS[NET];
const FEE_CAP = 20_000_000;   // 20 XAH guard

const HE = (s) => Buffer.from(s, "ascii").toString("hex").toUpperCase();
const u32 = (n) => (Number(n) >>> 0).toString(16).padStart(8, "0").toUpperCase();
const P = (n, v) => ({ HookParameter: { HookParameterName: HE(n), HookParameterValue: v } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// hook triggers on incoming Payment
const HOOK_ON = "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF77FFFFFFFFFFFFFFFFFBFFFFE"; // Payment-enabled mask family
const NS_LABEL = (process.env.NAMESPACE || "uritoken-broker").trim();
const NS = crypto.createHash("sha256").update(NS_LABEL).digest("hex").toUpperCase();

function brokerSeed() {
  if (process.env.BROKER_SEED) return process.env.BROKER_SEED.trim();
  const f = path.join(ROOT, "config", "broker.json");
  if (fs.existsSync(f)) { const m = JSON.parse(fs.readFileSync(f, "utf8")); if (m.seed) return { seed: String(m.seed).trim(), address: m.address }; }
  console.error("no broker seed — set BROKER_SEED or create config/broker.json {\"seed\":\"s...\"}");
  process.exit(1);
}
async function pollTx(c, h, lls) { const s = Date.now(); while (Date.now() - s < 180000) { await sleep(2500); try { const t = await c.request({ command: "tx", transaction: h }); if (t.result?.validated) return t.result.meta?.TransactionResult; } catch {} try { const cur = Number((await c.request({ command: "ledger_current" })).result.ledger_current_index); if (cur > lls + 8) return "EXPIRED"; } catch {} } return "TIMEOUT"; }

(async () => {
  const sd = brokerSeed();
  const seed = typeof sd === "string" ? sd : sd.seed;
  const w = xrpl.Wallet.fromSeed(seed);
  const BROKER = w.classicAddress;
  if (typeof sd === "object" && sd.address && sd.address !== BROKER) throw new Error("seed does not match recorded broker address — ABORT");

  const FEEDEST = (process.env.FEEDEST || "").trim();
  const FEEBPS = Number(process.env.FEEBPS || 250);
  if (!/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(FEEDEST)) { console.error("set FEEDEST to a valid r-address (the fee wallet)"); process.exit(1); }
  if (!(FEEBPS >= 0 && FEEBPS <= 10000)) { console.error("FEEBPS out of range (0..10000)"); process.exit(1); }

  const wasm = fs.readFileSync(path.join(ROOT, "build", "broker.wasm"));
  const hash = crypto.createHash("sha512").update(wasm).digest("hex").slice(0, 64).toUpperCase();
  const params = [P("FEEDEST", HE(FEEDEST)), P("FEEBPS", u32(FEEBPS))];

  console.log(`\n── broker install (${NET}) ──`);
  console.log(`broker   : ${BROKER}`);
  console.log(`hook     : ${hash.slice(0, 8)} (${wasm.length} B)  ns "${NS_LABEL}" ${NS.slice(0, 12)}…`);
  console.log(`fee      : ${FEEBPS} bps (${FEEBPS / 100}%) → ${FEEDEST}`);

  const c = new xrpl.Client(WS); c.apiVersion = 1; await c.connect();
  try {
    let acct;
    try { acct = await c.request({ command: "account_info", account: BROKER, ledger_index: "validated" }); }
    catch { console.error(`\n✗ ${BROKER} is not funded. Send it ~5 XAH, then re-run.`); await c.disconnect(); process.exit(1); }
    console.log(`balance  : ${Number(acct.result.account_data.Balance) / 1e6} XAH`);
    const existing = await c.request({ command: "account_objects", account: BROKER, type: "hook", ledger_index: "validated" });
    const slots = existing.result.account_objects?.[0]?.Hooks || [];
    if (slots.some((h) => h.Hook?.HookHash)) { console.error("\n✗ broker already runs a hook — ABORT (expected a fresh, dedicated account)."); await c.disconnect(); process.exit(1); }

    const tx = { TransactionType: "SetHook", Account: BROKER, Flags: 0, NetworkID: NETID,
      Hooks: [{ Hook: { CreateCode: wasm.toString("hex").toUpperCase(), HookOn: HOOK_ON, HookNamespace: NS, HookApiVersion: 0, Flags: 1, HookParameters: params } }] };
    const pf = await c.autofill(tx, 0); let fee = Number(pf.Fee || 0); if (!fee) fee = 2_000_000;
    if (fee > FEE_CAP) throw new Error(`fee ${fee / 1e6} XAH exceeds cap ${FEE_CAP / 1e6}`);
    pf.Fee = String(fee);
    console.log(`SetHook fee: ${(fee / 1e6).toFixed(4)} XAH`);

    if (!APPLY) { console.log("\n--- DRY RUN. Re-run with --apply to sign + submit. ---"); await c.disconnect(); return; }

    const s = w.sign(pf);
    const lls = Number((await c.request({ command: "ledger_current" })).result.ledger_current_index);
    await c.submit(s.tx_blob);
    console.log(`submitted ${s.hash} — polling…`);
    const res = await pollTx(c, s.hash, lls);
    console.log(`result: ${res}`);
    if (res === "tesSUCCESS") {
      const after = await c.request({ command: "account_objects", account: BROKER, type: "hook", ledger_index: "validated" });
      const h2 = (after.result.account_objects?.[0]?.Hooks || []).map((h) => (h.Hook?.HookHash || "").slice(0, 8));
      console.log(`✓ installed. broker hooks now: [${h2.join(", ")}]`);
      console.log(`\nbroker account : ${BROKER}\nhook hash      : ${hash.slice(0, 8)}\nBuyers pay this account with tx params NFTID + BUY (see README).`);
    }
  } finally { try { await c.disconnect(); } catch {} }
})().catch((e) => { console.error("FAIL", e.message || e); process.exit(1); });
