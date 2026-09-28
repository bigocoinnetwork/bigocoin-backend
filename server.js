import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits } from "ethers";
dotenv.config();

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());

const provider = new JsonRpcProvider(process.env.RPC_URL || "https://bsc-dataseed.binance.org/");
const vaultAbi = [
  "function nonces(address) view returns(uint256)",
  "function signer() view returns(address)",
  "function boostOf(address) view returns(uint256)",
  "function isEarlyHolder(address) view returns(bool)",
  "function rewardPoolBalance() view returns(uint256)"
];
const vault = process.env.VAULT_ADDRESS ? new Contract(process.env.VAULT_ADDRESS, vaultAbi, provider) : null;
const signer = process.env.SIGNER_PRIVATE_KEY ? new Wallet(process.env.SIGNER_PRIVATE_KEY, provider) : null;

// --- NFT holder bonus: the ORIGINAL BigoCoin NFT collection on Polygon (ERC-1155). ---
// Additive, not compounding: each NFT adds NFT_BONUS_PER_NFT_BPS of the base rate, up to NFT_BONUS_CAP_BPS.
// Feature is OFF unless NFT_RPC_URL (a Polygon RPC URL) is set.
const NFT_CONTRACT = process.env.NFT_CONTRACT || "0x608782cb6D6f4BD8A2115e00EaBBb175572B2971";
const NFT_TOKEN_ID = BigInt(process.env.NFT_TOKEN_ID || 0);
const NFT_BONUS_PER_NFT_BPS = Number(process.env.NFT_BONUS_PER_NFT_BPS || 2500); // 2500 = +25% of base per NFT
const NFT_BONUS_CAP_BPS = Number(process.env.NFT_BONUS_CAP_BPS || 10000);        // 10000 = +100% maximum
const nftProvider = process.env.NFT_RPC_URL ? new JsonRpcProvider(process.env.NFT_RPC_URL) : null;
const nftContract = nftProvider
  ? new Contract(NFT_CONTRACT, ["function balanceOf(address,uint256) view returns(uint256)"], nftProvider)
  : null;

function nftBpsForCount(count) {
  return Math.min(count * NFT_BONUS_PER_NFT_BPS, NFT_BONUS_CAP_BPS);
}

async function nftCountOf(account) {
  if (!nftContract) return 0;
  return Number(await nftContract.balanceOf(account, NFT_TOKEN_ID));
}

// Pure reward math, done in whole wei (BigInt) so there is no floating-point rounding.
// Base, NFT bonus and boost bonus are added together; the owner cut applies to the boost bonus only.
function rewardBreakdown({ baseRatePerDay, elapsedSeconds, boostBps, nftBps, ownerCutBps }) {
  const baseWei = parseUnits(String(baseRatePerDay), DECIMALS) * BigInt(Math.floor(elapsedSeconds)) / 86400n;
  const nftBonusWei = baseWei * BigInt(nftBps) / 10000n;
  const boostBonusWei = baseWei * BigInt(boostBps) * (10000n - BigInt(ownerCutBps)) / 100000000n;
  return { baseWei, nftBonusWei, boostBonusWei, totalWei: baseWei + nftBonusWei + boostBonusWei };
}

// Domain MUST exactly match the deployed contract's EIP712(name, version) and real chain/address,
// or every signature this server produces will be silently rejected by claim().
const domain = () => ({
  name: "BigoCoin Reward Vault",
  version: "2",
  chainId: 56,
  verifyingContract: process.env.VAULT_ADDRESS
});
const types = { Claim: [
  { name: "account", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" }
]};

// --- Server-side mining + referral state. File-based for now: fine for an early launch on
// a single instance, but a real database is worth moving to once this scales past one server
// or you need it to survive redeploys reliably. ---
const DATA_FILE = process.env.DATA_FILE || "./miners.json";
function loadMiners() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return {}; }
}
function saveMiners(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
}
function codeFor(address) {
  return address.slice(2, 10).toUpperCase();
}

const BASE_RATE_PER_DAY = Number(process.env.BASE_RATE_PER_DAY || 125);
const OWNER_BONUS_CUT_BPS = BigInt(process.env.OWNER_BONUS_CUT_BPS || 1000); // 1000 = 10%
const MIN_CLAIM_INTERVAL_SECONDS = Number(process.env.MIN_CLAIM_INTERVAL_SECONDS || 3600); // 1 hour
const MAX_ACCRUAL_DAYS = Number(process.env.MAX_ACCRUAL_DAYS || 30); // safety cap on one voucher's size
const REFERRAL_BONUS_REFEREE = Number(process.env.REFERRAL_BONUS_REFEREE || 50); // flat BIGO, new user's bonus
const REFERRAL_BONUS_REFERRER = Number(process.env.REFERRAL_BONUS_REFERRER || 50); // flat BIGO, referrer's bonus
const DECIMALS = 18;

