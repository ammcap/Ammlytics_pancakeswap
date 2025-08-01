// src/fetchPositions.js
import { ethers, BigNumber } from 'ethers';
import Decimal from 'decimal.js';

import { RPC_URL, CHAIN_ID, OWNER_ADDRESS, CONTRACTS, THEGRAPH_API_KEY } from './config.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load ABIs
const NFTManagerABI = require('@pancakeswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json');
const FactoryABI = require('@pancakeswap/v3-core/artifacts/contracts/PancakeV3Factory.sol/PancakeV3Factory.json');

const MasterChefABI = [
  'function userPositionInfos(uint256) view returns (uint128 liquidity, uint128 boostLiquidity, int24 tickLower, int24 tickUpper, uint256 rewardGrowthInside, uint256 reward, address user, uint32 pid, uint256 boostMultiplier)',
  'function pendingCake(uint256 _tokenId) view returns (uint256)',
  'event Deposit(address indexed user, uint256 indexed tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper)',
  'event Withdraw(address indexed user, uint256 indexed tokenId, uint128 liquidity, int24 tickLower, int24 tickUpper)'
];

const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

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

const MASTERCHEF_SUBGRAPH_ENDPOINT = `https://gateway.thegraph.com/api/${THEGRAPH_API_KEY}/subgraphs/id/3oYoAoCJMV2ZyZSTpg6cUS1gKTzcc2cjmCVfpNyWZVmr`;

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
  const depositSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Deposit(address,uint256,uint128,int24,int24)'));
  const ownerPadded = ethers.utils.hexZeroPad(lowerOwner, 32);

  const currentBlock = await provider.getBlockNumber();
  const chunkSize = 2000;
  const lookbackBlocks = 100000;  // ~2 days on Base; adjust if needed
  const startFromBlock = Math.max(17467449, currentBlock - lookbackBlocks);  // MasterChef V3 deployment or recent

  const tokenIds = new Set();

  const batches = [];
  for (let endBlock = currentBlock; endBlock > startFromBlock; endBlock -= chunkSize) {
    const startBlock = Math.max(startFromBlock, endBlock - chunkSize + 1);
    batches.push(async () => {
      const filter = {
        address: CONTRACTS.MASTERCHEF,
        topics: [depositSig, ownerPadded, null],
        fromBlock: '0x' + startBlock.toString(16),
        toBlock: '0x' + endBlock.toString(16)
      };
      try {
        const logs = await provider.getLogs(filter);
        for (const log of logs) {
          const tokenId = BigInt(log.topics[2]).toString();
          tokenIds.add(tokenId);
        }
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

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';  // USDC on Base
const CAKE_ADDRESS = '0x3055913c90fcc1a6ce9a358911721eeb942013a1';  // CAKE on Base
const TRANSFER_EVENT_SIG = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Transfer(address,address,uint256)'));
const ZERO_PADDED = ethers.utils.hexZeroPad('0x0000000000000000000000000000000000000000', 32);

export async function fetchInitialData(tokenId) {
  const tokenIdBN = BigNumber.from(tokenId);
  const tokenIdPadded = ethers.utils.hexZeroPad(tokenIdBN.toHexString(), 32);

  // Binary search to find the mint block
  let low = 1;  // Base genesis is block 1
  let high = await provider.getBlockNumber();
  let mintBlock = null;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      await posMgr.ownerOf(tokenId, { blockTag: mid });
      mintBlock = mid;
      high = mid - 1;  // Search for earliest (mint) block
    } catch (err) {
      if (err.reason.includes('token does not exist') || err.message.includes('revert')) {
        low = mid + 1;
      } else {
        throw err;  // Unexpected error
      }
    }
  }

  if (!mintBlock) {
    throw new Error(`Mint block not found for tokenId ${tokenId}`);
  }

  const blockInfo = await provider.getBlock(mintBlock);
  const mintTimestamp = blockInfo.timestamp;

  // Single-block log search for the mint Transfer event
  const filter = {
    address: CONTRACTS.POSITION_MANAGER,
    topics: [TRANSFER_EVENT_SIG, ZERO_PADDED, null, tokenIdPadded],
    fromBlock: mintBlock,
    toBlock: mintBlock
  };
  const logs = await provider.getLogs(filter);
  if (logs.length === 0) {
    throw new Error(`No mint event found in block ${mintBlock} for tokenId ${tokenId}`);
  }

  // Get tx receipt and parse IncreaseLiquidity
  const txHash = logs[0].transactionHash;
  const receipt = await provider.getTransactionReceipt(txHash);

  let initialAmount0, initialAmount1;
  const iface = new ethers.utils.Interface(NFTManagerABI.abi);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === CONTRACTS.POSITION_MANAGER.toLowerCase()) {
      try {
        const parsedLog = iface.parseLog(log);
        if (parsedLog.name === 'IncreaseLiquidity' && parsedLog.args.tokenId.eq(tokenIdBN)) {
          initialAmount0 = parsedLog.args.amount0;
          initialAmount1 = parsedLog.args.amount1;
          break;
        }
      } catch { }
    }
  }

  if (!initialAmount0 || !initialAmount1) {
    throw new Error(`No IncreaseLiquidity event found in mint tx for tokenId ${tokenId}`);
  }

  return { initialAmount0, initialAmount1, mintTimestamp, mintBlock };
}

