/**
 * Meteora DLMM Bin <-> Price utilities for monke.army
 * 
 * DLMM uses discrete bins where each bin represents a price point.
 * The bin step determines the price increment between bins.
 * 
 * Formula: price(binId) = (1 + binStep/10000)^binId
 * 
 * Common bin steps:
 *   - 1   = 0.01% per bin (very tight, stablecoins)
 *   - 10  = 0.1% per bin (tight spreads)
 *   - 25  = 0.25% per bin
 *   - 50  = 0.5% per bin
 *   - 100 = 1% per bin (volatile pairs)
 */

/**
 * Convert bin ID to price
 * @param {number} binId - The bin ID (can be negative)
 * @param {number} binStep - Pool's bin step (e.g., 10 for 0.1%)
 * @returns {number} Price at this bin
 */
export function binToPrice(binId, binStep) {
  const binStepFactor = 1 + binStep / 10000;
  return Math.pow(binStepFactor, binId);
}

/**
 * Convert price to bin ID
 * @param {number} price - Target price
 * @param {number} binStep - Pool's bin step
 * @param {boolean} roundDown - Round down if true, up if false
 * @returns {number} Bin ID
 */
export function priceToBin(price, binStep, roundDown = true) {
  if (price <= 0) throw new Error(`Invalid price: ${price}`);
  
  const binStepFactor = 1 + binStep / 10000;
  const binId = Math.log(price) / Math.log(binStepFactor);
  
  return roundDown ? Math.floor(binId) : Math.ceil(binId);
}

/**
 * Get the price increment per bin (as a percentage)
 * @param {number} binStep - Pool's bin step
 * @returns {number} Percentage increment (e.g., 0.1 for binStep=10)
 */
export function getBinStepPercent(binStep) {
  return binStep / 100;
}

/**
 * Calculate how many bins between two prices
 * @param {number} priceA 
 * @param {number} priceB 
 * @param {number} binStep 
 * @returns {number} Number of bins
 */
export function getBinsBetweenPrices(priceA, priceB, binStep) {
  const binA = priceToBin(priceA, binStep);
  const binB = priceToBin(priceB, binStep);
  return Math.abs(binB - binA);
}

// ============ SLIDER UTILITIES ============

/**
 * Convert slider position (0-100%) to bin ID within a range
 * @param {number} sliderPercent - 0-100
 * @param {number} minBin - Minimum bin ID (furthest from active)
 * @param {number} maxBin - Maximum bin ID (closest to active)
 * @returns {number} Bin ID
 */
export function sliderToBin(sliderPercent, minBin, maxBin) {
  const range = maxBin - minBin;
  return Math.round(minBin + range * (sliderPercent / 100));
}

/**
 * Convert bin ID to slider position (0-100%)
 * @param {number} binId 
 * @param {number} minBin 
 * @param {number} maxBin 
 * @returns {number} Slider percent 0-100
 */
export function binToSlider(binId, minBin, maxBin) {
  const range = maxBin - minBin;
  if (range === 0) return 50;
  return ((binId - minBin) / range) * 100;
}

/**
 * Convert slider position (0-100%) to price within range
 * Uses log scale for better UX on volatile pairs
 * @param {number} sliderPercent - 0-100
 * @param {number} minPrice 
 * @param {number} maxPrice 
 * @param {boolean} logScale - Use logarithmic scale (default true)
 * @returns {number} Price
 */
export function sliderToPrice(sliderPercent, minPrice, maxPrice, logScale = true) {
  if (!logScale) {
    return minPrice + (maxPrice - minPrice) * (sliderPercent / 100);
  }
  
  // Log scale: better for prices that vary by orders of magnitude
  // Clamp minPrice to avoid -Infinity from Math.log(0)
  const safeMin = Math.max(minPrice, 1e-18);
  const logMin = Math.log(safeMin);
  const logMax = Math.log(maxPrice);
  const logPrice = logMin + (logMax - logMin) * (sliderPercent / 100);
  return Math.exp(logPrice);
}

/**
 * Convert price to slider position (0-100%)
 * @param {number} price 
 * @param {number} minPrice 
 * @param {number} maxPrice 
 * @param {boolean} logScale 
 * @returns {number} Slider percent 0-100
 */
export function priceToSlider(price, minPrice, maxPrice, logScale = true) {
  if (!logScale) {
    const range = maxPrice - minPrice;
    if (range === 0) return 50;
    return ((price - minPrice) / range) * 100;
  }
  
  // Clamp inputs to avoid Math.log(0) = -Infinity / NaN
  const safePrice = Math.max(price, 1e-18);
  const safeMin = Math.max(minPrice, 1e-18);
  const safeMax = Math.max(maxPrice, 1e-18);
  const logMin = Math.log(safeMin);
  const logMax = Math.log(safeMax);
  if (logMax === logMin) return 50;
  const logPrice = Math.log(safePrice);
  return ((logPrice - logMin) / (logMax - logMin)) * 100;
}