// --- Bigo Network Collection ($4 NFT, Polygon ERC-1155) — 500,000 BIGO reward per NFT ---
// Rule: a wallet is eligible for the NFTs it bought from the official sale wallet (primary sales),
// limited to how many it still holds. Passing NFTs to other wallets never creates new claims, because
// only transfers OUT of the sale wallet count. The BSC claim contract remembers how many NFTs each
// wallet has been paid for, so every eligible NFT is paid at most once.
const NFT2_CONTRACT = (process.env.NFT2_CONTRACT || "0x33c68838bA2E5A405d37bE81050300b12082Df22");
const NFT2_TOKEN_ID = BigInt(process.env.NFT2_TOKEN_ID || 1);
const NFT2_SALE_WALLET = (process.env.NFT2_SALE_WALLET || "0x50aa47572f342b183ac8b324246e730fc84bedc0").toLowerCase();
const NFT2_START_BLOCK = process.env.NFT2_START_BLOCK || "0x59ca361"; // collection mint block
const NFT2_TRANSFERS_RPC = process.env.NFT2_TRANSFERS_RPC || ""; // Alchemy Polygon URL (alchemy_getAssetTransfers)
const NFT2_EXCLUDE = (process.env.NFT2_EXCLUDE || "0x577d663f97f70726ba34445877e79fc16022c879,0x0ac48971f304c4b42ad6f2e443bd3687a6bd0a1d")
  .toLowerCase().split(",").map(a => a.trim()).filter(Boolean); // project wallets never eligible
const NFT_CLAIM_ADDRESS = process.env.NFT_CLAIM_ADDRESS || ""; // BigoNFTRewardClaim on BSC
const nft2 = nftProvider ? new Contract(NFT2_CONTRACT, ["function balanceOf(address,uint256) view returns(uint256)"], nftProvider) : null;
const nftClaim = NFT_CLAIM_ADDRESS ? new Contract(NFT_CLAIM_ADDRESS, [
  "function claimedUnits(address) view returns(uint256)",
  "function rewardPerNft() view returns(uint256)",
  "function rewardBalance() view returns(uint256)",
  "function paused() view returns(bool)",
  "function signer() view returns(address)"
], provider) : null;
const nftClaimDomain = () => ({ name: "Bigo NFT Reward Claim", version: "1", chainId: 56, verifyingContract: NFT_CLAIM_ADDRESS });
const nftClaimTypes = { NftClaim: [
  { name: "account", type: "address" },
  { name: "eligibleUnits", type: "uint256" },
  { name: "deadline", type: "uint256" }
]};

// Cached list of primary-sale purchases per buyer, refreshed at most every 30 seconds.
let saleCache = { at: 0, bought: null, pending: null };
async function primarySales() {
  if (!NFT2_TRANSFERS_RPC) throw new Error("NFT2_TRANSFERS_RPC not set");
  if (saleCache.bought && Date.now() - saleCache.at < 30000) return saleCache.bought;
  if (saleCache.pending) return saleCache.pending;
  saleCache.pending = (async () => {
    const bought = {};
    let pageKey;
    do {
      const r = await fetch(NFT2_TRANSFERS_RPC, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{
          fromBlock: NFT2_START_BLOCK, toBlock: "latest", fromAddress: NFT2_SALE_WALLET,
          contractAddresses: [NFT2_CONTRACT], category: ["erc1155"], excludeZeroValue: true,
          maxCount: "0x3e8", ...(pageKey ? { pageKey } : {})
        }]})
      });
      const j = await r.json();
      if (j.error || !j.result) throw new Error((j.error && j.error.message) || "transfer lookup failed");
      for (const t of j.result.transfers) {
        const to = (t.to || "").toLowerCase();
        for (const m of (t.erc1155Metadata || [])) {
          if (BigInt(m.tokenId) === NFT2_TOKEN_ID) bought[to] = (bought[to] || 0n) + BigInt(m.value);
        }
      }
      pageKey = j.result.pageKey;
    } while (pageKey);
    saleCache = { at: Date.now(), bought, pending: null };
    return bought;
  })().catch(e => { saleCache.pending = null; throw e; });
  return saleCache.pending;
}

async function nftEligibility(account) {
  const bought = NFT2_EXCLUDE.includes(account) ? 0n : ((await primarySales())[account] || 0n);
  const held = nft2 ? await nft2.balanceOf(account, NFT2_TOKEN_ID) : 0n;
  const eligible = bought < held ? bought : held;
  const claimed = nftClaim ? await nftClaim.claimedUnits(account) : 0n;
  const claimable = eligible > claimed ? eligible - claimed : 0n;
  return { bought, held, eligible, claimed, claimable };
}

