import fetch from 'node-fetch';
import chalk from 'chalk';

// Fetch with rate limit for Omega-Red-Cappa-Edition
export async function fetchWithRateLimit(url, options, { maxRetries = 5, baseDelay = 2000, minDelay = 1000, highDelay = 3000 } = {}) {
  let attempt = 0;
  let delay = baseDelay;
  while (attempt <= maxRetries) {
    const response = await fetch(url, options);
    // Throttle based on quota
    const remaining = parseFloat(response.headers.get('x-ratelimit-remaining'));
    const reset = parseFloat(response.headers.get('x-ratelimit-reset'));
    let throttle = minDelay;
    let dynamic = false;
    if (!isNaN(remaining) && !isNaN(reset) && remaining > 0) {
      // Calcule le délai optimal pour ne pas dépasser la limite
      throttle = Math.max(minDelay, Math.ceil((reset * 1000) / remaining));
      dynamic = true;
      if (remaining < 3) {
        throttle = Math.max(throttle, 10000); // 10s si on est vraiment limite
      } else if (remaining < 10) {
        throttle = Math.max(throttle, highDelay);
      }
      console.log(chalk.gray(`[ratelimit] Remaining: ${remaining}, Reset in: ${reset}s, Throttle: ${throttle}ms`));
    } else if (!isNaN(remaining) && remaining < 10) {
      throttle = highDelay;
      console.log(chalk.gray(`[ratelimit] Remaining: ${remaining}, Throttle: ${throttle}ms`));
    }
    if (response.status !== 429) {
      // Clear any previous rate limit message
      if (attempt > 0) process.stdout.write('\r' + ' '.repeat(100) + '\r');
      // Wait before next request to avoid burning the quota
      await new Promise(res => setTimeout(res, throttle));
      return response;
    }
    // 429 Too Many Requests
    let remainingMs = delay;
    const explanation = chalk.yellowBright('Rate limited by Reddit API (HTTP 429). This means you have sent too many requests in a short period. Waiting before retrying...');
    const interval = 200;
    await new Promise(resolve => {
      const timer = setInterval(() => {
        process.stdout.write(`\r${explanation} Retrying in ${remainingMs} ms...   `);
        remainingMs -= interval;
        if (remainingMs <= 0) {
          clearInterval(timer);
          process.stdout.write('\r' + ' '.repeat(120) + '\r');
          resolve();
        }
      }, interval);
    });
    delay *= 2; // Exponential backoff
    attempt++;
  }
  // Clear the line before throwing
  process.stdout.write('\r' + ' '.repeat(120) + '\r');
  throw new Error('Exceeded maximum retries due to Reddit API rate limiting (HTTP 429).');
} 