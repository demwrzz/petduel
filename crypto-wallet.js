'use strict';
/* =====================================================================
   Pet Duel crypto wallet: every player gets their own permanent deposit
   address for USDT (BNB Smart Chain, BEP20), Solana and Litecoin.

   All addresses come from ONE secret 12/24-word phrase in the Railway
   variable WALLET_MNEMONIC (never in this repository):
     USDT (BEP20)  m/44'/60'/0'/0/<index>      index 0 = gas wallet (pays BNB fees when collecting USDT)
     Solana        m/44'/501'/<index>'/0'
     Litecoin      m/84'/2'/0'/0/<index>      (native SegWit, ltc1...)
   Players get index 1, 2, 3 ... The same phrase always gives the same addresses.

   Deposits are read from public blockchain APIs:
     USDT  balanceOf on BSC (BSC_RPC, default publicnode), 15 blocks deep
     SOL   getBalance (SOL_RPC, default mainnet-beta), finalized
     LTC   total confirmed received (litecoinspace.org)
   "Collect" moves the money from the player addresses to the owner's own addresses.
   ===================================================================== */

const { ethers } = require('ethers');
const { HDKey } = require('@scure/bip32');
const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');
const btc = require('@scure/btc-signer');
const { derivePath } = require('ed25519-hd-key');
const sol = require('@solana/web3.js');

const E = process.env;
const BSC_RPC = E.BSC_RPC || 'https://bsc-rpc.publicnode.com';
const SOL_RPC = E.SOL_RPC || 'https://api.mainnet-beta.solana.com';
const LTC_API = (E.LTC_API || 'https://litecoinspace.org/api').replace(/\/+$/, '');
const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const LTC_NET = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
const BSC_CONFIRMS = 15;

/* the three coins the site takes; min = smallest amount that is credited (smaller ones wait until more arrives) */
const COINS = {
  usdt: { key: 'usdt', name: 'USDT', label: 'USDT', network: 'BNB Smart Chain (BEP20)', decimals: 18, min: '1' },
  sol: { key: 'sol', name: 'Solana', label: 'SOL', network: 'Solana', decimals: 9, min: '0.01' },
  ltc: { key: 'ltc', name: 'Litecoin', label: 'LTC', network: 'Litecoin', decimals: 8, min: '0.001' }
};

const toUnits = (amount, coin) => ethers.parseUnits(String(amount), COINS[coin].decimals);
const fromUnits = (units, coin) => Number(ethers.formatUnits(BigInt(units), COINS[coin].decimals));

/* ---------- keys ---------- */
let cached = null;
function keys() {
  const phrase = String(E.WALLET_MNEMONIC || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!phrase) return null;
  if (cached && cached.phrase === phrase) return cached;
  if (!bip39.validateMnemonic(phrase, wordlist)) throw new Error('WALLET_MNEMONIC is not a valid 12/24-word phrase');
  const seed = bip39.mnemonicToSeedSync(phrase);
  cached = { phrase, seed, seedHex: Buffer.from(seed).toString('hex'), hd: HDKey.fromMasterSeed(seed), evm: ethers.HDNodeWallet.fromSeed(seed) };
  return cached;
}

const enabled = () => { try { return Boolean(keys()); } catch { return false; } };
const setupError = () => { try { keys(); return E.WALLET_MNEMONIC ? '' : 'WALLET_MNEMONIC is not set'; } catch (e) { return e.message; } };
const newMnemonic = () => bip39.generateMnemonic(wordlist, 128);

const evmWallet = i => keys().evm.derivePath(`m/44'/60'/0'/0/${i}`);
const solKeypair = i => sol.Keypair.fromSeed(derivePath(`m/44'/501'/${i}'/0'`, keys().seedHex).key);
const ltcNode = i => keys().hd.derive(`m/84'/2'/0'/0/${i}`);
const ltcAddress = i => btc.p2wpkh(ltcNode(i).publicKey, LTC_NET).address;

/* the three deposit addresses of a player (index >= 1) */
function addressesFor(index) {
  if (!Number.isInteger(index) || index < 1) throw new Error('bad wallet index');
  return { usdt: evmWallet(index).address, sol: solKeypair(index).publicKey.toBase58(), ltc: ltcAddress(index) };
}
const gasWalletAddress = () => evmWallet(0).address;

/* ---------- address checks (for the owner's collect addresses and player withdrawals) ---------- */
function validAddress(coin, a) {
  a = String(a || '').trim();
  if (coin === 'usdt') return ethers.isAddress(a);
  if (coin === 'sol') { try { return sol.PublicKey.isOnCurve(new sol.PublicKey(a).toBytes()) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a); } catch { return false; } }
  if (coin === 'ltc') { try { btc.Address(LTC_NET).decode(a); return true; } catch { return false; } }
  return false;
}

/* ---------- network helpers ---------- */
async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || 12000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}
let bscProvider = null;
const bsc = () => (bscProvider ||= new ethers.JsonRpcProvider(BSC_RPC, 56, { staticNetwork: true }));
let solConn = null;
const solana = () => (solConn ||= new sol.Connection(SOL_RPC, 'finalized'));