app.get("/nft-eligibility", async (req, res) => {
  try {
    const account = String(req.query.account || "").toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return res.status(400).json({ error: "Invalid account" });
    const e = await nftEligibility(account);
    res.json({
      bought: e.bought.toString(), held: e.held.toString(), eligible: e.eligible.toString(),
      claimed: e.claimed.toString(), claimable: e.claimable.toString(),
      rewardPerNft: "500000", claimsOpen: !!(nftClaim && signer), claimContract: NFT_CLAIM_ADDRESS || null
    });
  } catch (e) {
    res.status(503).json({ error: "Could not check eligibility right now. Please try again in a moment." });
  }
});

app.post("/nft-claim-voucher", async (req, res) => {
  try {
    if (!nftClaim || !signer) return res.status(503).json({ error: "NFT reward claims are not open yet." });
    const account = (req.body.account || "").toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return res.status(400).json({ error: "Invalid account" });
    if (await nftClaim.paused()) return res.status(503).json({ error: "Claims are paused right now." });

    const e = await nftEligibility(account);
    if (e.claimable === 0n) {
      return res.status(400).json({ error: e.eligible === 0n
        ? "This wallet has no eligible NFTs. Rewards go to wallets that bought from the official sale and still hold the NFTs."
        : "You have already claimed the reward for all your eligible NFTs." });
    }
    const perNft = await nftClaim.rewardPerNft();
    const owed = e.claimable * perNft;
    if ((await nftClaim.rewardBalance()) < owed) {
      return res.status(503).json({ error: "The reward pool is being topped up. Please try again later." });
    }
    const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes to submit
    const message = { account, eligibleUnits: e.eligible, deadline };
    const signature = await signer.signTypedData(nftClaimDomain(), nftClaimTypes, message);
    res.json({
      eligibleUnits: e.eligible.toString(), deadline, signature,
      newUnits: e.claimable.toString(), humanAmount: formatUnits(owed, DECIMALS),
      claimContract: NFT_CLAIM_ADDRESS
    });
  } catch (e) {
    res.status(503).json({ error: "Could not prepare your claim right now. Please try again in a moment." });
  }
});

app.get("/health", async (_, res) => res.json({ ok: true, configured: !!(vault && signer), nftBonus: !!nftContract, nftClaims: !!(nftClaim && signer && NFT2_TRANSFERS_RPC) }));

// Call this once, before a new user's first claim, to link them to whoever referred them.
app.post("/register-referral", (req, res) => {
  const account = (req.body.account || "").toLowerCase();
  const code = (req.body.referralCode || "").toUpperCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return res.status(400).json({ error: "Invalid account" });
  if (!code) return res.status(400).json({ error: "Missing referral code" });

  const miners = loadMiners();
  const referrer = Object.keys(miners).find(addr => codeFor(addr) === code);
  if (!referrer) return res.status(404).json({ error: "Referral code not found. The referrer needs to have used the app at least once." });
  if (referrer === account) return res.status(400).json({ error: "You can't refer yourself." });

  const record = miners[account] || { lastClaimAt: Math.floor(Date.now() / 1000), hasClaimedOnce: false };
  if (record.hasClaimedOnce) return res.status(400).json({ error: "Referral must be registered before your first claim." });
  if (record.referredBy) return res.status(400).json({ error: "Referral already registered for this account." });

  record.referredBy = referrer;
  miners[account] = record;
  saveMiners(miners);
  res.json({ ok: true, referrer });
});