// ============ RANGE UTILITIES ============

/**
 * Get default bin range for buy/sell based on current price
 * @param {number} activeBinId - Current active bin
 * @param {number} numBins - Number of bins to span (default 20)
 * @param {'buy'|'sell'} side 
 * @returns {{ minBin: number, maxBin: number }}
 */
export function getDefaultBinRange(activeBinId, numBins = 20, side) {
  if (side === 'buy') {
    // Buy bins are BELOW current price
    return {
      minBin: activeBinId - numBins,  // Furthest from current (lowest price)
      maxBin: activeBinId - 1,         // Closest to current (but still below)
    };
  } else {
    // Sell bins are ABOVE current price
    return {
      minBin: activeBinId + 1,         // Closest to current (but still above)
      maxBin: activeBinId + numBins,   // Furthest from current (highest price)
    };
  }
}

/**
 * Get price range bounds from active bin
 * @param {number} activeBinId 
 * @param {number} binStep 
 * @param {number} rangePercent - How far from current price (default 50%)
 * @returns {{ min: number, max: number, minBin: number, maxBin: number }}
 */
export function getPriceRange(activeBinId, binStep, rangePercent = 50) {
  const currentPrice = binToPrice(activeBinId, binStep);
  const minPrice = currentPrice * (1 - rangePercent / 100);
  const maxPrice = currentPrice * (1 + rangePercent / 100);
  
  return {
    min: minPrice,
    max: maxPrice,
    minBin: priceToBin(minPrice, binStep, true),
    maxBin: priceToBin(maxPrice, binStep, false),
    currentPrice,
  };
}

// ============ VALIDATION ============

/**
 * Validate buy range (must be below current price)
 * @param {number} minBin 
 * @param {number} maxBin 
 * @param {number} activeBin 
 * @returns {boolean}
 */
export function validateBuyRange(minBin, maxBin, activeBin) {
  if (minBin > maxBin) {
    throw new Error('minBin must be <= maxBin');
  }
  if (maxBin >= activeBin) {
    throw new Error(`Buy range must be below current price (maxBin=${maxBin} >= activeBin=${activeBin})`);
  }
  return true;
}

/**
 * Validate sell range (must be above current price)
 * @param {number} minBin 
 * @param {number} maxBin 
 * @param {number} activeBin 
 * @returns {boolean}
 */
export function validateSellRange(minBin, maxBin, activeBin) {
  if (minBin > maxBin) {
    throw new Error('minBin must be <= maxBin');
  }
  if (minBin <= activeBin) {
    throw new Error(`Sell range must be above current price (minBin=${minBin} <= activeBin=${activeBin})`);
  }
  return true;
}

// ============ DISPLAY UTILITIES ============

/**
 * Format price for display
 * @param {number} price 
 * @param {number} decimals 
 * @returns {string}
 */
export function formatPrice(price, decimals = 6) {
  if (price >= 1000) {
    return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  } else if (price >= 1) {
    return price.toFixed(Math.min(decimals, 4));
  } else if (price >= 0.0001) {
    return price.toFixed(decimals);
  } else {
    return price.toExponential(2);
  }
}

/**
 * Format bin range for display
 * @param {number} minBin 
 * @param {number} maxBin 
 * @param {number} binStep 
 * @returns {string}
 */
export function formatBinRange(minBin, maxBin, binStep) {
  const minPrice = binToPrice(minBin, binStep);
  const maxPrice = binToPrice(maxBin, binStep);
  const numBins = maxBin - minBin + 1;
  
  return `${formatPrice(minPrice)} → ${formatPrice(maxPrice)} (${numBins} bins)`;
}

/**
 * Calculate expected fill price (average of bin range)
 * @param {number} minBin 
 * @param {number} maxBin 
 * @param {number} binStep 
 * @returns {number}
 */
export function getExpectedFillPrice(minBin, maxBin, binStep) {
  // Geometric mean is more accurate for log-spaced bins
  const minPrice = binToPrice(minBin, binStep);
  const maxPrice = binToPrice(maxBin, binStep);
  return Math.sqrt(minPrice * maxPrice);
}

/**
 * Calculate slippage from current price to fill range
 * @param {number} activeBinId 
 * @param {number} minBin 
 * @param {number} maxBin 
 * @param {number} binStep 
 * @param {'buy'|'sell'} side 
 * @returns {number} Slippage as percentage (positive means favorable)
 */
export function calculateSlippage(activeBinId, minBin, maxBin, binStep, side) {
  const currentPrice = binToPrice(activeBinId, binStep);
  const fillPrice = getExpectedFillPrice(minBin, maxBin, binStep);
  
  if (side === 'buy') {
    // For buys, lower fill price is better
    return ((currentPrice - fillPrice) / currentPrice) * 100;
  } else {
    // For sells, higher fill price is better
    return ((fillPrice - currentPrice) / currentPrice) * 100;
  }
}
