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

// Helper function to format time for display
function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// Helper function to get elapsed time
function formatElapsed(startTime) {
  const elapsed = (Date.now() - startTime) / 1000;
  return formatEta(elapsed);
}

// Calculate ETA based on elapsed time, completed work and remaining work
function calculateEta(startTime, completed, total) {
  if (completed <= 0) return 0;
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = elapsed / completed;
  const remaining = Math.max(0, total - completed);
  return rate * remaining;
}

// Helper: Pad number with leading zeros to desired length
function padNumber(num, length = 4) {
  return String(num).padStart(length, '0');
}

// Print status on a single line without scrolling
function printStatusLine({
  startTime,
  subreddit,
  threadIdx,
  threadTotal,
  totalProcessed,
  totalWork,
  avgThreadTime,
  commentCount,
  totalComments,
  avgCommentTime
}) {
  // Calculate elapsed and ETA
  const elapsed = formatElapsed(startTime);
  const eta = formatEta(calculateEta(startTime, totalProcessed, totalWork));
  
  // Format and colorize the status
  let msg = chalk.cyan(`Time: ${elapsed} | ETA: ${eta} | `);
  msg += chalk.yellow(`Progress: ${padNumber(totalProcessed)}/${padNumber(totalWork)} (${Math.round(totalProcessed/totalWork*100)}%) | `);
  
  if (subreddit) {
    msg += chalk.green(`r/${subreddit}: ${padNumber(threadIdx)}/${padNumber(threadTotal)} | `);
  }
  
  if (avgThreadTime) {
    msg += chalk.gray(`Avg Thread: ${avgThreadTime.toFixed(2)}s | `);
  }
  
  if (typeof commentCount === 'number') {
    msg += chalk.magenta(`Comments: ${padNumber(commentCount)} | `);
  }
  
  if (totalComments > 0) {
    msg += chalk.blue(`Total Comments: ${padNumber(totalComments)} | `);
  }
  
  if (avgCommentTime) {
    msg += chalk.gray(`Avg Comment: ${avgCommentTime.toFixed(2)}s`);
  }
  
  // Write the status line without scrolling
  process.stdout.write('\n'); // Move to next line
  process.stdout.write('\x1b[2K'); // Clear line
  process.stdout.write(msg); // Write status
  process.stdout.write('\x1b[1A'); // Move cursor back up
}