app.post("/claim-voucher", async (req, res) => {
  try {
    if (!vault || !signer) return res.status(503).json({ error: "Reward vault is not configured" });
    const account = (req.body.account || "").toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return res.status(400).json({ error: "Invalid account" });

    const now = Math.floor(Date.now() / 1000);
    const miners = loadMiners();
    let record = miners[account];

    if (!record) {
      // First time we've seen this account: start their mining clock now.
      // Nothing to claim yet on this call, which is correct — they haven't mined anything.
      // Snapshot NFT holdings at the start of the period (see NFT rule below). If the check fails, start at 0.
      let startCount = 0;
      try { startCount = await nftCountOf(account); } catch {}
      miners[account] = { lastClaimAt: now, hasClaimedOnce: false, nftCountAtLastClaim: startCount };
      saveMiners(miners);
      return res.json({ claimable: "0", message: "Mining started. Come back later to claim." });
    }

    const elapsedSeconds = Math.min(now - record.lastClaimAt, MAX_ACCRUAL_DAYS * 86400);
    if (elapsedSeconds < MIN_CLAIM_INTERVAL_SECONDS) {
      return res.status(429).json({ error: `Please wait before claiming again (min ${MIN_CLAIM_INTERVAL_SECONDS}s between claims).` });
    }

    // Server computes the amount itself from real elapsed time — the client never supplies it.
    const boostBps = await vault.boostOf(account); // uint256, e.g. 1500 = 15%

    // NFT holder bonus. If the NFT check can't be completed we stop here, BEFORE any state changes,
    // so a holder is never silently paid less and never loses their accrued time.
    let nftCountNow;
    try {
      nftCountNow = await nftCountOf(account);
    } catch (e) {
      return res.status(503).json({ error: "Could not verify NFT ownership right now. Please try again in a moment." });
    }
    // NFT rule: the bonus counts only NFTs held at BOTH the start and the end of the period
    // (the lower of the two counts). This stops the same NFTs being passed between wallets,
    // or bought just before a claim, to collect a bonus for time they were not held.
    // Records created before this feature have no snapshot, so their first period counts 0.
    const nftCountStart = Number(record.nftCountAtLastClaim || 0);
    const nftCount = Math.min(nftCountStart, nftCountNow);
    const nft = { count: nftCount, bps: nftBpsForCount(nftCount) };

    const parts = rewardBreakdown({
      baseRatePerDay: BASE_RATE_PER_DAY,
      elapsedSeconds,
      boostBps: Number(boostBps),
      nftBps: nft.bps,
      ownerCutBps: Number(OWNER_BONUS_CUT_BPS)
    });
    let amount = parts.totalWei;

    const isFirstRealClaim = !record.hasClaimedOnce && amount > 0n;

    // Referee's one-time bonus, paid into their own first real claim.
    if (isFirstRealClaim && record.referredBy) {
      amount += parseUnits(String(REFERRAL_BONUS_REFEREE), DECIMALS);
    }

    // Any referral bonus owed to THIS account for people it referred, paid whenever they next claim.
    const pendingReferral = Number(record.pendingReferralBonus || 0);
    if (pendingReferral > 0) {
      amount += parseUnits(String(pendingReferral), DECIMALS);
    }

    // Never promise more than the reward pool actually holds.
    const poolBalance = await vault.rewardPoolBalance();
    if (amount > poolBalance) amount = poolBalance;
    if (amount <= 0n) return res.status(503).json({ error: "Reward pool is currently empty. Try again later." });

    const nonce = await vault.nonces(account);
    const deadline = now + 300; // 5 minutes to submit the on-chain claim

    const message = { account, amount, nonce, deadline };
    const signature = await signer.signTypedData(domain(), types, message);

    // Credit the referrer now that this referee's first real claim is actually happening.
    // They'll receive it the next time THEY claim (a voucher can only ever be redeemed
    // by the account it's made out to, so it can't be paid out in this same transaction).
    // All state changes are applied to ONE fresh copy of the data and saved once, so the
    // referrer's credit can never be overwritten by a stale copy of the file.
    const fresh = loadMiners();
    if (isFirstRealClaim && record.referredBy) {
      const refRecord = fresh[record.referredBy] || { lastClaimAt: now, hasClaimedOnce: false, nftCountAtLastClaim: 0 };
      refRecord.pendingReferralBonus = (refRecord.pendingReferralBonus || 0) + REFERRAL_BONUS_REFERRER;
      fresh[record.referredBy] = refRecord;
    }

    // Advance the mining clock now that a voucher has been issued for this period.
    // Known simplification: if this voucher expires unclaimed, that period's accrual
    // is forfeited rather than rolled forward. Fine for an early, low-stakes launch;
    // worth revisiting (track pending vs. confirmed) if this becomes high-traffic.
    const mine = fresh[account] || record;
    mine.pendingReferralBonus = Math.max(0, Number(mine.pendingReferralBonus || 0) - pendingReferral);
    mine.lastClaimAt = now;
    mine.hasClaimedOnce = true;
    mine.nftCountAtLastClaim = nftCountNow; // start-of-period snapshot for the next claim
    fresh[account] = mine;
    saveMiners(fresh);

    res.json({
      domain: domain(),
      types,
      primaryType: "Claim",
      message: { ...message, nonce: nonce.toString(), amount: amount.toString() },
      signature,
      humanAmount: formatUnits(amount, DECIMALS),
      nftCount: nft.count,
      nftBonusBps: nft.bps
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.listen(Number(process.env.PORT || 8787), () => console.log("BigoCoin reward backend running"));
