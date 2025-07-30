import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import { fetchAllTokenIds, fetchPosition, getPoolAddress, fetchPoolState, computeAmounts, isStaked, fetchFarmingRewards, getTokenSymbol, getTokenDecimals, tickToPrice }
    from './fetchPositions.js';
import { OWNER_ADDRESS } from './config.js';

async function main() {
    console.log(`Fetching positions for ${OWNER_ADDRESS}…`);
    const ids = await fetchAllTokenIds(OWNER_ADDRESS);  // Comment this out temporarily
    // const ids = ['457993'];  // Hardcode your known position ID for testing

    if (!ids.length) {
        console.log('No v3 positions found for your address.');
        return;
    }

    for (const id of ids) {
        console.log(`\n⦿ Position #${id}`);
        const pos = await fetchPosition(id);
        const sym0 = await getTokenSymbol(pos.token0);
        const sym1 = await getTokenSymbol(pos.token1);
        const feePercent = (pos.feeTier / 10000).toFixed(2) + '%';
        const staked = await isStaked(id);
                const creationDate = new Date(pos.timestamp * 1000).toLocaleString();
        console.log(`Created: ${creationDate}`);
        console.log(`Pair: ${sym0}/${sym1} (Fee: ${feePercent})`);
        const dec0 = await getTokenDecimals(pos.token0);
        const dec1 = await getTokenDecimals(pos.token1);

        // The price of token1 in terms of token0
        const priceLower = tickToPrice(pos.tickLower, dec0, dec1);
        const priceUpper = tickToPrice(pos.tickUpper, dec0, dec1);

        // To get the price of token0 in terms of token1, we take the inverse.
        const priceLowerInv = new Decimal(1).div(priceUpper);
        const priceUpperInv = new Decimal(1).div(priceLower);

        console.log(`Range: Tick ${pos.tickLower} to ${pos.tickUpper}`);
        console.log(`Price: Min ${priceLowerInv.toSignificantDigits(6)} / Max ${priceUpperInv.toSignificantDigits(6)} ${sym0} per ${sym1}`);
        console.log(`Staked in farm: ${staked ? 'Yes' : 'No'}`);
        const poolAddr = await getPoolAddress(pos.token0, pos.token1, pos.feeTier);
        console.log(`Pool: ${poolAddr}`);
        // Removed old line: const { slot0, liquidity } = await fetchPoolState(poolAddr);
        const poolState = await fetchPoolState(poolAddr, pos.tickLower, pos.tickUpper);
        const { amount0, amount1, fees0, fees1 } = await computeAmounts(pos, poolState);

        console.log(` • ${sym0} amount: ${amount0}`);
        console.log(` • ${sym1} amount: ${amount1}`);
        console.log(` • Uncollected fees: ${fees0} ${sym0} / ${fees1} ${sym1}`);

        if (staked) {
            const cakeEarned = await fetchFarmingRewards(id);
            console.log(` • CAKE earned: ${ethers.utils.formatEther(cakeEarned)}`);
        }

        // New: Initial values
        const initialAmount0Human = ethers.utils.formatUnits(pos.initialAmount0, dec0);
        const initialAmount1Human = ethers.utils.formatUnits(pos.initialAmount1, dec1);
        console.log(`Initial ${sym0} amount: ${initialAmount0Human}`);
        console.log(`Initial ${sym1} amount: ${initialAmount1Human}`);

        const initialPoolState = await fetchPoolState(poolAddr, pos.tickLower, pos.tickUpper, pos.mintBlock);
        const initialTick = initialPoolState.slot0.tick;
        const initialPrice = tickToPrice(initialTick, dec0, dec1);  // Price of token1 in token0
        console.log(`Initial price: ${initialPrice.toSignificantDigits(6)} ${sym1} per ${sym0}`);

        // Compute initial USD value
        let initialUsd = new Decimal(0);
        const token0Lc = pos.token0.toLowerCase();
        const token1Lc = pos.token1.toLowerCase();
        const usdcLc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'.toLowerCase();  // USDC on Base

        if (token0Lc === usdcLc) {
            // Value = initialAmount0 + initialAmount1 / initialPrice (since initialPrice = token1 / token0 = cbBTC / USDC)
            initialUsd = new Decimal(initialAmount0Human).add(new Decimal(initialAmount1Human).div(initialPrice));
        } else if (token1Lc === usdcLc) {
            // Value = initialAmount1 + initialAmount0 * initialPrice (initialPrice = token1 / token0 = USDC / token0)
            initialUsd = new Decimal(initialAmount1Human).add(new Decimal(initialAmount0Human).mul(initialPrice));
        } else {
            console.log('Warning: Neither token is USDC; skipping initial USD value.');
        }

        console.log(`Initial USD value: $${initialUsd.toFixed(2)}`);
    }
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});