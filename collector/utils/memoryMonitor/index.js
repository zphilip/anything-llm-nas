/**
 * Memory monitoring utility for tracking Node.js process memory usage
 * Helps identify memory leaks and optimize resource usage
 */

const thresholds = {
  NORMAL: 300,
  WARNING: 500,
  HIGH: 750,
  CRITICAL: 1000
};

let isDebugEnabled = false;

/**
 * Enable or disable debug logging
 * @param {boolean} enable - Whether to enable debug logging
 */
function enableDebugLogging(enable = true) {
  isDebugEnabled = enable;
}

/**
 * Color code memory values based on thresholds
 * @param {number} value - Memory value in MB
 */
const colorCode = (value) => {
  if (value >= thresholds.CRITICAL) {
    return `\x1b[1;91m${value}MB\x1b[0m`; // Bright Red
  } else if (value >= thresholds.HIGH) {
    return `\x1b[1;31m${value}MB\x1b[0m`; // Dark Red
  } else if (value >= thresholds.WARNING) {
    return `\x1b[1;33m${value}MB\x1b[0m`; // Yellow
  } else if (value >= thresholds.NORMAL) {
    return `\x1b[1;32m${value}MB\x1b[0m`; // Green
  }
  return `\x1b[1;36m${value}MB\x1b[0m`; // Cyan for low values
};

/**
 * Log current memory usage with color coding
 * @param {string} label - Optional label to identify the logging point
 * @param {boolean} shouldLog - Override to force logging
 */
const logMemoryUsage = (label = '', shouldLog = isDebugEnabled) => {
  if (!shouldLog) return;
  
  const used = process.memoryUsage();
  const heapUsed = Math.round(used.heapUsed / 1024 / 1024);
  const heapTotal = Math.round(used.heapTotal / 1024 / 1024);
  const rss = Math.round(used.rss / 1024 / 1024);
  const external = Math.round(used.external / 1024 / 1024);
  const arrayBuffers = Math.round(used.arrayBuffers / 1024 / 1024);

  const heapUsagePercent = Math.round((heapUsed / heapTotal) * 100);
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS

  const headerText = label 
    ? `━━━ Memory Usage [${label}] ━━━` 
    : '━━━ Memory Usage Monitor ━━━';

  console.log(`\x1b[1;95m${headerText}\x1b[0m`); // Magenta header
  console.log(`\x1b[90m[${timestamp}]\x1b[0m`); // Gray timestamp
  console.log(`  - Heap Used:   ${colorCode(heapUsed)} (${heapUsagePercent}% of total)`);
  console.log(`  - Heap Total:  ${colorCode(heapTotal)}`);
  console.log(`  - RSS:         ${colorCode(rss)}`);
  console.log(`  - External:    ${colorCode(external)}`);
  console.log(`  - Buffers:     ${colorCode(arrayBuffers)}`);
  console.log(`\x1b[90m${'━'.repeat(40)}\x1b[0m\n`);
  
  // Warn if memory is high
  if (heapUsed >= thresholds.CRITICAL) {
    console.warn('\x1b[1;91m⚠ CRITICAL: Memory usage is very high! Consider garbage collection.\x1b[0m');
  } else if (heapUsed >= thresholds.HIGH) {
    console.warn('\x1b[1;33m⚠ WARNING: Memory usage is elevated.\x1b[0m');
  }
};

/**
 * Log memory usage and trigger garbage collection if available
 * @param {string} label - Optional label
 */
const logAndCollect = (label = '') => {
  logMemoryUsage(label, true);
  if (global.gc) {
    console.log('\x1b[36m♻ Running garbage collection...\x1b[0m');
    global.gc();
    setTimeout(() => {
      logMemoryUsage(label + ' (After GC)', true);
    }, 100);
  }
};

module.exports = {
  logMemoryUsage,
  logAndCollect,
  enableDebugLogging,
  thresholds
};
