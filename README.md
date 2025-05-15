# Omega-Red-Cappa-Edition

> **Omega-Red-Cappa-Edition** is a modern, modular, high-performance Reddit scraper for researchers, data scientists, and developers. It supports advanced export, incremental scraping, robust error handling, and is highly configurable.

---

## 🛠️ Features & Capabilities

- **Configurable Subreddit Groups**: Organize subreddits into named groups ("metareddits") for batch scraping.
- **Customizable Thread Limits**: Specify how many threads to scrape per subreddit.
- **Multiple Export Formats**: Output data as CSV (flat), JSON (hierarchical), or Markdown (readable, nested, shareable).
- **Incremental Scraping**: Optionally fetch only new threads/comments since the last run (with prompt and timestamp tracking).
- **Autosave & Crash Recovery**: Periodically saves progress to autosave files (interval configurable), so you never lose more than a few seconds/minutes of work.
- **Handles Reddit Rate Limiting**: Smart, dynamic throttling based on Reddit API headers (`x-ratelimit-remaining`, `x-ratelimit-reset`), with exponential backoff and clear logging.
- **Parallelization**: Configurable concurrency for faster scraping, with safe limits to avoid bans.
- **Text Normalization**: All text is lowercased and tokenized for consistency (TreebankTokenizer).
- **User-Friendly CLI**: Colored output, progress bar, ETA, and real-time status line.
- **Prompted Configuration**: Prompts for export format and incremental scraping at launch if not set.
- **Per-Group Output**: Files are generated per group, with timestamped filenames for easy archiving.
- **Modular Codebase**: Helpers, exporters, and fetchers are separated for maintainability and extensibility.
- **Safe Interruption**: On Ctrl+C, the script attempts a final autosave before exiting.
- **Respects Reddit API**: Uses OAuth2, supports all required credentials, and adapts to API feedback.

---

## Reddit API credentials

To use Omega-Red-Cappa-Edition, you need to create a Reddit application to obtain the necessary API credentials. Here's how:

1. Log in to your Reddit account at https://www.reddit.com
2. Go to [Reddit app preferences](https://www.reddit.com/prefs/apps)
3. Click "Create another application..."
4. Fill in the name, description, and redirect URI (e.g. http://localhost:8080)
5. Select the "script" type
6. After creation, copy the `client_id` and `client_secret`
7. Use your Reddit username and password as well
8. Fill these values in a `.env` file at the root of your project:

```
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USER_AGENT=omega-red-cappa-edition/1.0 by yourusername
REDDIT_USERNAME=your_reddit_username
REDDIT_PASSWORD=your_reddit_password
```

---

## Quick Start

1. **Configure your scraping job:**
   - Edit `config.json` to specify which subreddits to scrape, how many threads, and global options.
   - Example:
     ```json
     {
       "options": {
         "exportFormat": "md", // or "csv", "json"
         "maxParallelThreads": 5,
         "autosaveIntervalSec": 60,
         "throttle": {
           "minDelayMs": 1000,
           "highDelayMs": 3000
         }
       },
       "subreddits": {
         "vibecoding": {
           "vibecoding": 200,
           "lovable": 200
         },
         "saas": {
           "SaaS": 200,
           "microsaas": 200
         }
       }
     }
     ```
   - Each top-level key in `subreddits` is a group (metareddit). Each value is an object mapping subreddit names to the number of threads to scrape.
   - The `options` object controls global behavior (see below).

2. **Run the scraper:**
   - Execute:
     ```sh
     node src/omega-red-cappa-edition.mjs
     ```
   - The script will prompt for export format if not set, and ask if you want to fetch only new threads/comments since the last run (if applicable).

---

## Output Files

- **Per Group:** For each group in your config, files are generated with a timestamp prefix (e.g. `20240514-1942-vibecoding.json`).
- **Formats:**
  - **CSV:**
    - `*-threads.csv` and `*-comments.csv` (flat tables)
  - **JSON:**
    - `*.json` (hierarchical: subreddit → posts → comments tree)
  - **Markdown (MD):**
    - `*.md` (readable, formatted for humans, with posts and nested comments)
- **Autosave:**
  - Every X seconds (configurable), a `*-autosave.json` is written with current progress.

---

## Configuration Parameters

- **options.exportFormat**: `"csv"`, `"json"`, or `"md"` — Output format (prompted if missing)
- **options.maxParallelThreads**: Number of threads to fetch in parallel (default: 5)
- **options.autosaveIntervalSec**: Interval (in seconds) for autosave (default: 60)
- **options.throttle.minDelayMs**: Minimum delay between requests (default: 1000)
- **options.throttle.highDelayMs**: Delay when close to Reddit quota (default: 3000)
- **subreddits**: Object of groups, each mapping subreddit names to thread counts

---

## Incremental Scraping & Resume

- On each run, the script checks for a `last_run.json` file.
- If found, it prompts: _"Do you want to fetch only new threads/comments since [last date]?"_
- If yes, only items newer than the last run are fetched and exported.
- At the end of each run, `last_run.json` is updated with the current timestamp.
- Autosave ensures you never lose more than a few seconds/minutes of work.

---

## Output File Structure

- **CSV:**
  - `*-threads.csv` columns: `text`, `title`, `url`, `id`, `subreddit`, `meta`, `time`, `author`, `ups`, `downs`, `authorlinkkarma`, `authorcommentkarma`, `authorisgold`
  - `*-comments.csv` columns: `text`, `id`, `subreddit`, `meta`, `time`, `author`, `ups`, `downs`, `authorlinkkarma`, `authorcommentkarma`, `authorisgold`
- **JSON:**
  - Hierarchical: array of subreddits, each with posts, each with nested comments (with author info, score, etc.)
- **Markdown:**
  - Human-readable, with posts, metadata, and nested comments, suitable for sharing or archiving.

---

## Code Structure & Modularization

- **src/omega-red-cappa-edition.mjs**: Main script, orchestrates scraping and export.
- **src/lib/helpers.js**: Utility functions (timing, formatting, prompts, etc.)
- **src/lib/export.js**: Exporters for Markdown (and future formats)
- **src/lib/fetchAllThreads.js**: Fetches threads for a subreddit
- **src/lib/fetchAllComments.js**: Fetches comments for a thread
- **src/lib/fetchWithRateLimit.js**: Handles Reddit API rate limiting
- **src/lib/normalizeText.js**: Text normalization utilities

---

## Disclaimer

This tool is aggressive and may violate Reddit's terms of service. Use responsibly and at your own risk. Excessive scraping can result in IP bans or other penalties from Reddit.
