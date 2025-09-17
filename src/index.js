import { ethers, BigNumber } from 'ethers';
import Decimal from 'decimal.js';
import sqlite3 from 'sqlite3';
import { fetchAllTokenIds, fetchPosition, getPoolAddress, fetchPoolState, computeAmounts, isStaked, getTokenSymbol, getTokenDecimals, tickToPrice, fetchPositionEvents, posMgr, masterchef, fetchCakePrice, getTokenPriceInUsd }
  from './fetchPositions.js';
import { OWNER_ADDRESS } from './config.js';
import express from 'express';
import path from 'path';

Decimal.set({ precision: 50 });  // Set high precision for decimal.js to avoid rounding issues in calcs
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const db = new sqlite3.Database('./ammlytics.db');
let D = Decimal;

db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS positions (tokenId TEXT PRIMARY KEY, createdTimestamp INTEGER, initialAmount0 TEXT, initialAmount1 TEXT, initialUsd TEXT, tickLower INTEGER, tickUpper INTEGER, token0 TEXT, token1 TEXT, feeTier INTEGER, mintBlock INTEGER)");
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, tokenId TEXT, date TEXT, type TEXT, details TEXT, block INTEGER)");
  db.run("ALTER TABLE positions ADD COLUMN last_queried_block INTEGER DEFAULT 0", (err) => {
    if (err && err.message.includes('duplicate column name')) {
      // Ignore if column already exists
    } else if (err) {
      console.error('Error adding last_queried_block column:', err);
    }
  });
});

async function getPositionFromDB(tokenId) {
  return new Promise((resolve) => {
    db.get("SELECT * FROM positions WHERE tokenId = ?", [tokenId], (err, row) => {
      if (err) console.error(err);
      resolve(row);
    });
  });
}

