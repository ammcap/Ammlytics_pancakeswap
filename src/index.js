import { ethers, BigNumber } from 'ethers';
import Decimal from 'decimal.js';
import sqlite3 from 'sqlite3';
import { fetchAllTokenIds, fetchPosition, getPoolAddress, fetchPoolState, computeAmounts, isStaked, fetchFarmingRewards, getTokenSymbol, getTokenDecimals, tickToPrice, fetchPositionEvents, posMgr, masterchef }
    from './fetchPositions.js';
import { OWNER_ADDRESS } from './config.js';

const db = new sqlite3.Database('./ammlytics.db');

db.serialize(() => {
  db.run("DROP TABLE IF EXISTS positions");
  db.run("DROP TABLE IF EXISTS events");
  db.run("CREATE TABLE IF NOT EXISTS positions (tokenId TEXT PRIMARY KEY, createdTimestamp INTEGER, initialAmount0 TEXT, initialAmount1 TEXT, initialUsd TEXT, tickLower INTEGER, tickUpper INTEGER, token0 TEXT, token1 TEXT, feeTier INTEGER, mintBlock INTEGER, feeGrowthInside0Last TEXT, feeGrowthInside1Last TEXT)");
  db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, tokenId TEXT, date TEXT, type TEXT, details TEXT)");
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
  db.run("INSERT OR REPLACE INTO positions (tokenId, createdTimestamp, initialAmount0, initialAmount1, initialUsd, tickLower, tickUpper, token0, token1, feeTier, mintBlock, feeGrowthInside0Last, feeGrowthInside1Last) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", 
    [tokenId, data.timestamp, data.initialAmount0.toString(), data.initialAmount1.toString(), initialUsd.toString(), data.tickLower, data.tickUpper, data.token0, data.token1, data.feeTier, data.mintBlock, data.feeGrowthInside0Last.toString(), data.feeGrowthInside1Last.toString()]);
}

async function getEventsFromDB(tokenId) {
  return new Promise((resolve) => {
    db.all("SELECT date, type, details FROM events WHERE tokenId = ? ORDER BY date", [tokenId], (err, rows) => {
      if (err) console.error(err);
      resolve(rows);
    });
  });
}

async function storeEvents(tokenId, events) {
  db.run("DELETE FROM events WHERE tokenId = ?", [tokenId]);
  for (const event of events) {
    db.run("INSERT INTO events (tokenId, date, type, details) VALUES (?, ?, ?, ?)", [tokenId, event.date, event.type, event.details]);
  }
}

