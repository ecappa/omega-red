# omega-red

Omega-Red is a modern, high-performance Reddit scraper designed for researchers, data scientists, and developers who want to collect Reddit threads and comments in bulk. It uses the official Reddit API with OAuth2 authentication, supports robust error handling, and outputs clean CSV files for further analysis. The project features a visually appealing CLI and is easy to configure for your own scraping needs.

## Where to get your Reddit API credentials for the .env file

To use Omega-Red, you need to create a Reddit application to obtain the necessary API credentials. Here's how:

1. Log in to your Reddit account at https://www.reddit.com
2. Go to [Reddit app preferences](https://www.reddit.com/prefs/apps)
3. Scroll down and click "Create another application..."
4. Fill in the name, description, and redirect URI (you can use http://localhost:8080 for the redirect URI)
5. Select the "script" type
6. After creation, you will see your app listed. Copy the `client_id` (displayed under the app name) and the `client_secret`
7. Use your Reddit username and password as well
8. Fill these values in a `.env` file at the root of your project, like this:

```
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_USER_AGENT=omega-red-modern/1.0 by yourusername
REDDIT_USERNAME=your_reddit_username
REDDIT_PASSWORD=your_reddit_password
```

---

Aggressive (rate limit disobeying) scraper for reddit.

##Quick Start

Add in the subreddits you want to scrape into the `config.json` file. 

```js
{
  "law": {
    "law": 200,
    "legaled": 200,
    "cyberlaws": 200,
    "isthislegal": 200,
    "legalnews": 200,
    "lsat": 200
  },
  "technology": {
    "technology": 200,
    "android": 200,
    "bitcoin": 200,
    "programming": 200,
    "apple": 200
  }
}
```

Each object in the `config.json` is a "metareddit", a tag for a group of subreddits. Each of the keys of the object is a subreddit, with its value the number of threads to scrape.

In this case, I'm scraping two "meta"s, each having their own subreddits.

The scraper will try its best to approximate the number of threads specified subject to errors and length of the subreddit.

To start the scraper, run

```js
$ node omega-red.js
```

The scraper will then run.

##Nitty Gritty

###Buffering
The scraper uses a buffered write stream, meaning that writes to the disk will happen in bursts. Hence, observing file size to see progress will be inaccurate since quite a large amount of data can be cached.

###Rate Limits
Reddit will rate limit excessive queries. Hence, (increasingly towards the end of scraping) omega-red will produce error messages such as `Rate limited. Waiting 531 ms`. It uses an exponential backoff for waiting time (with maximum of 30,000ms). This is aimed at reducing the likelihood of multiple scrapers jamming the query.

###Outputs
Outputs two `.csv`s: `threads.csv` and `comments.csv`. Both CSVs have no headers. The meaning of the columns are:

####Threads

```js
['text', 'title', 'url', 'id', 'subreddit', 'meta', 'time', 'author', 'ups', 'downs', 'authorlinkkarma', 'authorcommentkarma', 'authorisgold']
```

- `text`: text of the thread
- `title`: title of the thread
- `url`: url of the thread
- `id`: unique ID of the thread
- `subreddit`: subreddit that the thread belongs to
- `meta`: meta tag assigned to the subreddit of the thread in `config.json`
- `time`: timestamp of the thread
- `author`: username of the author of the thread
- `ups`: number of ups the thread has received
- `downs`: number of downs the thread has received
- `authorlinkkarma`: the author's link karma
- `authorcommentkarma`: the author's comment karma
- `authorisgold`: `1` if the author has gold status, `0` otherwise

####Comments

```js
['text', 'id', 'subreddit', 'meta', 'time', 'author', 'ups', 'downs', 'authorlinkkarma', 'authorcommentkarma', 'authorisgold']
```

- `text`: text of the comment
- `id`: unique ID of the comment
- `subreddit`: subreddit that the thread belongs to
- `meta`: meta tag assigned to the subreddit of the thread in `config.json`
- `time`: timestamp of the thread
- `author`: username of the author of the thread
- `ups`: number of ups the thread has received
- `downs`: number of downs the thread has received
- `authorlinkkarma`: the author's link karma
- `authorcommentkarma`: the author's comment karma
- `authorisgold`: `1` if the author has gold status, `0` otherwise

All text is normalized to lower case, tokenized using a TreebankTokenizer from [natural](https://github.com/NaturalNode/natural), then joined with spaces. This results in punctuation being separated from words, a desired effect.