async function storePosition(tokenId, data, initialUsd) {
  db.run("INSERT OR REPLACE INTO positions (tokenId, createdTimestamp, initialAmount0, initialAmount1, initialUsd, tickLower, tickUpper, token0, token1, feeTier, mintBlock, last_queried_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [tokenId, data.timestamp, data.initialAmount0.toString(), data.initialAmount1.toString(), initialUsd.toString(), data.tickLower, data.tickUpper, data.token0, data.token1, data.feeTier, data.mintBlock, 0]);
}

async function getEventsFromDB(tokenId) {
  return new Promise((resolve) => {
    db.all("SELECT date, type, details FROM events WHERE tokenId = ? ORDER BY date", [tokenId], (err, rows) => {
      if (err) console.error(err);
      resolve(rows);
    });
  });
}

async function getMaxEventBlockFromDB(tokenId) {
  return new Promise((resolve) => {
    db.get("SELECT MAX(block) AS maxBlock FROM events WHERE tokenId = ?", [tokenId], (err, row) => {
      if (err) console.error(err);
      resolve(row.maxBlock || 0);
    });
  });
}

async function storeNewEvents(tokenId, newEvents) {
  for (const event of newEvents) {
    db.run("INSERT INTO events (tokenId, date, type, details, block) VALUES (?, ?, ?, ?, ?)", [tokenId, event.date, event.type, event.details, event.block]);
  }
}

async function getLastQueriedFromDB(tokenId) {
  return new Promise((resolve) => {
    db.get("SELECT last_queried_block FROM positions WHERE tokenId = ?", [tokenId], (err, row) => {
      if (err) console.error(err);
      resolve(row ? Number(row.last_queried_block) || 0 : 0);
    });
  });
}

async function updateLastQueried(tokenId, block) {
  db.run("UPDATE positions SET last_queried_block = ? WHERE tokenId = ?", [block, tokenId], (err) => {
    if (err) console.error('Error updating last_queried_block:', err);
  });
}

function formatTime(seconds) {
  const weeks = Math.floor(seconds / (3600 * 24 * 7));
  seconds %= 3600 * 24 * 7;
  const days = Math.floor(seconds / (3600 * 24));
  seconds %= 3600 * 24;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds = Math.floor(seconds % 60);

  if (weeks > 0) {
    return `${weeks}w ${days}d ${hours}h`;
  } else if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else {
    return `${minutes}m ${seconds}s`;
  }
}

async function fetchPositionData(walletAddress) {
  console.log(`Fetching positions for ${walletAddress}…`);
  const ids = await fetchAllTokenIds(walletAddress);

  if (!ids.length) {
    return { message: 'No v3 positions found for your address.' };
  }

  const positions = [];
  let totalPortfolioValue = new D(0);
  let totalDailyEarnings = 0;
  let totalAnnualEarnings = 0;
  let totalYield = 0;

  for (const id of ids) {
    let posData = { token_id: id };
    console.log(`
⦿ Position #${id}`);
    let pos = await getPositionFromDB(id);
    let isNew = !pos;
    if (isNew) {
      pos = await fetchPosition(id);
    } else {
      pos.initialAmount0 = BigNumber.from(pos.initialAmount0);
      pos.initialAmount1 = BigNumber.from(pos.initialAmount1);
      pos.initialUsd = new Decimal(pos.initialUsd);
      pos.timestamp = Number(pos.createdTimestamp);
    }
    const sym0 = await getTokenSymbol(pos.token0);
    const sym1 = await getTokenSymbol(pos.token1);
    posData.pair = `${sym0}/${sym1}`;
    const feePercent = (pos.feeTier / 10000).toFixed(2) + '%';
    const staked = await isStaked(id);
    const creationDate = new Date(pos.timestamp * 1000).toLocaleString();
    console.log(`Created: ${creationDate}`);
    console.log(`Pair: ${posData.pair} (Fee: ${feePercent})`);
    posData.initial_state = { date: creationDate };
    const dec0 = await getTokenDecimals(pos.token0);
    const dec1 = await getTokenDecimals(pos.token1);

    const priceLower = tickToPrice(pos.tickLower, dec0, dec1);
    const priceUpper = tickToPrice(pos.tickUpper, dec0, dec1);
    const priceLowerInv = new Decimal(1).div(priceUpper);
    const priceUpperInv = new Decimal(1).div(priceLower);
    posData.price_range_lower = priceLowerInv.toSignificantDigits(6);
    posData.price_range_upper = priceUpperInv.toSignificantDigits(6);
    console.log(`Price: Min ${posData.price_range_lower} / Max ${posData.price_range_upper} ${sym0} per ${sym1}`);
    console.log(`Staked in farm: ${staked ? 'Yes' : 'No'}`);
    const poolAddr = await getPoolAddress(pos.token0, pos.token1, pos.feeTier);
    console.log(`Pool: ${poolAddr}`);
    const poolState = await fetchPoolState(poolAddr, pos.tickLower, pos.tickUpper);
    const raw = await posMgr.positions(id);
    pos.feeGrowthInside0Last = raw[8];
    pos.feeGrowthInside1Last = raw[9];
    pos.owed0 = raw[10];
    pos.owed1 = raw[11];
    let liquidity = raw[7];

    if (staked) {
      const info = await masterchef.userPositionInfos(id);
      liquidity = info[0];
    }

    const posLive = { ...pos, liquidity };
    const { amount0, amount1, fees0: unstakedFees0, fees1: unstakedFees1 } = await computeAmounts(posLive, poolState);

    let fees0 = unstakedFees0;
    let fees1 = unstakedFees1;
    let cakeEarned = "0";

    const MaxUint128 = ethers.BigNumber.from(2).pow(128).sub(1);
    if (staked) {
      const collectParams = { tokenId: id, recipient: walletAddress, amount0Max: MaxUint128, amount1Max: MaxUint128 };
      const { amount0: fee0BN, amount1: fee1BN } = await posMgr.callStatic.collect(collectParams, { from: masterchef.address });
      fees0 = ethers.utils.formatUnits(fee0BN, dec0);
      fees1 = ethers.utils.formatUnits(fee1BN, dec1);
      const cakeEarnedBN = await masterchef.pendingCake(id);
      cakeEarned = ethers.utils.formatEther(cakeEarnedBN);
    }

    console.log(` • ${sym0} amount: ${amount0}`);
    console.log(` • ${sym1} amount: ${amount1}`);
    console.log(` • Uncollected fees: ${fees0} ${sym0} / ${fees1} ${sym1}`);

    if (staked) {
      console.log(` • CAKE earned: ${cakeEarned}`);
    }
    posData.rewards = [{ symbol: 'CAKE', amount: cakeEarned }];
    posData.current_balances = `${amount0} ${sym0} & ${amount1} ${sym1}`;

    const initialAmount0Human = ethers.utils.formatUnits(pos.initialAmount0, dec0);
    const initialAmount1Human = ethers.utils.formatUnits(pos.initialAmount1, dec1);
    console.log(`Initial ${sym0} amount: ${initialAmount0Human}`);
    console.log(`Initial ${sym1} amount: ${initialAmount1Human}`);
    posData.initial_state.balances = `${initialAmount0Human} ${sym0} & ${initialAmount1Human} ${sym1}`;

    const initialPoolState = await fetchPoolState(poolAddr, pos.tickLower, pos.tickUpper, pos.mintBlock);
    const initialTick = initialPoolState.slot0.tick;
    const initialPrice = tickToPrice(initialTick, dec0, dec1);  // Price of token1 in token0
    const initialPriceInv = new Decimal(1).div(initialPrice);
    console.log(`Initial price: ${initialPriceInv.toSignificantDigits(6)} ${sym0} per ${sym1}`);
    posData.initial_state.price = `${initialPriceInv.toSignificantDigits(6)} ${sym0} per ${sym1}`;

    let initialUsd = pos.initialUsd;
    if (!initialUsd || initialUsd.isZero()) {
      const dec0 = await getTokenDecimals(pos.token0);
      const dec1 = await getTokenDecimals(pos.token1);
      const initialAmount0Human = ethers.utils.formatUnits(pos.initialAmount0, dec0);
      const initialAmount1Human = ethers.utils.formatUnits(pos.initialAmount1, dec1);

      const price0 = await getTokenPriceInUsd(pos.token0);
      const price1 = await getTokenPriceInUsd(pos.token1);

      const usdValue0 = new Decimal(initialAmount0Human).mul(price0);
      const usdValue1 = new Decimal(initialAmount1Human).mul(price1);
      initialUsd = usdValue0.add(usdValue1);

      await storePosition(id, pos, initialUsd);
      pos.initialUsd = initialUsd;
    }

    console.log(`Initial USD value: ${initialUsd.toFixed(2)}`);
    posData.initial_state.usd_value = `$${initialUsd.toFixed(2)}`;

    let events = await getEventsFromDB(id);
    const lastQueried = await getLastQueriedFromDB(id);
    const maxBlock = await getMaxEventBlockFromDB(id);  // Still use this for reference, but not for starting
    const newStart = Math.max(pos.mintBlock, lastQueried + 1);
    const { newEvents, endBlock } = await fetchPositionEvents(id, newStart, dec0, dec1, sym0, sym1);
    if (newEvents.length > 0) {
      await storeNewEvents(id, newEvents);
      events = await getEventsFromDB(id);
    }
    // Always update last_queried_block, even if no new events
    await updateLastQueried(id, endBlock);

    if (events.length > 0) {
      console.log('Events:');
      for (const event of events) {
        console.log(` - ${event.date}: ${event.type} - ${event.details}`);
      }
      let totalCake = new Decimal(0);
      let totalFees0 = new Decimal(0);
      let totalFees1 = new Decimal(0);
      events.forEach(e => {
        if (e.type === 'Fee Claim (Tokens)') {
          const parts = e.details.split(' / ');
          const amount0 = new Decimal(parts[0].split(' ')[0]);
          const amount1 = new Decimal(parts[1].split(' ')[0]);
          totalFees0 = totalFees0.add(amount0);
          totalFees1 = totalFees1.add(amount1);
        }
        if (e.type === 'Fee Claim (CAKE)') {
          totalCake = totalCake.add(new Decimal(e.details));
        }
      });
      console.log(`Unclaimed swap fees: ${totalFees0.toFixed(6)} ${sym0} / ${totalFees1.toFixed(6)} ${sym1}`);
      console.log(`CAKE earned (claimed): ${totalCake.toFixed(6)}`);
      const cakePrice = await fetchCakePrice();
      console.log(`CAKE price: ${cakePrice.toFixed(4)}`);

      // Compute current price from pool state (cbBTC / USDC, small)
      const currentPriceCode = tickToPrice(poolState.slot0.tick, dec0, dec1);
      const priceCurrentDoc = new D(1).div(currentPriceCode);
      posData.current_price = `${priceCurrentDoc.toSignificantDigits(6)} ${sym0} per ${sym1}`;

      // APR Calculation
      const price0 = await getTokenPriceInUsd(pos.token0);
      const price1 = await getTokenPriceInUsd(pos.token1);
      const currentUsdValue = new Decimal(amount0).mul(price0).add(new Decimal(amount1).mul(price1));
      const unclaimedFeesUsd = new Decimal(fees0).mul(price0).add(new Decimal(fees1).mul(price1));
      const unclaimedCakeUsd = new Decimal(cakeEarned).mul(cakePrice);
      const claimedFeesUsd = totalFees0.mul(price0).add(totalFees1.mul(price1));
      const claimedCakeUsd = totalCake.mul(cakePrice);

      const totalRewardsUsd = unclaimedFeesUsd.add(unclaimedCakeUsd).add(claimedFeesUsd).add(claimedCakeUsd);
      const timeElapsed = (new Date().getTime() / 1000) - pos.timestamp;
      const hoursElapsed = timeElapsed / 3600;
      const rewardsPerHour = totalRewardsUsd.div(hoursElapsed);
      const annualRewards = rewardsPerHour.mul(24 * 365);
      const apr = annualRewards.div(initialUsd).mul(100);

      console.log(`Estimated APR: ${apr.toFixed(2)}%`);
      posData.annualized_apr = `${apr.toFixed(2)}%`;

      // Calculation details
      const formattedTime = formatTime(timeElapsed);
      const currentPositionValue = currentUsdValue;

      console.log(`
--- Calculation Details ---`);
      console.log(`- Total Rewards Accrued (USD): $${totalRewardsUsd.toFixed(4)}`);
      console.log(`- Time Elapsed: ${formattedTime}`);
      console.log(`- Current Position Value (USD): ${currentPositionValue.toFixed(2)}`);
      posData.estimated_value_usd = `$${currentPositionValue.toFixed(2)}`;
      posData.total_rewards_usd = totalRewardsUsd.toFixed(2);

      console.log(`--- Impermanent Loss and Breakeven Analysis ---`);

      // Define prices in "doc" terms (USDC per cbBTC, large numbers)
      const priceLowerDoc = priceLowerInv;  // Printed Min (e.g., 109461)
      const priceUpperDoc = priceUpperInv;  // Printed Max (e.g., 116229)
      const priceInitialDoc = initialPriceInv;
      
      // Define amounts (A = token1/volatile, B = token0/stable-ish)
      const amountAInitial = new D(initialAmount1Human);  // cbBTC initial
      const amountBInitial = new D(initialAmount0Human);  // USDC initial
      const amountACurrent = new D(amount1);  // cbBTC current
      const amountBCurrent = new D(amount0);  // USDC current

      // Step 1: Compute L
      const sa = D.sqrt(priceLowerDoc);
      const sb = D.sqrt(priceUpperDoc);
      const s0 = D.sqrt(priceInitialDoc);

      const oneOverS0 = new D(1).div(s0);
      const oneOverSb = new D(1).div(sb);
      const lFromA = amountAInitial.div(oneOverS0.sub(oneOverSb));

      const lFromB = amountBInitial.div(s0.sub(sa));

      const l = lFromA.add(lFromB).div(2);

      // Check discrepancy
      const discrepancyPercent = lFromA.sub(lFromB).abs().div(lFromA.add(lFromB).div(2)).mul(100);
      if (discrepancyPercent.gt(0.1)) {
        console.warn(`Liquidity calculation discrepancy: ${discrepancyPercent.toFixed(2)}% (possible rounding issue)`);
      }

      // Optional: Validate if position is in-range
      const inRange = pos.tickLower <= poolState.slot0.tick && poolState.slot0.tick < pos.tickUpper;
      posData.status = inRange ? 'IN RANGE' : 'OUT OF RANGE';
      if (!inRange) {
        console.warn('Position is currently out-of-range (earnings stopped; IL still calculated)');
      }

      // Step 3: Current IL
      const holdValue = new Decimal(initialAmount0Human).mul(price0).add(new Decimal(initialAmount1Human).mul(price1));
      const ilDollar = currentUsdValue.sub(holdValue);
      const ilPercent = ilDollar.div(holdValue).mul(100);

      // Step 4: IL at High End (price = price_upper_doc, all USDC)
      const sUpper = sb;
      const amountAAtUpper = new D(0);
      const amountBAtUpper = l.mul(sUpper.sub(sa));
      const lpValueUpper = amountBAtUpper;  // + 0 * price_upper_doc
      const holdValueUpper = amountBInitial.add(amountAInitial.mul(priceUpperDoc));
      const ilDollarUpper = lpValueUpper.sub(holdValueUpper);
      const ilPercentUpper = ilDollarUpper.div(holdValueUpper).mul(100);

      // Step 5: IL at Low End (price = price_lower_doc, all cbBTC)
      const sLower = sa;
      const amountBAtLower = new D(0);
      const amountAAtLower = l.mul(new D(1).div(sLower).sub(new D(1).div(sb)));
      const lpValueLower = amountAAtLower.mul(priceLowerDoc);  // + 0
      const holdValueLower = amountBInitial.add(amountAInitial.mul(priceLowerDoc));
      const ilDollarLower = lpValueLower.sub(holdValueLower);
      const ilPercentLower = ilDollarLower.div(holdValueLower).mul(100);

      // Output IL results
      console.log(`Current Price: ${priceCurrentDoc.toSignificantDigits(6)} ${sym0} per ${sym1}`);
      console.log(`Current IL: ${ilPercent.toFixed(3)}% ($${ilDollar.toFixed(2)})`);
      console.log(`IL at High End (${priceUpperDoc.toFixed(0)} ${sym0} per ${sym1}): ${ilPercentUpper.toFixed(3)}% ($${ilDollarUpper.toFixed(2)})`);
      console.log(`IL at Low End (${priceLowerDoc.toFixed(0)} ${sym0} per ${sym1}): ${ilPercentLower.toFixed(3)}% ($${ilDollarLower.toFixed(2)})`);

      // Step 6: Breakeven Time (using accrued rewards for precision)
      let rewardsPerSecond = new D(0);
      if (timeElapsed > 0) {
        rewardsPerSecond = new D(totalRewardsUsd).div(timeElapsed);  // total_rewards_accrued_usd / time_elapsed_seconds
      }

      // Base structure without breakeven (will add if available)
      posData.impermanent_loss_data = {
        position_age: formattedTime,
        current: {
          il_usd: `$${ilDollar.toFixed(2)}`,
          il_perc: `${ilPercent.toFixed(3)}%`,
          net_gain_loss: totalRewardsUsd.add(ilDollar).toFixed(2)
        },
        upper_bound: {
          price: priceUpperDoc.toFixed(0),
          il_usd: `$${ilDollarUpper.toFixed(2)}`,
          il_perc: `${ilPercentUpper.toFixed(3)}%`,
          breakeven_time: "N/A",  // Default
          breakeven_time_perc: 0,  // Default for coloring
          fees_vs_il: "N/A"  // Default
        },
        lower_bound: {
          price: priceLowerDoc.toFixed(0),
          il_usd: `$${ilDollarLower.toFixed(2)}`,
          il_perc: `${ilPercentLower.toFixed(3)}%`,
          breakeven_time: "N/A",  // Default
          breakeven_time_perc: 0,  // Default for coloring
          fees_vs_il: "N/A"  // Default
        }
      };

      if (rewardsPerSecond.lte(0)) {
        console.log('Breakeven: Insufficient rewards data (position too new or no rewards accrued)');
      } else {
        const timeSecondsUpper = ilDollarUpper.abs().div(rewardsPerSecond);
        const timeSecondsLower = ilDollarLower.abs().div(rewardsPerSecond);

        console.log(`Breakeven Time for High End IL: ${formatTime(timeSecondsUpper.toNumber())}`);
        console.log(`Breakeven Time for Low End IL: ${formatTime(timeSecondsLower.toNumber())}`);

        // Now add breakeven fields since data is available
        posData.impermanent_loss_data.upper_bound.breakeven_time = formatTime(timeSecondsUpper.toNumber());
        posData.impermanent_loss_data.upper_bound.breakeven_time_perc = timeSecondsUpper.div(new D(365 * 24 * 3600)).mul(100).toNumber();
        const netUpper = totalRewardsUsd.plus(ilDollarUpper);
        posData.impermanent_loss_data.upper_bound.fees_vs_il = `$${netUpper.toFixed(2)}`;
        posData.impermanent_loss_data.upper_bound.fees_vs_il_net = netUpper.toNumber();

        posData.impermanent_loss_data.lower_bound.breakeven_time = formatTime(timeSecondsLower.toNumber());
        posData.impermanent_loss_data.lower_bound.breakeven_time_perc = timeSecondsLower.div(new D(365 * 24 * 3600)).mul(100).toNumber();
        const netLower = totalRewardsUsd.plus(ilDollarLower);
        posData.impermanent_loss_data.lower_bound.fees_vs_il = `$${netLower.toFixed(2)}`;
        posData.impermanent_loss_data.lower_bound.fees_vs_il_net = netLower.toNumber();
      }

      // Other UI fields
      posData.daily_projected_usd_earnings = (rewardsPerHour * 24).toFixed(2);
      posData.annual_projected_usd_earnings = annualRewards.toFixed(2);
      posData.total_rewards_usd = totalRewardsUsd.toFixed(2);

      // Price range percentage for slider (linear in price for visual accuracy)
      const rangeWidthPrice = priceUpperDoc.sub(priceLowerDoc);
      posData.price_range_percentage = priceCurrentDoc.sub(priceLowerDoc).div(rangeWidthPrice).mul(100).toNumber();

      // Percent to lower/upper as price change percentages
      posData.perc_to_lower = `${priceCurrentDoc.sub(priceLowerDoc).div(priceCurrentDoc).mul(100).toFixed(2)}% below`;
      posData.perc_to_upper = `${priceUpperDoc.sub(priceCurrentDoc).div(priceCurrentDoc).mul(100).toFixed(2)}% above`;

      // Aggregate for portfolio summary
      totalPortfolioValue = totalPortfolioValue.add(currentUsdValue);
      totalDailyEarnings += parseFloat(posData.daily_projected_usd_earnings);
      totalAnnualEarnings += parseFloat(posData.annual_projected_usd_earnings);
      totalYield += parseFloat(apr);

    } else {
      console.log('No events found.');
      posData.impermanent_loss_data = {};
    }

    positions.push(posData);
  }

  return {
    total_portfolio_value: `$${totalPortfolioValue.toFixed(2)}`,
    num_active_positions: positions.length,
    total_daily_projected_usd_earnings: totalDailyEarnings.toFixed(2),
    total_annual_projected_usd_earnings: totalAnnualEarnings.toFixed(2),
    total_annual_yield: `${(totalYield / positions.length).toFixed(2)}%`,
    positions
  };
}

const app = express();
const port = 3000;

// Serve static files from src/public
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint for data
app.get('/api/data', async (req, res) => {
  const walletAddress = req.query.wallet_address || OWNER_ADDRESS;
  try {
    const data = await fetchPositionData(walletAddress);
    res.json(data);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});