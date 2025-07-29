import { ethers, BigNumber } from 'ethers';
import { RPC_URL, CHAIN_ID, OWNER_ADDRESS, CONTRACTS } from './config.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load ABIs
const NFTManagerABI = require('@pancakeswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const FactoryABI = require('@pancakeswap/v3-core/artifacts/contracts/PancakeV3Factory.sol/PancakeV3Factory.json');

// Updated MasterChef ABI with pendingCake and userPositionInfos
const MasterChefABI = [
    'function userPositionInfos(uint256) view returns (uint128 liquidity, uint128 boostLiquidity, int24 tickLower, int24 tickUpper, uint256 rewardGrowthInside, uint256 reward, address user, uint32 pid, uint256 boostMultiplier)',
    'function pendingCake(uint256 _tokenId) view returns (uint256)'
];

// Minimal ABI for PancakeV3Pool (only needed functions)
const IUniswapV3PoolABI = [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
    'function liquidity() view returns (uint128)',
    'function feeGrowthGlobal0X128() view returns (uint256)',
    'function feeGrowthGlobal1X128() view returns (uint256)',
    'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)'
];

import { Token } from '@pancakeswap/sdk';
import { Pool, Position } from '@pancakeswap/v3-sdk';

const provider = new ethers.providers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'base' });
const posMgr = new ethers.Contract(CONTRACTS.POSITION_MANAGER, NFTManagerABI.abi, provider);
const factory = new ethers.Contract(CONTRACTS.FACTORY, FactoryABI.abi, provider);
const masterchef = new ethers.Contract(CONTRACTS.MASTERCHEF, MasterChefABI, provider);

// Fetch all historical token IDs associated with the owner via Transfer events
export async function fetchAllTokenIds(owner) {
    const transferSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Transfer(address,address,uint256)'));
    const ownerPadded = ethers.utils.hexZeroPad(owner.toLowerCase(), 32);

    // Filter for transfers from owner
    const filterFrom = {
        address: CONTRACTS.POSITION_MANAGER,
        topics: [transferSig, ownerPadded, null, null],
        fromBlock: 0,
        toBlock: 'latest'
    };

    // Filter for transfers to owner
    const filterTo = {
        address: CONTRACTS.POSITION_MANAGER,
        topics: [transferSig, null, ownerPadded, null],
        fromBlock: 0,
        toBlock: 'latest'
    };

    const logsFrom = await provider.getLogs(filterFrom);
    const logsTo = await provider.getLogs(filterTo);
    const allLogs = [...logsFrom, ...logsTo];

    const tokenIds = new Set();
    for (const log of allLogs) {
        const tokenId = BigInt(log.topics[3]).toString();
        tokenIds.add(tokenId);
    }

    // Validate each token ID: check current owner and confirm if active/staked
    const validIds = [];
    for (const id of tokenIds) {
        try {
            const currentOwner = await posMgr.ownerOf(id);
            const pos = await posMgr.positions(id);
            if (pos[7].eq(0)) continue;  // Skip closed/burned positions (liquidity == 0)

            if (currentOwner.toLowerCase() === owner.toLowerCase()) {
                validIds.push(id);
            } else if (currentOwner.toLowerCase() === CONTRACTS.MASTERCHEF.toLowerCase()) {
                const info = await masterchef.userPositionInfos(id);
                if (info[6].toLowerCase() === owner.toLowerCase()) {  // info.user
                    validIds.push(id);
                }
            }
        } catch (err) {
            console.error(`Error validating token ID ${id}:`, err);
        }
    }

    return validIds;
}

export async function fetchPosition(tokenId) {
  const raw = await posMgr.positions(tokenId);
  return {
    tokenId,
    token0: raw[2],
    token1: raw[3],
    feeTier: Number(raw[4]),
    tickLower: Number(raw[5]),
    tickUpper: Number(raw[6]),
    liquidity: raw[7],  // BigNumber
    feeGrowthInside0Last: raw[8],  // BigNumber
    feeGrowthInside1Last: raw[9],  // BigNumber
    owed0: raw[10],   // BigNumber
    owed1: raw[11]    // BigNumber
  };
}

export async function getPoolAddress(token0, token1, feeTier) {
    return factory.getPool(token0, token1, feeTier);
}

