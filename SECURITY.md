# SECURITY — IMMEDIATE ACTION REQUIRED

## Helius Pro API Key Exposed

**Status: CRITICAL — rotate immediately.**

The Helius Pro plan API key (`3ed2a463-fd75-4c6b-921c-6b0d67f43aa1`) is in:
- `public/config.json` line 16 (tracked in git, served to browser)
- Git history of deleted files: `scripts/read-pool.mjs`, `scripts/check-vault.mjs`, `scripts/check-escrows.mjs`

This is a $999/mo Pro plan key. Anyone who clones the repo or inspects the frontend source can use your quota.

### Steps to fix

1. **Rotate the key NOW.** Go to https://dashboard.helius.dev → API Keys → generate a new key. The old key stops working immediately.

2. **Create two separate keys:**
   - **Bot key (Pro tier):** Goes in `bot/.env` only. Never committed to git. Used for LaserStream gRPC + high-throughput RPC.
   - **Frontend key (free/basic tier):** Goes in `public/config.json`. This key is public — anyone can see it in the browser. Use the free tier (rate-limited, no cost if abused).

3. **Update `public/config.json`:** Replace `HELIUS_RPC_URL` with the new free-tier key.

4. **Scrub git history** (optional but recommended if repo ever goes public):
   ```bash
   # Nuclear option — rewrites all history to remove the key
   git filter-repo --replace-text <(echo '3ed2a463-fd75-4c6b-921c-6b0d67f43aa1==>ROTATED_KEY_REMOVED')
   ```
   Or just accept the old key is in history and ensure it's been rotated (dead key = no risk).

5. **Add to `.gitignore`** (already covered):
   - `bot/.env` is gitignored
   - `public/config.json` is tracked intentionally (frontend needs it) — but should only contain the free-tier key

### Rule going forward

- Pro/paid API keys go in `.env` files (gitignored), never in tracked files
- `public/config.json` only gets free-tier / public-facing keys
- The bot reads its own RPC from `bot/.env`, not from `public/config.json`
