import { ethers, BigNumber } from 'ethers';
import { RPC_URL, CHAIN_ID, OWNER_ADDRESS, CONTRACTS, THEGRAPH_API_KEY } from './config.js';
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
    'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)'
];

import { Token } from '@pancakeswap/sdk';
import { Pool, Position } from '@pancakeswap/v3-sdk';

const provider = new ethers.providers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'base' });
const posMgr = new ethers.Contract(CONTRACTS.POSITION_MANAGER, NFTManagerABI.abi, provider);
const factory = new ethers.Contract(CONTRACTS.FACTORY, FactoryABI.abi, provider);
const masterchef = new ethers.Contract(CONTRACTS.MASTERCHEF, MasterChefABI, provider);

// Subgraph endpoint for MasterChefV3 Base
const MASTERCHEF_SUBGRAPH_ENDPOINT = `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/3oYoAoCJMV2ZyZSTpg6cUS1gKTzcc2cjmCVfpNyWZVmr`;

// Query subgraph
async function querySubgraph(endpoint, query, variables) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${THEGRAPH_API_KEY}`
      },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok) {
      console.error(`Subgraph response not OK for ${endpoint}: ${response.status}`);
      return null;
    }
    const result = await response.json();
    if (result.errors) {
      console.error(`Subgraph query errors for ${endpoint}:`, result.errors);
      return null;
    }
    return result.data;
  } catch (err) {
    console.error(`Error querying subgraph ${endpoint}:`, err);
    return null;
  }
}

// Fetch staked positions from subgraph
async function fetchStakedPositionsFromSubgraph(owner) {
  const query = `
    query GetUserStakedPositions($user: String!) {
      userPositions(
        where: { user: $user, liquidity_gt: "0" }
        orderBy: timestamp
        orderDirection: desc
        first: 100
      ) {
        id
        pool {
          id
          v3Pool
          allocPoint
          totalUsersCount
          userCount
          timestamp
          block
          masterChef {
            id
            totalAllocPoint
            undistributedCake
            lastHarvestBlock
            latestPeriodStartTime
            latestPeriodEndTime
            latestPeriodCakePerSecond
            latestPeriodCakeAmount
            periodDuration
            poolCount
            timestamp
            block
          }
        }
        tickLower
        tickUpper
        liquidity
        timestamp
        block
        user {
          id
          address
          timestamp
          block
        }
        earned
        isStaked
      }
    }
  `;
  const variables = { user: owner.toLowerCase() };
  const data = await querySubgraph(MASTERCHEF_SUBGRAPH_ENDPOINT, query, variables);
  return data?.userPositions || [];
}

async function getDirectOwnedIds(owner) {
  const count = await posMgr.balanceOf(owner);
  const ids = [];
  for (let i = 0; i < Number(count); i++) {
    const id = await posMgr.tokenOfOwnerByIndex(owner, i);
    const pos = await posMgr.positions(id);
    if (pos[7].gt(0)) {  // liquidity > 0
      ids.push(id.toString());
    }
  }
  return ids;
}

async function getStakedIds(owner) {
  const lowerOwner = owner.toLowerCase();
  const depositSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Deposit(address,uint256,uint256,uint256,int24,int24)'));
  const ownerPadded = ethers.utils.hexZeroPad(lowerOwner, 32);

  const currentBlock = await provider.getBlockNumber();
  const chunkSize = 500;
  const lookbackBlocks = 100000;  // ~2 days on Base; adjust if needed
  const startFromBlock = Math.max(17467449, currentBlock - lookbackBlocks);  // MasterChef V3 deployment or recent

  const tokenIds = new Set();

  const batches = [];
  for (let endBlock = currentBlock; endBlock > startFromBlock; endBlock -= chunkSize) {
    const startBlock = Math.max(startFromBlock, endBlock - chunkSize + 1);
    batches.push(async () => {
      const filter = {
        address: CONTRACTS.MASTERCHEF,
        topics: [depositSig, ownerPadded, null, null],
        fromBlock: '0x' + startBlock.toString(16),
        toBlock: '0x' + endBlock.toString(16)
      };
      try {
        const logs = await provider.getLogs(filter);
        for (const log of logs) {
          const tokenId = BigInt(log.topics[3]).toString();
          tokenIds.add(tokenId);
        }
        const progress = ((currentBlock - endBlock) / lookbackBlocks * 100).toFixed(1);
        console.log(`Processed Deposit logs for blocks ${startBlock} to ${endBlock} (${tokenIds.size} unique IDs found so far) - ${progress}% complete`);
      } catch (err) {
        console.error(`Error fetching Deposit logs for blocks ${startBlock} to ${endBlock}:`, err);
      }
    });
  }

  const batchSize = 20;  // Parallel; reduce if rate limits
  for (let i = 0; i < batches.length; i += batchSize) {
    await Promise.all(batches.slice(i, i + batchSize).map(b => b()));
    await new Promise(r => setTimeout(r, 200));  // Delay to avoid rate limits
  }

  const validIds = [];
  for (const id of tokenIds) {
    try {
      const info = await masterchef.userPositionInfos(id);
      if (info[0].gt(0) && info[6].toLowerCase() === lowerOwner) {  // liquidity > 0 and user == owner
        validIds.push(id);
      }
    } catch (err) {
      console.error(`Error validating staked token ID ${id}:`, err);
    }
  }

  return validIds;
}

export async function fetchAllTokenIds(owner) {
  const directIds = await getDirectOwnedIds(owner);
  const stakedPositions = await fetchStakedPositionsFromSubgraph(owner);
  const stakedIds = stakedPositions.map(pos => pos.id);
  return [...new Set([...directIds, ...stakedIds])];
}

export async function fetchPosition(tokenId) {
  const raw = await posMgr.positions(tokenId);
  const stakedPositions = await fetchStakedPositionsFromSubgraph(OWNER_ADDRESS);
  const subgraphPos = stakedPositions.find(pos => pos.id === tokenId.toString());
  return {
    tokenId,
    token0: raw[2],
    token1: raw[3],
    feeTier: Number(raw[4]),
    tickLower: subgraphPos ? Number(subgraphPos.tickLower) : Number(raw[5]),
    tickUpper: subgraphPos ? Number(subgraphPos.tickUpper) : Number(raw[6]),
    liquidity: subgraphPos ? BigNumber.from(subgraphPos.liquidity) : raw[7],
    feeGrowthInside0Last: raw[8],
    feeGrowthInside1Last: raw[9],
    owed0: raw[10],
    owed1: raw[11],
    earned: subgraphPos ? BigNumber.from(subgraphPos.earned) : await fetchFarmingRewards(tokenId),
    v3Pool: subgraphPos?.pool?.v3Pool
  };
}

export async function getPoolAddress(token0, token1, feeTier, v3PoolFromSubgraph) {
  if (v3PoolFromSubgraph) return v3PoolFromSubgraph;
  return factory.getPool(token0, token1, feeTier);
}

export async function fetchPoolState(poolAddress, tickLower, tickUpper) {
  const pool = new ethers.Contract(poolAddress, IUniswapV3PoolABI, provider);
  const slot0 = await pool.slot0();
  console.log(`Ticks in fetchPoolState: Lower=${tickLower} (type: ${typeof tickLower}), Upper=${tickUpper} (type: ${typeof tickUpper})`);

  const [liquidity, feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData] = await Promise.all([
    pool.liquidity(),
    pool.feeGrowthGlobal0X128(),
    pool.feeGrowthGlobal1X128(),
    pool.ticks(BigNumber.from(tickLower)),
    pool.ticks(BigNumber.from(tickUpper))
  ]);
  return { slot0, liquidity, feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData };
}

function computeFeeGrowthInside(tickCurrent, tickLower, tickUpper, feeGrowthGlobal, feeGrowthOutsideLower, feeGrowthOutsideUpper) {
  let feeGrowthBelow = tickCurrent >= tickLower ? feeGrowthOutsideLower : feeGrowthGlobal.sub(feeGrowthOutsideLower);
  let feeGrowthAbove = tickCurrent < tickUpper ? feeGrowthOutsideUpper : feeGrowthGlobal.sub(feeGrowthOutsideUpper);
  return feeGrowthGlobal.sub(feeGrowthBelow).sub(feeGrowthAbove);
}

async function computeUncollectedFees(positionData, poolState, dec0, dec1) {
  const { liquidity, feeGrowthInside0Last, feeGrowthInside1Last, tickLower, tickUpper, owed0, owed1 } = positionData;
  const { slot0, feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData } = poolState;
  const tickCurrent = Number(slot0.tick);

  const feeGrowthInside0 = computeFeeGrowthInside(tickCurrent, tickLower, tickUpper, feeGrowthGlobal0, tickLowerData.feeGrowthOutside0X128, tickUpperData.feeGrowthOutside0X128);
  const feeGrowthInside1 = computeFeeGrowthInside(tickCurrent, tickLower, tickUpper, feeGrowthGlobal1, tickLowerData.feeGrowthOutside1X128, tickUpperData.feeGrowthOutside1X128);

  const delta0 = feeGrowthInside0.sub(feeGrowthInside0Last);
  const delta1 = feeGrowthInside1.sub(feeGrowthInside1Last);
  const Q128 = BigNumber.from(2).pow(128);

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