async function main() {
    console.log(`Fetching positions for ${OWNER_ADDRESS}…`);
    const ids = await fetchAllTokenIds(OWNER_ADDRESS);

    if (!ids.length) {
        console.log('No v3 positions found for your address.');
        return;
    }

    for (const id of ids) {
        console.log(`\n⦿ Position #${id}`);
        let pos = await getPositionFromDB(id);
        let isNew = !pos;
        if (isNew) {
          pos = await fetchPosition(id);
        } else {
          pos.initialAmount0 = BigNumber.from(pos.initialAmount0);
          pos.initialAmount1 = BigNumber.from(pos.initialAmount1);
          pos.initialUsd = new Decimal(pos.initialUsd);
          pos.timestamp = Number(pos.createdTimestamp);
          pos.feeGrowthInside0Last = BigNumber.from(pos.feeGrowthInside0Last);
          pos.feeGrowthInside1Last = BigNumber.from(pos.feeGrowthInside1Last);
        }
        const sym0 = await getTokenSymbol(pos.token0);
        const sym1 = await getTokenSymbol(pos.token1);
        const feePercent = (pos.feeTier / 10000).toFixed(2) + '%';
        const staked = await isStaked(id);
        const creationDate = new Date(pos.timestamp * 1000).toLocaleString();
        console.log(`Created: ${creationDate}`);
        console.log(`Pair: ${sym0}/${sym1} (Fee: ${feePercent})`);
        const dec0 = await getTokenDecimals(pos.token0);
        const dec1 = await getTokenDecimals(pos.token1);

        const priceLower = tickToPrice(pos.tickLower, dec0, dec1);
        const priceUpper = tickToPrice(pos.tickUpper, dec0, dec1);
        const priceLowerInv = new Decimal(1).div(priceUpper);
        const priceUpperInv = new Decimal(1).div(priceLower);

        console.log(`Range: Tick ${pos.tickLower} to ${pos.tickUpper}`);
        console.log(`Price: Min ${priceLowerInv.toSignificantDigits(6)} / Max ${priceUpperInv.toSignificantDigits(6)} ${sym0} per ${sym1}`);
        console.log(`Staked in farm: ${staked ? 'Yes' : 'No'}`);
        const poolAddr = await getPoolAddress(pos.token0, pos.token1, pos.feeTier);
        console.log(`Pool: ${poolAddr}`);
        const poolState = await fetchPoolState(poolAddr, pos.tickLower, pos.tickUpper);
        let liquidity = await posMgr.positions(id)[7];
        let earned = BigNumber.from(0);
        if (staked) {
          const info = await masterchef.userPositionInfos(id);
          liquidity = info[0];
          earned = await fetchFarmingRewards(id);
        }
        const posLive = {...pos, liquidity, earned};
        const { amount0, amount1, fees0, fees1 } = await computeAmounts(posLive, poolState);

        console.log(` • ${sym0} amount: ${amount0}`);
        console.log(` • ${sym1} amount: ${amount1}`);
        console.log(` • Uncollected fees: ${fees0} ${sym0} / ${fees1} ${sym1}`);

        if (staked) {
            const cakeEarned = ethers.utils.formatEther(earned);
            console.log(` • CAKE earned: ${cakeEarned}`);
        }

        const initialAmount0Human = ethers.utils.formatUnits(pos.initialAmount0, dec0);
        const initialAmount1Human = ethers.utils.formatUnits(pos.initialAmount1, dec1);
        console.log(`Initial ${sym0} amount: ${initialAmount0Human}`);
        console.log(`Initial ${sym1} amount: ${initialAmount1Human}`);

        const initialPoolState = await fetchPoolState(poolAddr, pos.tickLower, pos.tickUpper, pos.mintBlock);
        const initialTick = initialPoolState.slot0.tick;
        const initialPrice = tickToPrice(initialTick, dec0, dec1);  // Price of token1 in token0
        console.log(`Initial price: ${initialPrice.toSignificantDigits(6)} ${sym1} per ${sym0}`);

        let initialUsd = pos.initialUsd;
        if (isNew) {
          initialUsd = new Decimal(0);
          const token0Lc = pos.token0.toLowerCase();
          const token1Lc = pos.token1.toLowerCase();
          const usdcLc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'.toLowerCase();  // USDC on Base

          if (token0Lc === usdcLc) {
              initialUsd = new Decimal(initialAmount0Human).add(new Decimal(initialAmount1Human).div(initialPrice));
          } else if (token1Lc === usdcLc) {
              const initialPriceInv = new Decimal(1).div(initialPrice);
              initialUsd = new Decimal(initialAmount1Human).add(new Decimal(initialAmount0Human).mul(initialPriceInv));
          } else {
              console.log('Warning: Neither token is USDC; skipping initial USD value.');
          }
          await storePosition(id, pos, initialUsd);
        }

        console.log(`Initial USD value: $${initialUsd.toFixed(2)}`);

        let events = await getEventsFromDB(id);
        if (isNew || !events.length) {
          events = await fetchPositionEvents(id, pos.mintBlock, dec0, dec1, sym0, sym1);
          await storeEvents(id, events);
        }
        if (events.length > 0) {
          console.log('Events:');
          for (const event of events) {
            console.log(` - ${event.date}: ${event.type} - ${event.details}`);
          }
        } else {
          console.log('No events found.');
        }
    }
}

main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});