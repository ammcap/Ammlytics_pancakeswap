# PancakeSwap V3 Liquidity Position Tracker

## Setup

1. `git clone <repo>`
2. `cd pancakeswap-v3-tracker`
3. `npm install`
4. Copy `.env` as shown above.
5. `npm start`

## What it does

- Connects to Base RPC
- Enumerates your v3 positions (ERC‑721)
- Fetches on‐chain position data + pool state
- Computes token amounts & uncollected fees
- Prints results in the terminal

## Next steps

- Multicall batching for performance
- Error handling & retries
- CI / Docker
- React/Tailwind UI