/* ---------- prices in USD (USDT = 1) ---------- */
let priceCache = { t: 0, p: null };
async function prices() {
  if (priceCache.p && Date.now() - priceCache.t < 60000) return priceCache.p;
  let p = null;
  try {
    const list = await getJson('https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent('["SOLUSDT","LTCUSDT"]'));
    const m = Object.fromEntries(list.map(x => [x.symbol, Number(x.price)]));
    if (m.SOLUSDT > 0 && m.LTCUSDT > 0) p = { usdt: 1, sol: m.SOLUSDT, ltc: m.LTCUSDT };
  } catch { /* try the next source */ }
  if (!p) {
    const g = await getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana,litecoin&vs_currencies=usd');
    if (g.solana && g.litecoin) p = { usdt: 1, sol: Number(g.solana.usd), ltc: Number(g.litecoin.usd) };
  }
  if (!p) throw new Error('No price source answered');
  priceCache = { t: Date.now(), p };
  return p;
}

/* ---------- reading deposits ----------
   usdt / sol: the current confirmed balance of the address (in smallest units, as a string)
   ltc: everything the address has ever received, confirmed (so collecting never changes it) */
async function readAddress(coin, address) {
  if (coin === 'usdt') {
    const head = await bsc().getBlockNumber();
    const token = new ethers.Contract(USDT_BSC, ERC20, bsc());
    return (await token.balanceOf(address, { blockTag: head - BSC_CONFIRMS })).toString();
  }
  if (coin === 'sol') return String(await solana().getBalance(new sol.PublicKey(address), 'finalized'));
  if (coin === 'ltc') {
    const d = await getJson(`${LTC_API}/address/${address}`);
    return String(d.chain_stats.funded_txo_sum);
  }
  throw new Error('unknown coin');
}

/* ---------- collecting to the owner's addresses ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* USDT: each address needs a little BNB for the fee; the gas wallet (index 0) sends it first */
async function collectUsdt(entries, to) {
  const provider = bsc();
  const gas = evmWallet(0).connect(provider);
  const out = [];
  for (const { index } of entries) {
    const w = evmWallet(index).connect(provider);
    const token = new ethers.Contract(USDT_BSC, ERC20, w);
    try {
      const bal = await token.balanceOf(w.address);
      if (bal < toUnits(COINS.usdt.min, 'usdt')) continue;
      const fee = await provider.getFeeData();
      const gasPrice = fee.gasPrice || ethers.parseUnits('1', 'gwei');
      const limit = 80000n;
      const need = gasPrice * limit;
      const have = await provider.getBalance(w.address);
      if (have < need) {
        const top = await gas.sendTransaction({ to: w.address, value: need - have, gasPrice });
        await top.wait(1);
      }
      const tx = await token.transfer(to, bal, { gasPrice, gasLimit: limit });
      await tx.wait(1);
      out.push({ index, amount: bal.toString(), tx: tx.hash });
    } catch (e) {
      out.push({ index, error: e.shortMessage || e.message });
    }
  }
  return out;
}

/* SOL: each address sends everything except the network fee */
async function collectSol(entries, to) {
  const conn = new sol.Connection(SOL_RPC, 'confirmed');
  const dest = new sol.PublicKey(to);
  const out = [];
  for (const { index } of entries) {
    try {
      const kp = solKeypair(index);
      const bal = await conn.getBalance(kp.publicKey, 'confirmed');
      const fee = 5000;
      if (bal < Number(toUnits(COINS.sol.min, 'sol'))) continue;
      const tx = new sol.Transaction().add(sol.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: bal - fee }));
      const sig = await sol.sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
      out.push({ index, amount: String(bal - fee), fee: String(fee), tx: sig });
    } catch (e) {
      out.push({ index, error: e.message });
    }
  }
  return out;
}

/* LTC: one transaction spends every confirmed coin of every player address */
async function collectLtc(entries, to) {
  const inputs = [];
  for (const { index } of entries) {
    const node = ltcNode(index);
    const pay = btc.p2wpkh(node.publicKey, LTC_NET);
    const utxos = await getJson(`${LTC_API}/address/${pay.address}/utxo`);
    for (const u of utxos) if (u.status && u.status.confirmed) inputs.push({ u, node, pay, index });
    await sleep(150);
  }
  if (!inputs.length) return [];
  let rate = 2;
  try { const f = await getJson(`${LTC_API}/v1/fees/recommended`); rate = Math.max(1, Number(f.halfHourFee || f.fastestFee || 2)); } catch { /* default */ }
  const total = inputs.reduce((t, x) => t + BigInt(x.u.value), 0n);
  const vbytes = BigInt(11 + 68 * inputs.length + 31);
  const fee = vbytes * BigInt(Math.ceil(rate));
  if (total - fee < 10000n) throw new Error('Too little LTC to cover the network fee');
  const tx = new btc.Transaction();
  for (const x of inputs) tx.addInput({ txid: x.u.txid, index: x.u.vout, witnessUtxo: { script: x.pay.script, amount: BigInt(x.u.value) } });
  tx.addOutputAddress(to, total - fee, LTC_NET);
  inputs.forEach((x, i) => tx.signIdx(x.node.privateKey, i));
  tx.finalize();
  const r = await fetch(`${LTC_API}/tx`, { method: 'POST', body: tx.hex, signal: AbortSignal.timeout(15000) });
  const txt = await r.text();
  if (!r.ok) throw new Error('LTC broadcast failed: ' + txt.slice(0, 200));
  return [{ amount: (total - fee).toString(), fee: fee.toString(), tx: txt.trim(), inputs: inputs.length }];
}

async function gasWalletBalance() {
  return ethers.formatEther(await bsc().getBalance(gasWalletAddress()));
}

module.exports = {
  COINS, enabled, setupError, newMnemonic, addressesFor, gasWalletAddress, gasWalletBalance,
  validAddress, prices, readAddress, toUnits, fromUnits,
  collect: { usdt: collectUsdt, sol: collectSol, ltc: collectLtc }
};
