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

// --- Server-side mining state. File-based for now: fine for an early launch on a single
// instance, but a real database (e.g. a hosting platform's Postgres add-on) is worth
// moving to once this scales past one server or you need it to survive redeploys reliably. ---
const DATA_FILE = process.env.DATA_FILE || "./miners.json";
function loadMiners() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return {}; }
}
function saveMiners(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
}

const BASE_RATE_PER_DAY = Number(process.env.BASE_RATE_PER_DAY || 125);
const OWNER_BONUS_CUT_BPS = BigInt(process.env.OWNER_BONUS_CUT_BPS || 1000); // 1000 = 10%
const MIN_CLAIM_INTERVAL_SECONDS = Number(process.env.MIN_CLAIM_INTERVAL_SECONDS || 3600); // 1 hour
const MAX_ACCRUAL_DAYS = Number(process.env.MAX_ACCRUAL_DAYS || 30); // safety cap on one voucher's size
const DECIMALS = 18;

app.get("/health", async (_, res) => res.json({ ok: true, configured: !!(vault && signer) }));

app.post("/claim-voucher", async (req, res) => {
  try {
    if (!vault || !signer) return res.status(503).json({ error: "Reward vault is not configured" });
    const account = (req.body.account || "").toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return res.status(400).json({ error: "Invalid account" });

    const now = Math.floor(Date.now() / 1000);
    const miners = loadMiners();
    const record = miners[account];

    if (!record) {
      // First time we've seen this account: start their mining clock now.
      // Nothing to claim yet on this call, which is correct — they haven't mined anything.
      miners[account] = { lastClaimAt: now };
      saveMiners(miners);
      return res.json({ claimable: "0", message: "Mining started. Come back later to claim." });
    }

    const elapsedSeconds = Math.min(now - record.lastClaimAt, MAX_ACCRUAL_DAYS * 86400);
    if (elapsedSeconds < MIN_CLAIM_INTERVAL_SECONDS) {
      return res.status(429).json({ error: `Please wait before claiming again (min ${MIN_CLAIM_INTERVAL_SECONDS}s between claims).` });
    }

    // Server computes the amount itself from real elapsed time — the client never supplies it.
    const baseAmountFloat = BASE_RATE_PER_DAY * (elapsedSeconds / 86400);

    const boostBps = await vault.boostOf(account); // uint256, e.g. 1500 = 15%
    const bonusFloat = baseAmountFloat * (Number(boostBps) / 10000);
    const userBonusFloat = bonusFloat * (1 - Number(OWNER_BONUS_CUT_BPS) / 10000);
    let totalFloat = baseAmountFloat + userBonusFloat;

    let amount = parseUnits(totalFloat.toFixed(DECIMALS), DECIMALS);

    // Never promise more than the reward pool actually holds.
    const poolBalance = await vault.rewardPoolBalance();
    if (amount > poolBalance) amount = poolBalance;
    if (amount <= 0n) return res.status(503).json({ error: "Reward pool is currently empty. Try again later." });

    const nonce = await vault.nonces(account);
    const deadline = now + 300; // 5 minutes to submit the on-chain claim

    const message = { account, amount, nonce, deadline };
    const signature = await signer.signTypedData(domain(), types, message);

    // Advance the mining clock now that a voucher has been issued for this period.
    // Known simplification: if this voucher expires unclaimed, that period's accrual
    // is forfeited rather than rolled forward. Fine for an early, low-stakes launch;
    // worth revisiting (track pending vs. confirmed) if this becomes high-traffic.
    miners[account] = { lastClaimAt: now };
    saveMiners(miners);

    res.json({
      domain: domain(),
      types,
      primaryType: "Claim",
      message: { ...message, nonce: nonce.toString(), amount: amount.toString() },
      signature,
      humanAmount: formatUnits(amount, DECIMALS)
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Server error" });
  }
});

app.listen(Number(process.env.PORT || 8787), () => console.log("BigoCoin reward backend running"));