export async function fetchPosition(tokenId) {
  const raw = await posMgr.positions(tokenId);
  const stakedPositions = await fetchStakedPositionsFromSubgraph(OWNER_ADDRESS);
  const subgraphPos = stakedPositions.find(pos => pos.id === tokenId.toString());

  const initial = await fetchInitialData(tokenId);  // New call

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
    v3Pool: subgraphPos?.pool?.v3Pool,
    timestamp: initial.mintTimestamp,
    initialAmount0: initial.initialAmount0,
    initialAmount1: initial.initialAmount1,
    mintBlock: initial.mintBlock
  };
}

export async function getPoolAddress(token0, token1, feeTier, v3PoolFromSubgraph) {
  if (v3PoolFromSubgraph) return v3PoolFromSubgraph;
  return factory.getPool(token0, token1, feeTier);
}

export async function fetchPoolState(poolAddress, tickLower, tickUpper, blockTag = null) {
  const pool = new ethers.Contract(poolAddress, IUniswapV3PoolABI, provider);
  const callOptions = blockTag ? { blockTag } : {};
  const [slot0, liquidity, feeGrowthGlobal0, feeGrowthGlobal1, tickLowerData, tickUpperData] = await Promise.all([
    pool.slot0(callOptions),
    pool.liquidity(callOptions),
    pool.feeGrowthGlobal0X128(callOptions),
    pool.feeGrowthGlobal1X128(callOptions),
    pool.ticks(BigNumber.from(tickLower), callOptions),
    pool.ticks(BigNumber.from(tickUpper), callOptions)
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

export async function getTokenDecimals(address) {
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

export function tickToPrice(tick, dec0, dec1) {
  // The price of token1 in terms of token0 is 1.0001^tick
  // We need to adjust for the token decimals.
  const price = new Decimal(1.0001).pow(tick);
  const priceAdjusted = price.div(new Decimal(10).pow(dec1 - dec0));
  return priceAdjusted;
}

export async function fetchPositionEvents(tokenId, startBlock, dec0, dec1, sym0, sym1) {
  const tokenIdBN = BigNumber.from(tokenId);
  const tokenIdPadded = ethers.utils.hexZeroPad(tokenIdBN.toHexString(), 32);

  const currentBlock = await provider.getBlockNumber();
  let endBlock = currentBlock;
  if (startBlock > currentBlock) {
    console.log(`No new blocks to query for tokenId ${tokenId} (start: ${startBlock}, current: ${currentBlock})`);
    return { newEvents: [], endBlock };
  }

  const chunkSize = 499;  // Updated here
  const ifaceMgr = new ethers.utils.Interface(NFTManagerABI.abi);
  const ifaceMC = new ethers.utils.Interface(MasterChefABI);
  const ifaceERC20 = new ethers.utils.Interface(ERC20_ABI);
  const ownerLower = OWNER_ADDRESS.toLowerCase();
  const ownerPadded = ethers.utils.hexZeroPad(ownerLower, 32);

  // Event signatures
  const increaseSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('IncreaseLiquidity(uint256,uint128,uint256,uint256)'));
  const decreaseSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('DecreaseLiquidity(uint256,uint128,uint256,uint256)'));
  const collectSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Collect(uint256,address,uint256,uint256)'));
  const depositSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Deposit(address,uint256,uint128,int24,int24)'));
  const withdrawSig = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('Withdraw(address,uint256,uint128,int24,int24)'));

  const events = [];

  const batches = [];
  for (let endBlockChunk = currentBlock; endBlockChunk >= startBlock; endBlockChunk -= chunkSize) {
    const startBlockChunk = Math.max(startBlock, endBlockChunk - chunkSize + 1);
    batches.push(async () => {
      // PositionManager events
      const mgrFilter = {
        address: CONTRACTS.POSITION_MANAGER,
        topics: [[increaseSig, decreaseSig, collectSig], tokenIdPadded],
        fromBlock: '0x' + startBlockChunk.toString(16),
        toBlock: '0x' + endBlockChunk.toString(16)
      };
      let mgrLogs = [];
      try {
        mgrLogs = await provider.getLogs(mgrFilter);
        console.log(`Fetched ${mgrLogs.length} PositionManager logs for blocks ${startBlockChunk} to ${endBlockChunk}`);
      } catch (err) {
        console.error(`Error fetching PositionManager logs for blocks ${startBlockChunk} to ${endBlockChunk}:`, err);
      }

      for (const log of mgrLogs) {
        const parsed = ifaceMgr.parseLog(log);
        console.log('Parsed mgr log name: ', parsed.name);
        const timestamp = (await provider.getBlock(log.blockNumber)).timestamp;
        const date = new Date(timestamp * 1000).toLocaleString();
        let type, amount0, amount1;
        if (parsed.name === 'IncreaseLiquidity') {
          type = 'Deposit';
          amount0 = ethers.utils.formatUnits(parsed.args.amount0, dec0);
          amount1 = ethers.utils.formatUnits(parsed.args.amount1, dec1);
        } else if (parsed.name === 'DecreaseLiquidity') {
          type = 'Withdrawal';
          amount0 = ethers.utils.formatUnits(parsed.args.amount0, dec0);
          amount1 = ethers.utils.formatUnits(parsed.args.amount1, dec1);
        } else if (parsed.name === 'Collect') {
          type = 'Fee Claim (Tokens)';
          amount0 = ethers.utils.formatUnits(parsed.args.amount0, dec0);
          amount1 = ethers.utils.formatUnits(parsed.args.amount1, dec1);
          console.log('Adding Fee Claim (Tokens): ', amount0, amount1, date);
        }
        const event = { date, type, details: `${amount0} ${sym0} / ${amount1} ${sym1}`, block: log.blockNumber };
        events.push(event);
      }

      // MasterChef events (Deposit/Withdraw)
      const mcFilter = {
        address: CONTRACTS.MASTERCHEF,
        topics: [[depositSig, withdrawSig], ownerPadded, tokenIdPadded],
        fromBlock: '0x' + startBlockChunk.toString(16),
        toBlock: '0x' + endBlockChunk.toString(16)
      };
      let mcLogs = [];
      try {
        mcLogs = await provider.getLogs(mcFilter);
        console.log(`Fetched ${mcLogs.length} MasterChef logs for blocks ${startBlockChunk} to ${endBlockChunk}`);
      } catch (err) {
        console.error(`Error fetching MasterChef logs for blocks ${startBlockChunk} to ${endBlockChunk}:`, err);
      }
      for (const log of mcLogs) {
        try {
          const parsed = ifaceMC.parseLog(log);
          const timestamp = (await provider.getBlock(log.blockNumber)).timestamp;
          const date = new Date(timestamp * 1000).toLocaleString();
          let type, details;
          if (parsed.name === 'Deposit') {
            type = 'Deposit (Staked)';
            details = parsed.args.liquidity.toString();
          } else if (parsed.name === 'Withdraw') {
            type = 'Withdrawal (Unstaked)';
            details = parsed.args.liquidity.toString();
          }
          const event = { date, type, details, block: log.blockNumber };
          events.push(event);
        } catch (parseErr) {
          console.error(`Error parsing MasterChef log:`, parseErr);
        }
      }

      // CAKE Transfer events (from MasterChef to owner)
      const cakeFilter = {
        address: CAKE_ADDRESS,
        topics: [TRANSFER_EVENT_SIG, ethers.utils.hexZeroPad(CONTRACTS.MASTERCHEF, 32), ownerPadded],
        fromBlock: '0x' + startBlockChunk.toString(16),
        toBlock: '0x' + endBlockChunk.toString(16)
      };
      let cakeLogs = [];
      try {
        cakeLogs = await provider.getLogs(cakeFilter);
        console.log(`Fetched ${cakeLogs.length} CAKE Transfer logs for blocks ${startBlockChunk} to ${endBlockChunk}`);
      } catch (err) {
        console.error(`Error fetching CAKE Transfer logs for blocks ${startBlockChunk} to ${endBlockChunk}:`, err);
      }

      for (const log of cakeLogs) {
        const parsed = ifaceERC20.parseLog(log);
        const timestamp = (await provider.getBlock(log.blockNumber)).timestamp;
        const date = new Date(timestamp * 1000).toLocaleString();
        const amount = ethers.utils.formatEther(parsed.args.value);
        const event = { date, type: 'Fee Claim (CAKE)', details: amount, block: log.blockNumber };
        events.push(event);
      }
    });
  }

  // Process batches in smaller groups to avoid rate limits
  const batchSize = 10;  // Adjust down if rate limits hit (e.g., to 10)
  for (let i = 0; i < batches.length; i += batchSize) {
    await Promise.all(batches.slice(i, i + batchSize).map(b => b()));
    await new Promise(r => setTimeout(r, 200));  // Delay between batches
  }

  console.log('Events before sort: ', events);

  // Sort events by date
  events.sort((a, b) => new Date(a.date) - new Date(b.date));

  console.log('Events after sort: ', events);

  return { newEvents: events, endBlock: currentBlock };
}

export { posMgr, masterchef };