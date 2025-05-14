import { fetchWithRateLimit } from './fetchWithRateLimit.js';
import { normalizeText } from './normalizeText.js';

export async function fetchAllComments(subreddit, meta, threadId, token, fetchOptions) {
  const url = `https://oauth.reddit.com/r/${subreddit}/comments/${threadId}?raw_json=1`;
  let comments = [];
  try {
    const response = await fetchWithRateLimit(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': process.env.REDDIT_USER_AGENT
      }
    }, fetchOptions);
    if (!response.ok) {
      throw new Error(`Failed to fetch comments for thread: ${threadId}`);
    }
    const data = await response.json();
    function extractComments(commentArr) {
      for (const c of commentArr) {
        if (!c.data || c.kind !== 't1') continue;
        comments.push({
          text: normalizeText(c.data.body),
          id: c.data.id,
          subreddit,
          meta,
          time: c.data.created_utc,
          author: c.data.author,
          ups: c.data.ups,
          downs: c.data.downs,
          authorlinkkarma: '',
          authorcommentkarma: '',
          authorisgold: ''
        });
        if (c.data.replies && c.data.replies.data && c.data.replies.data.children) {
          extractComments(c.data.replies.data.children);
        }
      }
    }
    if (data[1] && data[1].data && data[1].data.children) {
      extractComments(data[1].data.children);
    }
  } catch (err) {
    console.log(`Error in fetchAllComments for thread ${threadId}: ${err.message}`);
  }
  return comments;
} 