// Helper: Get current date/time as yyyymmdd-hhmm
function getDateTimePrefix() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}`;
}

async function main() {
  const startBanner = chalk.bold.bgRed.white(' OMEGA-RED REDDIT SCRAPER ');
  console.log('\n' + startBanner + '\n');
  const configPath = path.join(__dirname, '../config.json');
  const contentDir = path.join(__dirname, '../content');
  const datePrefix = getDateTimePrefix();

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

  // Token acquisition
  let token;
  try {
    token = await getRedditToken();
  } catch (err) {
    console.error(chalk.red('Fatal error during token acquisition:'), err.message);
    process.exit(1);
  }

  const subredditsConfig = config.subreddits;
  // Pour chaque groupe (meta)
  for (const meta of Object.keys(subredditsConfig)) {
    // Prépare le nom de fichier
    const fileBase = `${datePrefix}-${meta}`;
    const threadsCsvPath = path.join(contentDir, `${fileBase}-threads.csv`);
    const commentsCsvPath = path.join(contentDir, `${fileBase}-comments.csv`);
    const threadsJsonPath = path.join(contentDir, `${fileBase}.json`);

    // Prépare les writers si CSV
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

    // Calcul du nombre total de threads pour ce groupe
    let totalThreads = 0;
    for (const subreddit of Object.keys(subredditsConfig[meta])) {
      totalThreads += subredditsConfig[meta][subreddit];
    }

    // Initialisation des compteurs et structures
    const startTime = Date.now();
    let threadsProcessed = 0;
    let commentsProcessed = 0;
    let totalComments = 0;
    let totalWork = totalThreads;
    let totalProcessed = 0;
    let lastCommentCount = null;
    const threadTimes = [];
    const commentTimes = [];
    let avgThreadTime = 0;
    let avgCommentTime = 0;
    let estimatedTotalThreads = totalThreads;
    let jsonOutput = {};

    // Progress bar
    const progressBar = new cliProgress.SingleBar({
      format: chalk.bold.white('Progress') + ' |' + chalk.green('{bar}') + '| {percentage}% || {value}/{total} items',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true,
      clearOnComplete: false
    });
    progressBar.start(totalWork, 0);
    printStatusLine({
      startTime,
      totalProcessed: 0,
      totalWork,
      totalComments: 0
    });
    const AVG_COMMENTS_PER_THREAD = 5;

    // Boucle sur les subreddits du groupe
    for (const subreddit of Object.keys(subredditsConfig[meta])) {
      const count = subredditsConfig[meta][subreddit];
      let threadStartTime = Date.now();
      let threads = [];
      try {
        threads = await fetchAllThreads(subreddit, meta, count, token, { minDelay, highDelay });
      } catch (err) {
        console.log(chalk.red(`Error fetching threads for r/${subreddit}: ${err.message}`));
        continue;
      }
      if (threads.length < count) {
        const difference = count - threads.length;
        estimatedTotalThreads -= difference;
        totalWork -= difference;
        progressBar.setTotal(totalWork);
      }
      totalWork += threads.length * AVG_COMMENTS_PER_THREAD;
      progressBar.setTotal(totalWork);
      if (exportFormat === 'json') {
        if (!jsonOutput[subreddit]) {
          jsonOutput[subreddit] = {
            subreddit,
            posts: []
          };
        }
      }
      if (exportFormat === 'csv' && threads.length > 0) {
        await threadsWriter.writeRecords(threads);
      }
      const threadTime = (Date.now() - threadStartTime) / 1000 / Math.max(1, threads.length);
      threadTimes.push(threadTime);
      if (threadTimes.length > 5) threadTimes.shift();
      avgThreadTime = threadTimes.reduce((a, b) => a + b, 0) / threadTimes.length;
      for (let i = 0; i < threads.length; i++) {
        const thread = threads[i];
        threadsProcessed++;
        totalProcessed++;
        progressBar.update(totalProcessed);
        printStatusLine({
          startTime,
          subreddit,
          threadIdx: i + 1,
          threadTotal: threads.length,
          totalProcessed,
          totalWork,
          avgThreadTime,
          commentCount: lastCommentCount,
          totalComments,
          avgCommentTime
        });
      }
      const threadComments = await pMap(
        threads,
        async (thread, idx) => {
          const threadCommentStart = Date.now();
          let comments = [];
          try {
            comments = await fetchAllComments(subreddit, meta, thread.id, token, { minDelay, highDelay });
            lastCommentCount = comments.length;
            totalComments += comments.length;
            if (idx === threads.length - 1 && totalComments > 0 && threadsProcessed > 0) {
              const newAvg = Math.max(1, Math.round(totalComments / threadsProcessed));
              if (Math.abs(newAvg - AVG_COMMENTS_PER_THREAD) > 1) {
                const remainingThreads = estimatedTotalThreads - threadsProcessed;
                const adjustmentToWork = remainingThreads * (newAvg - AVG_COMMENTS_PER_THREAD);
                totalWork += adjustmentToWork;
                progressBar.setTotal(totalWork);
                AVG_COMMENTS_PER_THREAD = newAvg;
              }
            }
            const commentTime = (Date.now() - threadCommentStart) / 1000 / Math.max(1, comments.length);
            commentTimes.push(commentTime);
            if (commentTimes.length > 10) commentTimes.shift();
            avgCommentTime = commentTimes.reduce((a, b) => a + b, 0) / commentTimes.length;
            comments.forEach(() => {
              commentsProcessed++;
              totalProcessed++;
              progressBar.update(totalProcessed);
            });
            printStatusLine({
              startTime,
              subreddit,
              threadIdx: idx + 1,
              threadTotal: threads.length,
              totalProcessed,
              totalWork,
              avgThreadTime,
              commentCount: lastCommentCount,
              totalComments,
              avgCommentTime
            });
            if (exportFormat === 'csv' && comments.length > 0) {
              await commentsWriter.writeRecords(comments);
            }
            return { thread, comments };
          } catch (err) {
            lastCommentCount = null;
            printStatusLine({
              startTime,
              subreddit,
              threadIdx: idx + 1,
              threadTotal: threads.length,
              totalProcessed,
              totalWork,
              avgThreadTime,
              commentCount: lastCommentCount,
              totalComments,
              avgCommentTime
            });
            console.log(chalk.red(`Error fetching comments for thread ${thread.id}: ${err.message}`));
            return { thread, comments: [] };
          }
        },
        { concurrency: maxParallelThreads }
      );
      if (exportFormat === 'json') {
        threadComments.forEach(({ thread, comments }) => {
          const commentsMap = new Map();
          const topLevelComments = [];
          comments.forEach(comment => {
            const authorObject = {
              username: comment.author || '[deleted]',
              karma: comment.authorlinkkarma || 0,
              is_mod: false,
              created_utc: 0
            };
            const commentObject = {
              id: comment.id,
              parent_id: null,
              author: authorObject,
              created_utc: comment.time || 0,
              score: comment.ups || 0,
              body: comment.text || '',
              replies: []
            };
            commentsMap.set(comment.id, commentObject);
          });
          comments.forEach(comment => {
            const commentObj = commentsMap.get(comment.id);
            if (!commentObj) return;
            if (comment.parent_id && commentsMap.has(comment.parent_id)) {
              const parent = commentsMap.get(comment.parent_id);
              commentObj.parent_id = comment.parent_id;
              parent.replies.push(commentObj);
            } else {
              commentObj.parent_id = thread.id;
              topLevelComments.push(commentObj);
            }
          });
          const threadAuthor = {
            username: thread.author || '[deleted]',
            karma: thread.authorlinkkarma || 0,
            is_mod: false,
            created_utc: 0
          };
          const threadObject = {
            id: thread.id,
            title: thread.title || '',
            author: threadAuthor,
            created_utc: thread.time || 0,
            score: thread.ups || 0,
            num_comments: topLevelComments.length,
            permalink: `/r/${thread.subreddit}/comments/${thread.id}/`,
            url: thread.url || `https://www.reddit.com/r/${thread.subreddit}/comments/${thread.id}/`,
            selftext: thread.text || '',
            comments: topLevelComments
          };
          jsonOutput[subreddit].posts.push(threadObject);
        });
      }
    }
    progressBar.stop();
    process.stdout.write('\n\x1b[2K');
    const totalTime = (Date.now() - startTime) / 1000;
    console.log(chalk.cyan(`\nScraping for group '${meta}' completed in ${formatEta(totalTime)}`));
    console.log(chalk.yellow(`Total threads: ${threadsProcessed}`));
    console.log(chalk.magenta(`Total comments: ${totalComments}`));
    console.log(chalk.gray(`Average time per thread: ${avgThreadTime.toFixed(2)}s`));
    console.log(chalk.gray(`Average time per comment: ${avgCommentTime.toFixed(2)}s`));
    if (exportFormat === 'json') {
      try {
        const finalOutput = Object.values(jsonOutput);
        await fs.writeFile(threadsJsonPath, JSON.stringify(finalOutput, null, 2));
        console.log(chalk.green(`Exported JSON data to ${threadsJsonPath}`));
      } catch (err) {
        console.log(chalk.red('Failed to write JSON output.'));
        throw err;
      }
    } else {
      console.log(chalk.green(`Exported threads and comments to CSV files: ${threadsCsvPath}, ${commentsCsvPath}`));
    }
    ora().succeed(chalk.bold.green(`Scraping complete for group '${meta}'! Results saved in content/`));
  }
}

main().catch(err => {
  console.error(chalk.bgRed.white('Fatal error:'), chalk.red(err && err.stack ? err.stack : err));
  process.exit(1);
}); 