// Updated fetchPoolState to use exact ticks and fetch slot0 first
export async function fetchPoolState(poolAddress, tickLower, tickUpper) {
  const pool = new ethers.Contract(poolAddress, IUniswapV3PoolABI, provider);
  const slot0 = await pool.slot0();
  console.log(`Ticks in fetchPoolState: Lower=${tickLower} (type: ${typeof tickLower}), Upper=${tickUpper} (type: ${typeof tickUpper})`);

  const [liquidity, feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData] = await Promise.all([
    pool.liquidity(),
    pool.feeGrowthGlobal0X128(),
    pool.feeGrowthGlobal1X128(),
    pool.ticks(BigNumber.from(tickLower)),  // Use BigNumber for safe encoding of negative ticks
    pool.ticks(BigNumber.from(tickUpper))   // Use BigNumber for safe encoding of negative ticks
  ]);
  return { slot0, liquidity, feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData };
}

// Helper to compute feeGrowthInside (use BigNumber ops)
function computeFeeGrowthInside(tickCurrent, tickLower, tickUpper, feeGrowthGlobal, feeGrowthOutsideLower, feeGrowthOutsideUpper) {
    let feeGrowthBelow = tickCurrent >= tickLower ? feeGrowthOutsideLower : feeGrowthGlobal.sub(feeGrowthOutsideLower);
    let feeGrowthAbove = tickCurrent < tickUpper ? feeGrowthOutsideUpper : feeGrowthGlobal.sub(feeGrowthOutsideUpper);
    return feeGrowthGlobal.sub(feeGrowthBelow).sub(feeGrowthAbove);
}

// Updated computeUncollectedFees with BigNumber operations
async function computeUncollectedFees(positionData, poolState, dec0, dec1) {
    const { liquidity, feeGrowthInside0Last, feeGrowthInside1Last, tickLower, tickUpper, owed0, owed1 } = positionData;
    const { slot0, feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData } = poolState;
    const tickCurrent = Number(slot0.tick);

    const feeGrowthInside0 = computeFeeGrowthInside(tickCurrent, tickLower, tickUpper, feeGrowthGlobal0, tickLowerData.feeGrowthOutside0X128, tickUpperData.feeGrowthOutside0X128);
    const feeGrowthInside1 = computeFeeGrowthInside(tickCurrent, tickLower, tickUpper, feeGrowthGlobal1, tickLowerData.feeGrowthOutside1X128, tickUpperData.feeGrowthOutside1X128);

    const delta0 = feeGrowthInside0.sub(feeGrowthInside0Last);
    const delta1 = feeGrowthInside1.sub(feeGrowthInside1Last);
    const Q128 = BigNumber.from(2).pow(128);  // 1 << 128 as BigNumber

    const unclaimed0 = delta0.gt(0) ? delta0.mul(liquidity).div(Q128).add(owed0) : owed0;
    const unclaimed1 = delta1.gt(0) ? delta1.mul(liquidity).div(Q128).add(owed1) : owed1;

    return {
        fees0: ethers.utils.formatUnits(unclaimed0, dec0),
        fees1: ethers.utils.formatUnits(unclaimed1, dec1)
    };
}

async function getTokenDecimals(address) {
    const erc20 = new ethers.Contract(address, ['function decimals() view returns (uint8)'], provider);
    return Number(await erc20.decimals());
}

export async function getTokenSymbol(address) {
    const erc20 = new ethers.Contract(address, ['function symbol() view returns (string)'], provider);
    return await erc20.symbol();
}

export async function computeAmounts(positionData, poolState) {
  const { token0, token1, feeTier, tickLower, tickUpper, liquidity: posLiq } = positionData;
  const dec0 = await getTokenDecimals(token0);
  const dec1 = await getTokenDecimals(token1);
  const T0 = new Token(CHAIN_ID, token0, dec0);
  const T1 = new Token(CHAIN_ID, token1, dec1);

  const sdkPool = new Pool(
        T0,
        T1,
        feeTier,
        poolState.slot0.sqrtPriceX96.toString(),
        poolState.liquidity.toString(),
        Number(poolState.slot0.tick)
    );

  const pos = new Position({
        pool: sdkPool,
        liquidity: posLiq.toString(),
        tickLower,
        tickUpper
    });

  const { fees0, fees1 } = await computeUncollectedFees(positionData, poolState, dec0, dec1);

  return {
        amount0: pos.amount0.toSignificant(6),
        amount1: pos.amount1.toSignificant(6),
        fees0,
        fees1
    };
}

export async function isStaked(tokenId) {
    const currentOwner = await posMgr.ownerOf(tokenId);
    return currentOwner.toLowerCase() === CONTRACTS.MASTERCHEF.toLowerCase();
}

export async function fetchFarmingRewards(tokenId) {
    return await masterchef.pendingCake(tokenId);
}