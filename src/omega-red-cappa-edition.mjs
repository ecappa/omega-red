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
import { wait, padNumber, formatEta, formatElapsed, calculateEta, formatDate, mdEscape, promptYesNo } from './lib/helpers.js';
import { exportGroupToMarkdown } from './lib/export.js';

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

function getDateTimePrefix() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}`;
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
    if (format === 'csv' || format === 'json' || format === 'md') break;
    console.log(chalk.red('Invalid input. Please type "csv", "json" or "md".'));
  }
  rl.close();
  config.options = config.options || {};
  config.options.exportFormat = format;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(chalk.green(`Export format set to '${format}' and saved in config.json.`));
  return format;
}

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
  avgCommentTime,
  ratelimitInfo
}) {
  const elapsed = formatElapsed(startTime);
  const eta = formatEta(calculateEta(startTime, totalProcessed, totalWork));
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
  if (ratelimitInfo) {
    msg += chalk.yellow(' | ' + ratelimitInfo);
  }
  process.stdout.write('\n');
  process.stdout.write('\x1b[2K');
  process.stdout.write(msg);
  process.stdout.write('\x1b[1A');
}

async function main() {
  const startBanner = chalk.bold.bgRed.white(' OMEGA-RED-CAPPA-EDITION REDDIT SCRAPER ');
  console.log('\n' + startBanner + '\n');
  const configPath = path.join(__dirname, '../config.json');
  const contentDir = path.join(__dirname, '../content');
  const autosaveDir = path.join(contentDir, 'autosave');
  const datePrefix = getDateTimePrefix();

  const dirSpinner = ora('Ensuring content directories exist...').start();
  try {
    await fs.mkdir(contentDir, { recursive: true });
    await fs.mkdir(autosaveDir, { recursive: true });
    dirSpinner.succeed(chalk.green('Content directories ready.'));
  } catch (err) {
    dirSpinner.fail(chalk.red('Failed to create content directories.'));
    throw err;
  }

  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch (err) {
    console.error(chalk.red('Failed to read config.json:'), err.message);
    process.exit(1);
  }
  
  // Ensure default values for new options
  if (!config.options) config.options = {};
  if (!config.options.maxMarkdownSizeMB) config.options.maxMarkdownSizeMB = 1;
  
  let exportFormat = await promptExportFormat(configPath, config);
  const maxParallelThreads = (config.options && config.options.maxParallelThreads) || 5;
  const throttleConfig = (config.options && config.options.throttle) || {};
  const minDelay = throttleConfig.minDelayMs || 1000;
  const highDelay = throttleConfig.highDelayMs || 3000;
  const maxMarkdownSizeMB = (config.options && config.options.maxMarkdownSizeMB) || 1;

  let token;
  try {
    token = await getRedditToken();
  } catch (err) {
    console.error(chalk.red('Fatal error during token acquisition:'), err.message);
    process.exit(1);
  }

  const subredditsConfig = config.subreddits;
  const lastRunPath = path.join(__dirname, '../last_run.json');
  let lastRunTimestamp = 0;
  try {
    lastRunTimestamp = JSON.parse(await fs.readFile(lastRunPath, 'utf-8')).lastRun || 0;
  } catch {}
  let useSinceDate = false;
  if (lastRunTimestamp > 0) {
    const lastDate = new Date(lastRunTimestamp * 1000).toISOString().replace('T', ' ').substring(0, 19);
    useSinceDate = await promptYesNo(`Une précédente exécution a été détectée (dernier run : ${lastDate}). Voulez-vous ne prendre que les nouveaux threads/commentaires depuis cette date ?`, false);
  }

  for (const meta of Object.keys(subredditsConfig)) {
    const fileBase = `${datePrefix}-${meta}`;
    const threadsCsvPath = path.join(contentDir, `${fileBase}-threads.csv`);
    const commentsCsvPath = path.join(contentDir, `${fileBase}-comments.csv`);
    const threadsJsonPath = path.join(contentDir, `${fileBase}.json`);
    
    // Chemins pour les fichiers d'autosave
    const autosaveJsonPath = path.join(autosaveDir, `${fileBase}-autosave.json`);
    const autosaveThreadsCsvPath = path.join(autosaveDir, `${fileBase}-threads-autosave.csv`);
    const autosaveCommentsCsvPath = path.join(autosaveDir, `${fileBase}-comments-autosave.csv`);
    const autosaveMdPath = path.join(autosaveDir, `${fileBase}-autosave.md`);

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

    let totalThreads = 0;
    for (const subreddit of Object.keys(subredditsConfig[meta])) {
      totalThreads += subredditsConfig[meta][subreddit];
    }

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

    let autosaveTimer;
    let autosaveInterval = (config.options && config.options.autosaveIntervalSec) || 60;
    autosaveTimer = setInterval(async () => {
      try {
        const finalOutput = Object.values(jsonOutput);
        // Ne rien faire si aucune donnée n'est présente
        if (finalOutput.length === 0 || !finalOutput.some(group => group.posts && group.posts.length > 0)) {
          console.log(chalk.gray('[Autosave] Aucune donnée à sauvegarder (pas de posts).'));
          return;
        }

        // Autosave seulement dans le format choisi par l'utilisateur
        let autosaveMsg = '';
        
        if (exportFormat === 'json') {
          // Autosave JSON uniquement
          await fs.writeFile(autosaveJsonPath, JSON.stringify(finalOutput, null, 2));
          autosaveMsg = `JSON (${autosaveJsonPath})`;
        } 
        else if (exportFormat === 'csv') {
          // Autosave CSV uniquement
          const allThreads = finalOutput.flatMap(group => 
            group.posts && group.posts.length > 0 
              ? group.posts.map(post => ({
                  text: post.selftext || '',
                  title: post.title || '',
                  url: post.url || '',
                  id: post.id || '',
                  subreddit: group.subreddit || '',
                  meta,
                  time: post.created_utc || '',
                  author: post.author?.username || '',
                  ups: post.score || '',
                  downs: '',
                  authorlinkkarma: post.author?.karma || '',
                  authorcommentkarma: '',
                  authorisgold: ''
                }))
              : []
          );
          if (allThreads.length > 0) {
            const csvWriter = createObjectCsvWriter({
              path: autosaveThreadsCsvPath,
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
            await csvWriter.writeRecords(allThreads);
          }
          
          const allComments = finalOutput.flatMap(group => 
            group.posts 
              ? group.posts.flatMap(post => {
                  function flattenComments(comments) {
                    if (!comments || !comments.length) return [];
                    return comments.flatMap(c => [
                      {
                        text: c.body || '',
                        id: c.id || '',
                        subreddit: group.subreddit || '',
                        meta,
                        time: c.created_utc || '',
                        author: c.author?.username || '',
                        ups: c.score || '',
                        downs: '',
                        authorlinkkarma: c.author?.karma || '',
                        authorcommentkarma: '',
                        authorisgold: ''
                      },
                      ...(c.replies && c.replies.length ? flattenComments(c.replies) : [])
                    ]);
                  }
                  return post.comments ? flattenComments(post.comments) : [];
                })
              : []
          );
          if (allComments.length > 0) {
            const csvWriter = createObjectCsvWriter({
              path: autosaveCommentsCsvPath,
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
            await csvWriter.writeRecords(allComments);
          }
          autosaveMsg = `CSV (${autosaveThreadsCsvPath}, ${autosaveCommentsCsvPath})`;
        } 
        else if (exportFormat === 'md') {
          // Pour le format MD, nous avons toujours besoin de sauvegarder le JSON source
          await fs.writeFile(autosaveJsonPath, JSON.stringify(finalOutput, null, 2));
          
          // Puis générer le Markdown
          const { exportGroupToMarkdown } = await import('./lib/export.js');
          const mdFiles = await exportGroupToMarkdown(meta, jsonOutput, autosaveJsonPath, { 
            maxMarkdownSizeMB,
            isAutosave: true
          });
          
          autosaveMsg = `Markdown (${mdFiles.length} fichier${mdFiles.length > 1 ? 's' : ''})`;
        }
        
        console.log(chalk.gray(`\n[Autosave] Données sauvegardées au format ${autosaveMsg} dans content/autosave/`));
      } catch (e) {
        console.log(chalk.red('[Autosave] Erreur lors de la sauvegarde automatique :'), e.message);
      }
    }, autosaveInterval * 1000);

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

    for (const subreddit of Object.keys(subredditsConfig[meta])) {
      const count = subredditsConfig[meta][subreddit];
      let threadStartTime = Date.now();
      let threads = [];
      try {
        threads = await fetchAllThreads(subreddit, meta, count, token, { minDelay, highDelay });
        if (useSinceDate && lastRunTimestamp > 0) {
          threads = threads.filter(t => (t.time || t.created_utc || 0) > lastRunTimestamp);
        }
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
      if (!jsonOutput[subreddit]) {
        jsonOutput[subreddit] = {
          subreddit,
          posts: []
        };
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
          avgCommentTime,
          ratelimitInfo: thread.ratelimitInfo
        });
      }
      const threadComments = await pMap(
        threads,
        async (thread, idx) => {
          const threadCommentStart = Date.now();
          let comments = [];
          try {
            comments = await fetchAllComments(subreddit, meta, thread.id, token, { minDelay, highDelay });
            if (useSinceDate && lastRunTimestamp > 0) {
              comments = comments.filter(c => (c.time || c.created_utc || 0) > lastRunTimestamp);
            }
            lastCommentCount = comments.length;
            totalComments += comments.length;
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
              avgCommentTime,
              ratelimitInfo: comments[0]?.ratelimitInfo
            });
            if (exportFormat === 'csv' && comments.length > 0) {
              await commentsWriter.writeRecords(comments);
            }
            totalWork += comments.length;
            progressBar.setTotal(totalWork);
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
              avgCommentTime,
              ratelimitInfo: err.message
            });
            console.log(chalk.red(`Error fetching comments for thread ${thread.id}: ${err.message}`));
            return { thread, comments: [] };
          }
        },
        { concurrency: maxParallelThreads }
      );
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
    progressBar.stop();
    process.stdout.write('\n\x1b[2K');
    const totalTime = (Date.now() - startTime) / 1000;
    console.log(chalk.cyan(`\nScraping for group '${meta}' completed in ${formatEta(totalTime)}`));
    console.log(chalk.yellow(`Total threads: ${threadsProcessed}`));
    console.log(chalk.magenta(`Total comments: ${totalComments}`));
    console.log(chalk.gray(`Average time per thread: ${avgThreadTime.toFixed(2)}s`));
    console.log(chalk.gray(`Average time per comment: ${avgCommentTime.toFixed(2)}s`));

    const finalOutput = Object.values(jsonOutput);
    const hasData = finalOutput.length > 0 && finalOutput.some(group => group.posts && group.posts.length > 0);
    
    if (hasData) {
      if (exportFormat === 'json' || exportFormat === 'md') {
        try {
          await fs.writeFile(threadsJsonPath, JSON.stringify(finalOutput, null, 2));
          await fs.writeFile(autosaveJsonPath, JSON.stringify(finalOutput, null, 2));
          console.log(chalk.green(`Exported JSON data to ${threadsJsonPath}`));
          if (exportFormat === 'md') {
            const { exportGroupToMarkdown } = await import('./lib/export.js');
            const mdFiles = await exportGroupToMarkdown(meta, jsonOutput, threadsJsonPath, { 
              maxMarkdownSizeMB,
              isAutosave: false
            });
            if (mdFiles.length > 1) {
              console.log(chalk.green(`Markdown data was split into ${mdFiles.length} files due to size limits.`));
            }
          }
        } catch (err) {
          console.log(chalk.red('Failed to write JSON/Markdown output.'));
          throw err;
        }
      } else if (exportFormat === 'csv') {
        console.log(chalk.green(`Exported threads and comments to CSV files: ${threadsCsvPath}, ${commentsCsvPath}`));
      }
      ora().succeed(chalk.bold.green(`Scraping complete for group '${meta}'! Results saved in content/`));
    } else {
      console.log(chalk.yellow(`No data found or filtered for group '${meta}'. No files written.`));
      ora().warn(chalk.bold.yellow(`Scraping complete for group '${meta}' but no data was found or all data was filtered out.`));
    }
    
    if (autosaveTimer) clearInterval(autosaveTimer);
  }
  await fs.writeFile(lastRunPath, JSON.stringify({ lastRun: Math.floor(Date.now() / 1000) }));
}

process.on('SIGINT', async () => {
  console.log(chalk.red('\nInterruption détectée, sauvegarde en cours...'));
  process.exit(1);
});

main().catch(err => {
  console.error(chalk.bgRed.white('Fatal error:'), chalk.red(err && err.stack ? err.stack : err));
  process.exit(1);
}); 