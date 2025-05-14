import fetch from 'node-fetch';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createObjectCsvWriter } from 'csv-writer';
import chalk from 'chalk';
import ora from 'ora';
import natural from 'natural';
import cliProgress from 'cli-progress';
import readline from 'readline';
import pMap from 'p-map';
import { fetchAllThreads } from './lib/fetchAllThreads.js';
import { fetchAllComments } from './lib/fetchAllComments.js';

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

const {
  REDDIT_CLIENT_ID,
  REDDIT_CLIENT_SECRET,
  REDDIT_USER_AGENT,
  REDDIT_USERNAME,
  REDDIT_PASSWORD
} = process.env;

if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET || !REDDIT_USER_AGENT || !REDDIT_USERNAME || !REDDIT_PASSWORD) {
  console.error(chalk.red.bold('Missing Reddit API credentials in .env file.'));
  process.exit(1);
}

// Helper: Wait for ms milliseconds
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: Fetch with rate limit (429) and quota handling, plus throttling
async function fetchWithRateLimit(url, options, maxRetries = 5, baseDelay = 2000) {
  let attempt = 0;
  let delay = baseDelay;
  while (attempt <= maxRetries) {
    const response = await fetch(url, options);
    // Throttle based on quota
    const remaining = parseFloat(response.headers.get('x-ratelimit-remaining'));
    let throttle = minDelay;
    if (!isNaN(remaining) && remaining < 10) {
      throttle = highDelay;
    }
    if (response.status !== 429) {
      // Clear any previous rate limit message
      if (attempt > 0) process.stdout.write('\r' + ' '.repeat(100) + '\r');
      // Wait before next request to avoid burning the quota
      await wait(throttle);
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

// Helper: Get OAuth2 token
async function getRedditToken() {
  const spinner = ora('Requesting Reddit OAuth2 token...').start();
  try {
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': REDDIT_USER_AGENT
      },
      body: new URLSearchParams({
        grant_type: 'password',
        username: REDDIT_USERNAME,
        password: REDDIT_PASSWORD,
        scope: 'read'
      })
    });
    if (!response.ok) {
      spinner.fail(chalk.red('Failed to get Reddit token.'));
      const errText = await response.text();
      throw new Error(`Token error: ${errText}`);
    }
    const data = await response.json();
    spinner.succeed(chalk.green('Reddit OAuth2 token acquired.'));
    return data.access_token;
  } catch (err) {
    spinner.fail(chalk.red('Error during token acquisition.'));
    throw err;
  }
}

function normalizeText(text) {
  if (!text) return '';
  const tokenizer = new natural.TreebankWordTokenizer();
  return tokenizer.tokenize(text.toLowerCase()).join(' ');
}

async function promptExportFormat(configPath, config) {
  const defaultFormat = (config.options && config.options.exportFormat) || 'csv';
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  function ask() {
    return new Promise(resolve => {
      rl.question(chalk.yellow(`Choose export format [${defaultFormat}]: `), answer => {
        resolve(answer.trim().toLowerCase());
      });
    });
  }
  let format;
  while (true) {
    format = await ask();
    if (!format) format = defaultFormat;
    if (format === 'csv' || format === 'json') break;
    console.log(chalk.red('Invalid input. Please type "csv" or "json".'));
  }
  rl.close();
  config.options = config.options || {};
  config.options.exportFormat = format;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(chalk.green(`Export format set to '${format}' and saved in config.json.`));
  return format;
}

