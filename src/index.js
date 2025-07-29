import { ethers } from 'ethers';
import { fetchAllTokenIds, fetchPosition, getPoolAddress, fetchPoolState, computeAmounts, isStaked, fetchFarmingRewards, getTokenSymbol }
    from './fetchPositions.js';
import { OWNER_ADDRESS } from './config.js';

async function main() {
    console.log(`Fetching positions for ${OWNER_ADDRESS}…`);
    // const ids = await fetchAllTokenIds(OWNER_ADDRESS);  // Comment this out temporarily
    const ids = ['457993'];  // Hardcode your known position ID for testing

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
        console.log(`Pair: ${sym0}/${sym1} (Fee: ${feePercent})`);
        console.log(`Range: Tick ${pos.tickLower} to ${pos.tickUpper}`);
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
    }
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});