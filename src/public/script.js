document.addEventListener('DOMContentLoaded', () => {
    const walletInputSection = document.getElementById('wallet-input-section');
    const walletDisplaySection = document.getElementById('wallet-display-section');
    const walletAddressInput = document.getElementById('wallet-address-input');
    const saveWalletBtn = document.getElementById('save-wallet-btn');
    const removeWalletBtn = document.getElementById('remove-wallet-btn');
    const displayedWalletAddress = document.getElementById('displayed-wallet-address');
    const mainContent = document.getElementById('main-content');
    const loadingMessage = document.getElementById('loading-message');
    const errorMessage = document.getElementById('error-message');
    const portfolioSummaryDiv = document.getElementById('portfolio-summary');
    const positionsContainer = document.getElementById('positions-container');

    const WALLET_STORAGE_KEY = 'pancakeswap_v3_wallet_address';

    // Function to show/hide wallet input/display sections
    function updateWalletUI() {
        const storedAddress = localStorage.getItem(WALLET_STORAGE_KEY);
        if (storedAddress) {
            walletInputSection.style.display = 'none';
            walletDisplaySection.style.display = 'block';
            displayedWalletAddress.textContent = formatWalletAddress(storedAddress);
            mainContent.style.display = 'block';
            fetchData(storedAddress);
        } else {
            walletInputSection.style.display = 'block';
            walletDisplaySection.style.display = 'none';
            mainContent.style.display = 'none';
            // Clear previous data if no wallet is set
            portfolioSummaryDiv.innerHTML = '';
            positionsContainer.innerHTML = '';
            errorMessage.textContent = '';
            loadingMessage.style.display = 'none';
        }
    }

    // Function to fetch data from the Python script
    async function fetchData(walletAddress) {
        loadingMessage.textContent = 'Fetching and processing data...';
        loadingMessage.style.display = 'block';
        errorMessage.textContent = '';
        try {
            const response = await fetch(`/api/data?wallet_address=${walletAddress}`);
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            displayData(data);
        } catch (error) {
            console.error('Error fetching data:', error);
            errorMessage.textContent = `Failed to load data. Error: ${error.message}`;
        } finally {
            loadingMessage.style.display = 'none';
        }
    }

    // Function to display the fetched data
    function displayData(data) {
        if (data.error) {
            errorMessage.textContent = `Error from script: ${data.error}`;
            return;
        }
        if (data.message) {
            positionsContainer.innerHTML = `<p>${data.message}</p>`;
            return;
        }

        portfolioSummaryDiv.innerHTML = `
            <div style="display: flex; justify-content: space-between; padding: 4px 0; margin-bottom: 2px;">
                <span style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Portfolio Value:</span>
                <span style="font-weight: 700; color: var(--color-text-primary); font-size: 1.1em;">${data.total_portfolio_value}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; margin-bottom: 2px;">
                <span style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Active Positions:</span>
                <span style="font-weight: 700; color: var(--color-text-primary); font-size: 1.1em;">${data.num_active_positions}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; margin-bottom: 2px;">
                <span style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Daily Earnings:</span>
                <span style="font-weight: 700; color: var(--color-positive); font-size: 1.1em;">$${data.total_daily_projected_usd_earnings}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; margin-bottom: 2px;">
                <span style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Annual Earnings:</span>
                <span style="font-weight: 700; color: var(--color-positive); font-size: 1.1em;">$${data.total_annual_projected_usd_earnings}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 4px 0; margin-bottom: 2px;">
                <span style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Total Yield:</span>
                <span style="font-weight: 700; color: var(--color-positive); font-size: 1.1em;">${data.total_annual_yield}</span>
            </div>
        `;
        positionsContainer.innerHTML = ''; // Clear previous content

        data.positions.forEach(position => {
            // Calculate Position Balance Gain/Loss
            const initialValue = parseFloat(position.initial_state.usd_value.replace(/[^\d.-]/g, ''));
            const currentValue = parseFloat(position.estimated_value_usd.replace(/[^\d.-]/g, ''));
            position.position_balance_gain_loss_usd = currentValue - initialValue;
            position.position_balance_gain_loss_percentage = (initialValue > 0) ? (position.position_balance_gain_loss_usd / initialValue) * 100 : 0;

            const card = document.createElement('div');
            card.classList.add('position-card');

            // --- Prepare data for display ---
            const statusClass = position.status === 'IN RANGE' ? 'status-in-range' : 'status-out-of-range';

            let unclaimedFeesHtml = '';
            if (position.unclaimedFees && position.unclaimedFees.length > 0) {
                position.unclaimedFees.forEach(fee => {
                    let amountStr = String(fee.amount);
                    const feeAmount = parseFloat(amountStr);

                    if (feeAmount > 0) {
                        const dotIndex = amountStr.indexOf('.');
                        if (dotIndex !== -1) {
                            if (amountStr.length > dotIndex + 9) {
                                amountStr = amountStr.substring(0, dotIndex + 9);
                            }
                            amountStr = amountStr.replace(/0+$/, '');
                            if (amountStr.endsWith('.')) {
                                amountStr = amountStr.slice(0, -1);
                            }
                        }

                        let usdValueStr = '';
                        if (fee.price) {
                            const usdValue = parseFloat(amountStr) * fee.price;
                            usdValueStr = ` ($${usdValue.toFixed(2)})`;
                        }
                        
                        unclaimedFeesHtml += `<span class="reward-sub-line">${amountStr} ${fee.symbol}${usdValueStr}</span>`;
                    }
                });
            }

            // Find CAKE rewards for the sub-line
            let cakeRewardAmount = '';
            if (position.rewards && position.rewards.length > 0) {
                const cakeReward = position.rewards.find(r => r.symbol === 'CAKE');
                if (cakeReward && cakeReward.amount && parseFloat(cakeReward.amount) > 0) {
                    let amountStr = cakeReward.amount;
                    const dotIndex = amountStr.indexOf('.');

                    if (dotIndex !== -1) {
                        // Truncate to 8 decimal places
                        if (amountStr.length > dotIndex + 9) {
                            amountStr = amountStr.substring(0, dotIndex + 9);
                        }
                        // Remove trailing zeros
                        amountStr = amountStr.replace(/0+$/, '');
                        // If we are left with a trailing decimal point, remove it
                        if (amountStr.endsWith('.')) {
                            amountStr = amountStr.slice(0, -1);
                        }
                    }

                    let cakeUsdValue = '';
                    if (position.cakePrice) {
                        const cakeAmount = parseFloat(amountStr);
                        if (!isNaN(cakeAmount)) {
                            const usdValue = cakeAmount * position.cakePrice;
                            cakeUsdValue = ` ($${usdValue.toFixed(2)})`;
                        }
                    }
                    cakeRewardAmount = `${amountStr} CAKE${cakeUsdValue}`;
                }
            }

            // Impermanent Loss & Breakeven
            let ilHtml = '';
            if (position.impermanent_loss_data && Object.keys(position.impermanent_loss_data).length > 0) {
                const ilData = position.impermanent_loss_data;
                const netGainLoss = parseFloat(ilData.current.net_gain_loss.replace(/,/g, ''));
                const netGainLossClass = netGainLoss >= 0 ? 'value-positive' : 'value-negative';
                const feesVsIlUpperClass = ilData.upper_bound.fees_vs_il_net >= 0 ? 'value-positive' : 'value-negative';
                const feesVsIlLowerClass = ilData.lower_bound.fees_vs_il_net >= 0 ? 'value-positive' : 'value-negative';

                ilHtml = `
                    <div class="il-analysis">
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.8em;">Position Age: <span style="font-weight: 600; color: var(--color-text-primary); font-size: 0.9em;">${ilData.position_age}</span></p>
                        <hr style="border-color: var(--color-bg-tertiary); margin: 8px 0;">
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Current IL: <span class="value value-negative" style="font-weight: 700; font-size: 1.1em;">${ilData.current.il_usd} (${ilData.current.il_perc})</span></p>
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Net G/L: <span class="value ${netGainLossClass}" style="font-weight: 700; font-size: 1.1em;">$${ilData.current.net_gain_loss}</span></p>
                        <hr style="border-color: var(--color-bg-tertiary); margin: 8px 0;">
                        <p style="font-weight: 600; color: var(--color-text-primary); font-size: 1em;">Upper Bound (${ilData.upper_bound.price} ${position.price_label}):</p>
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">IL: <span class="value value-negative" style="font-weight: 700; font-size: 1.1em;">${ilData.upper_bound.il_usd} (${ilData.upper_bound.il_perc})</span></p>
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Breakeven: <span class="value ${getBreakevenColorClass(ilData.upper_bound.breakeven_time_perc)}" style="font-weight: 700; font-size: 1.1em;">${ilData.upper_bound.breakeven_time}</span></p>
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Fees vs IL: <span class="value ${feesVsIlUpperClass}" style="font-weight: 700; font-size: 1.1em;">${ilData.upper_bound.fees_vs_il}</span></p>
                        <hr style="border-color: var(--color-bg-tertiary); margin: 8px 0;">
                        <p style="font-weight: 600; color: var(--color-text-primary); font-size: 1em;">Lower Bound (${ilData.lower_bound.price} ${position.price_label}):</p>
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">IL: <span class="value value-negative" style="font-weight: 700; font-size: 1.1em;">${ilData.lower_bound.il_usd} (${ilData.lower_bound.il_perc})</span></p>
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Breakeven: <span class="value ${getBreakevenColorClass(ilData.lower_bound.breakeven_time_perc)}" style="font-weight: 700; font-size: 1.1em;">${ilData.lower_bound.breakeven_time}</span></p>
                        <p style="font-weight: 500; color: var(--color-text-secondary); font-size: 0.9em;">Fees vs IL: <span class="value ${feesVsIlLowerClass}" style="font-weight: 700; font-size: 1.1em;">${ilData.lower_bound.fees_vs_il}</span></p>
                    </div>
                `;
            } else {
                ilHtml = '<p style="color: var(--color-text-secondary);">IL data not available (position may be new).</p>';
            }

            const priceRangeHTML = `
                <div class="price-range-visual">
                    <!-- Lower Bound (for desktop view) -->
                    <div class="range-endpoint lower-bound desktop-only">
                    <span class="range-label">${position.price_range_lower}</span>
                    <span class="range-percent">${position.perc_to_lower}</span>
                    </div>

                    <!-- The Bar -->
                    <div class="range-bar">
                    <div class="range-indicator" style="--position: ${position.price_range_percentage}%">
                        <div class="current-price-label">${position.current_price}</div>
                    </div>
                    </div>

                    <!-- Upper Bound (for desktop view) -->
                    <div class="range-endpoint upper-bound desktop-only">
                    <span class="range-label">${position.price_range_upper}</span>
                    <span class="range-percent">${position.perc_to_upper}</span>
                    </div>

                    <!-- Mobile-only labels -->
                    <div class="range-endpoint upper-bound mobile-only">
                    <span class="range-label">${position.price_range_upper}</span>
                    <span class="range-percent">${position.perc_to_upper}</span>
                    </div>
                    <div class="range-endpoint lower-bound mobile-only">
                    <span class="range-label">${position.price_range_lower}</span>
                    <span class="range-percent">${position.perc_to_lower}</span>
                    </div>
                </div>
                `;

            // **UPDATED HTML STRUCTURE FOR THE HEADER**
            card.innerHTML = `
                <div class="card-header">
                    <div class="header-left">
                        <h2>${position.pair}</h2>
                        <div class="status ${statusClass}">${position.status}</div>
                    </div>
                    <div class="header-center">
                        ${priceRangeHTML}
                    </div>
                    <div class="header-right">
                        <div class="position-value">
                            <span style="font-size: 0.7em; color: var(--color-text-secondary);">Est. Value</span><br>
                            ${position.estimated_value_usd}
                        </div>
                    </div>
                </div>

                <div class="card-body">
                    <div class="card-section">
                        <h3 class="section-title">IL & Breakeven Analysis</h3>
                        ${ilHtml}
                    </div>

                    <div class="card-section">
                        <h3 class="section-title">Performance</h3>
                        <div class="metric">
                            <span class="metric-label" style="font-weight: 500; font-size: 0.9em;">Rewards</span>
                            <div class="metric-value-container">
                                <span class="metric-value value-positive" style="font-weight: 700; font-size: 1.1em;">${position.total_rewards_usd}</span>
                                <span class="reward-sub-line">${cakeRewardAmount}</span>
                                ${unclaimedFeesHtml}
                            </div>
                        </div>
                        <div class="metric">
                            <span class="metric-label" style="font-weight: 500; font-size: 0.9em;">APR</span>
                            <span class="metric-value value-positive" style="font-weight: 700; font-size: 1.1em;">${position.annualized_apr}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label" style="font-weight: 500; font-size: 0.9em;">Daily Earnings</span>
                            <span class="metric-value value-positive" style="font-weight: 700; font-size: 1.1em;">$${position.daily_projected_usd_earnings}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label" style="font-weight: 500; font-size: 0.9em;">Annual Earnings</span>
                            <span class="metric-value value-positive" style="font-weight: 700; font-size: 1.1em;">$${position.annual_projected_usd_earnings}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label" style="font-weight: 500; font-size: 0.9em;">Position G/L</span>
                            <div class="metric-value-container">
                                <span class="metric-value ${position.position_balance_gain_loss_usd >= 0 ? 'value-positive' : 'value-negative'}" style="font-weight: 700; font-size: 1.1em;">
                                    $${position.position_balance_gain_loss_usd.toFixed(2)} (${position.position_balance_gain_loss_percentage.toFixed(2)}%)
                                </span>
                            </div>
                        </div>
                    </div>
                    <div class="card-section">
                        <h3 class="section-title">Position Details (#${position.token_id})</h3>
                        <div class="metric">
                            <span class="metric-label">Current Price</span>
                            <span class="metric-value-details">${position.current_price}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Initial Price</span>
                            <span class="metric-value-details">${position.initial_state.price}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Current Value</span>
                            <span class="metric-value-details">${position.estimated_value_usd}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Initial Value</span>
                            <span class="metric-value-details">${position.initial_state.usd_value}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label" style="font-weight: 500; font-size: 0.9em;">Current Balances</span>
                            <span class="metric-value-details" style="font-weight: 600; color: var(--color-text-primary); font-size: 1em;">${position.current_balances.replace(' & ', '<br>')}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label" style="font-weight: 500; font-size: 0.9em;">Initial Balances</span>
                            <span class="metric-value-details" style="font-weight: 600; color: var(--color-text-primary); font-size: 1em;">${position.initial_state.balances.replace(' & ', '<br>')}</span>
                        </div>
                        <div class="metric">
                            <span class="metric-label">Creation Date</span>
                            <span class="metric-value-details">${position.initial_state.date}</span>
                        </div>
                    </div>
                </div>
            `;
            positionsContainer.appendChild(card);
        });
    }

    function getBreakevenColorClass(percentage) {
        if (percentage === -1) return ''; // For 'Met' or N/A
        if (percentage > 75) return 'breakeven-red';
        if (percentage > 40) return 'breakeven-orange';
        if (percentage > 10) return 'breakeven-yellow';
        return 'breakeven-green';
    }

    // Event Listeners
    saveWalletBtn.addEventListener('click', () => {
        const address = walletAddressInput.value.trim();
        if (address) {
            localStorage.setItem(WALLET_STORAGE_KEY, address);
            updateWalletUI();
        } else {
            alert('Please enter a valid wallet address.');
        }
    });

    removeWalletBtn.addEventListener('click', () => {
        localStorage.removeItem(WALLET_STORAGE_KEY);
        updateWalletUI();
    });

    function formatWalletAddress(address) {
        if (window.innerWidth <= 768) { // Mobile view
            return `...${address.substring(address.length - 4)}`;
        } else { // Desktop view
            if (address.length <= 10) {
                return address; // Return as is if too short to format
            }
            return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
        }
    }

    // Initial UI update on page load
    updateWalletUI();
});