function formatEta(eta) {
  if (!Number.isFinite(eta) || eta <= 0) return '00:00:00';
  const h = Math.floor(eta / 3600);
  const m = Math.floor((eta % 3600) / 60);
  const s = Math.floor(eta % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function printStatusLine({subreddit, threadIdx, threadTotal, eta, commentCount}) {
  const etaStr = formatEta(eta);
  let msg = `Currently: r/${subreddit} | Thread ${threadIdx}/${threadTotal} | ETA: ${etaStr}`;
  if (typeof commentCount === 'number') {
    msg += ` | Comments: ${commentCount}`;
  }
  process.stdout.write('\n');
  process.stdout.write('\x1b[2K');
  process.stdout.write(msg);
  process.stdout.write('\x1b[1A');
}

async function main() {
  const startBanner = chalk.bold.bgRed.white(' OMEGA-RED REDDIT SCRAPER ');
  console.log('\n' + startBanner + '\n');
  const configPath = path.join(__dirname, '../config.json');
  const contentDir = path.join(__dirname, '../content');
  const threadsCsvPath = path.join(contentDir, 'threads.csv');
  const commentsCsvPath = path.join(contentDir, 'comments.csv');
  const threadsJsonPath = path.join(contentDir, 'threads.json');
  const commentsJsonPath = path.join(contentDir, 'comments.json');

  // Directory creation
  const dirSpinner = ora('Ensuring content directory exists...').start();
  try {
    await fs.mkdir(contentDir, { recursive: true });
    dirSpinner.succeed(chalk.green('Content directory ready.'));
  } catch (err) {
    dirSpinner.fail(chalk.red('Failed to create content directory.'));
    throw err;
  }

  // Read config and prompt for export format if needed
  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch (err) {
    console.error(chalk.red('Failed to read config.json:'), err.message);
    process.exit(1);
  }
  let exportFormat = await promptExportFormat(configPath, config);
  const maxParallelThreads = (config.options && config.options.maxParallelThreads) || 5;
  const throttleConfig = (config.options && config.options.throttle) || {};
  const minDelay = throttleConfig.minDelayMs || 1000;
  const highDelay = throttleConfig.highDelayMs || 3000;

  // CSV Writers (only if needed)
  let threadsWriter, commentsWriter;
  if (exportFormat === 'csv') {
    threadsWriter = createObjectCsvWriter({
      path: threadsCsvPath,
      header: [
        {id: 'text', title: 'text'},
        {id: 'title', title: 'title'},
        {id: 'url', title: 'url'},
        {id: 'id', title: 'id'},
        {id: 'subreddit', title: 'subreddit'},
        {id: 'meta', title: 'meta'},
        {id: 'time', title: 'time'},
        {id: 'author', title: 'author'},
        {id: 'ups', title: 'ups'},
        {id: 'downs', title: 'downs'},
        {id: 'authorlinkkarma', title: 'authorlinkkarma'},
        {id: 'authorcommentkarma', title: 'authorcommentkarma'},
        {id: 'authorisgold', title: 'authorisgold'}
      ]
    });
    commentsWriter = createObjectCsvWriter({
      path: commentsCsvPath,
      header: [
        {id: 'text', title: 'text'},
        {id: 'id', title: 'id'},
        {id: 'subreddit', title: 'subreddit'},
        {id: 'meta', title: 'meta'},
        {id: 'time', title: 'time'},
        {id: 'author', title: 'author'},
        {id: 'ups', title: 'ups'},
        {id: 'downs', title: 'downs'},
        {id: 'authorlinkkarma', title: 'authorlinkkarma'},
        {id: 'authorcommentkarma', title: 'authorcommentkarma'},
        {id: 'authorisgold', title: 'authorisgold'}
      ]
    });
    await threadsWriter.writeRecords([]);
    await commentsWriter.writeRecords([]);
  }

  // Token acquisition
  let token;
  try {
    token = await getRedditToken();
  } catch (err) {
    console.error(chalk.red('Fatal error during token acquisition:'), err.message);
    process.exit(1);
  }

  // Scraping logic
  const subredditsConfig = config.subreddits;
  // Calculate total threads to scrape for global progress bar
  let totalThreads = 0;
  for (const meta of Object.keys(subredditsConfig)) {
    for (const subreddit of Object.keys(subredditsConfig[meta])) {
      totalThreads += subredditsConfig[meta][subreddit];
    }
  }
  const progressBar = new cliProgress.SingleBar({
    format: chalk.cyan('Global Progress') + ' |' + chalk.green('{bar}') + '| {percentage}% || {value}/{total} threads || ETA: {eta_formatted}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true
  });
  progressBar.start(totalThreads, 0);
  let threadsProcessed = 0;
  let lastCommentCount = null;

  // For JSON export, accumulate all data in arrays
  let allThreads = [];
  let allComments = [];

  for (const meta of Object.keys(subredditsConfig)) {
    for (const subreddit of Object.keys(subredditsConfig[meta])) {
      const count = subredditsConfig[meta][subreddit];
      let threads = [];
      try {
        threads = await fetchAllThreads(subreddit, meta, count, token, { minDelay, highDelay });
      } catch (err) {
        console.log(chalk.red(`Error fetching threads for r/${subreddit}: ${err.message}`));
        continue;
      }
      if (threads.length > 0) {
        if (exportFormat === 'csv') {
          await threadsWriter.writeRecords(threads);
        } else {
          allThreads.push(...threads);
        }
      }
      for (let i = 0; i < threads.length; i++) {
        threadsProcessed++;
        progressBar.update(threadsProcessed);
        printStatusLine({
          subreddit,
          threadIdx: i + 1,
          threadTotal: threads.length,
          eta: progressBar.eta,
          commentCount: lastCommentCount
        });
        // Fetch comments for this thread (in parallel, but we update status here for the main thread loop)
        // We'll update lastCommentCount after each thread's comments are fetched
      }
      // Parallelized fetch comments for each thread
      await pMap(
        threads,
        async (thread, idx) => {
          let comments = [];
          try {
            comments = await fetchAllComments(subreddit, meta, thread.id, token, { minDelay, highDelay });
            lastCommentCount = comments.length;
            printStatusLine({
              subreddit,
              threadIdx: idx + 1,
              threadTotal: threads.length,
              eta: progressBar.eta,
              commentCount: lastCommentCount
            });
            if (comments.length > 0) {
              if (exportFormat === 'csv') {
                await commentsWriter.writeRecords(comments);
              } else {
                allComments.push(...comments);
              }
            }
          } catch (err) {
            lastCommentCount = null;
            printStatusLine({
              subreddit,
              threadIdx: idx + 1,
              threadTotal: threads.length,
              eta: progressBar.eta,
              commentCount: lastCommentCount
            });
            console.log(chalk.red(`Error fetching comments for thread ${thread.id}: ${err.message}`));
          }
        },
        { concurrency: maxParallelThreads }
      );
    }
  }
  progressBar.stop();
  // Clear status line after progress bar
  process.stdout.write('\n\x1b[2K');

  // Write JSON output if needed
  if (exportFormat === 'json') {
    try {
      await fs.writeFile(threadsJsonPath, JSON.stringify(allThreads, null, 2));
      await fs.writeFile(commentsJsonPath, JSON.stringify(allComments, null, 2));
      console.log(chalk.green('Exported threads.json and comments.json in content/.'));
    } catch (err) {
      console.log(chalk.red('Failed to write JSON output.'));
      throw err;
    }
  }
  ora().succeed(chalk.bold.green('Scraping complete! All results saved in content/.'));
}

main().catch(err => {
  console.error(chalk.bgRed.white('Fatal error:'), chalk.red(err && err.stack ? err.stack : err));
  process.exit(1);
}); 