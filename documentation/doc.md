# Omega-Red Documentation

## Overview

**Omega-Red** is an aggressive Reddit scraper designed to collect threads and comments from specified subreddits. It is intended for research, data analysis, or archival purposes, and is capable of bypassing Reddit's rate limits (with exponential backoff to reduce errors).

---

## Features

- **Configurable Subreddit Groups:** Organize subreddits into "metareddits" for batch scraping.
- **Customizable Thread Limits:** Specify how many threads to scrape per subreddit.
- **Buffered Disk Writes:** Data is written in bursts for efficiency.
- **Handles Rate Limiting:** Implements exponential backoff when rate-limited by Reddit.
- **CSV Output:** Exports both threads and comments to separate CSV files.
- **Text Normalization:** All text is lowercased and tokenized for consistency.

---

## Quick Start

1. **Configure Subreddits:**
   - Edit `config.json` to specify which subreddits to scrape and how many threads from each.
   - Example:
     ```json
     {
       "law": {
         "law": 200,
         "legaled": 200
       },
       "technology": {
         "technology": 200,
         "android": 200
       }
     }
     ```
   - Each top-level key is a "metareddit" (custom tag). Each value is an object mapping subreddit names to the number of threads to scrape.

2. **Run the Scraper:**
   - Execute:
     ```sh
     node omega-red.js
     ```

---

## Output Files

- **threads.csv**
  - Columns:
    - `text`, `title`, `url`, `id`, `subreddit`, `meta`, `time`, `author`, `ups`, `downs`, `authorlinkkarma`, `authorcommentkarma`, `authorisgold`
  - Description:
    - Contains one row per thread with normalized text and metadata.

- **comments.csv**
  - Columns:
    - `text`, `id`, `subreddit`, `meta`, `time`, `author`, `ups`, `downs`, `authorlinkkarma`, `authorcommentkarma`, `authorisgold`
  - Description:
    - Contains one row per comment with normalized text and metadata.

---

## Technical Details

- **Buffered Writes:**
  - Data is cached and written to disk in bursts, so file size may not update immediately during scraping.

- **Rate Limiting:**
  - If Reddit rate limits requests, the scraper waits with exponential backoff (up to 30 seconds) before retrying.

- **Text Processing:**
  - All text is lowercased and tokenized using the TreebankTokenizer from the [natural](https://github.com/NaturalNode/natural) library.

---

## File Descriptions

- `omega-red.js`: Main scraper logic.
- `config.json`: User-editable configuration for subreddits and thread limits.
- `omega-writer.js`: Handles buffered writing to CSV files.
- `omega-author.js`: Manages author metadata.
- `verifier.js`: (Purpose inferred) Likely used for data verification or validation.
- `package.json`: Node.js dependencies and project metadata.

---

## Disclaimer

This tool is aggressive and may violate Reddit's terms of service. Use responsibly and at your own risk. Excessive scraping can result in IP bans or other penalties from Reddit. 