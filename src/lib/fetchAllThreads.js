import { fetchWithRateLimit } from './fetchWithRateLimit.js';
import { normalizeText } from './normalizeText.js';

// Fetch all threads for Omega-Red-Cappa-Edition
export async function fetchAllThreads(subreddit, meta, count, token, fetchOptions) {
  let after = null;
  let fetched = 0;
  let threads = [];
  try {
    while (fetched < count) {
      const limit = Math.min(100, count - fetched);
      const url = `https://oauth.reddit.com/r/${subreddit}/new?limit=${limit}${after ? `&after=${after}` : ''}`;
      const response = await fetchWithRateLimit(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': process.env.REDDIT_USER_AGENT
        }
      }, fetchOptions);
      if (!response.ok) {
        throw new Error(`Failed to fetch threads for r/${subreddit}`);
      }
      const data = await response.json();
      const children = data.data.children;
      if (!children || children.length === 0) break;
      for (const child of children) {
        const t = child.data;
        threads.push({
          text: normalizeText(t.selftext),
          title: normalizeText(t.title),
          url: t.url,
          id: t.id,
          subreddit,
          meta,
          time: t.created_utc,
          author: t.author,
          ups: t.ups,
          downs: t.downs,
          authorlinkkarma: '',
          authorcommentkarma: '',
          authorisgold: ''
        });
        after = t.name;
        fetched++;
        if (fetched >= count) break;
      }
      if (children.length < limit) break;
    }
  } catch (err) {
    console.log(`Error in fetchAllThreads for r/${subreddit}: ${err.message}`);
  }
  return threads;
} 