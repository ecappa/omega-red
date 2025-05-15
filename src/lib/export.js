import fs from 'fs/promises';
import { formatDate, mdEscape } from './helpers.js';
import chalk from 'chalk';

// Helper: Render comments recursively in Markdown
function renderCommentsMd(comments, level = 0) {
  if (!comments || !comments.length) return '';
  let md = '';
  for (const c of comments) {
    const indent = '  '.repeat(level);
    const mod = c.author && c.author.is_mod ? ' — modérateur' : '';
    md += `\n${indent}#### 🔹 u/${mdEscape(c.author?.username)} (karma : ${c.author?.karma || 0}${mod})\n`;
    md += `${indent}**Posté le** : ${formatDate(c.created_utc)} — **Score** : ${c.score}\n`;
    md += `${indent}> ${mdEscape(c.body)}\n`;
    if (c.replies && c.replies.length) {
      for (const reply of c.replies) {
        md += `\n${indent}##### ↪ Réponse de u/${mdEscape(reply.author?.username)} (karma : ${reply.author?.karma || 0}${reply.author?.is_mod ? ' — modérateur' : ''})\n`;
        md += `${indent}**Posté le** : ${formatDate(reply.created_utc)} — **Score** : ${reply.score}\n`;
        md += `${indent}> ${mdEscape(reply.body)}\n`;
        if (reply.replies && reply.replies.length) {
          md += renderCommentsMd(reply.replies, level + 2);
        }
      }
    }
    md += '\n---\n';
  }
  return md;
}

// Export group to Markdown
export async function exportGroupToMarkdown(meta, jsonOutput, threadsJsonPath) {
  let md = `# Export Reddit — Groupe : ${meta}\n\n`;
  for (const subredditKey of Object.keys(jsonOutput)) {
    const subreddit = jsonOutput[subredditKey];
    md += `\n---\n\n## 🧵 Subreddit : r/${subreddit.subreddit}\n`;
    for (const post of subreddit.posts) {
      md += `\n---\n\n## 🧵 Post : ${mdEscape(post.title)}\n`;
      md += `**Auteur** : u/${mdEscape(post.author?.username)} (karma : ${post.author?.karma || 0})  \n`;
      md += `**Date** : ${formatDate(post.created_utc)}  \n`;
      md += `**Score** : ${post.score} points  \n`;
      md += `**Commentaires** : ${post.num_comments}  \n`;
      md += `**Lien** : [Voir sur Reddit](https://www.reddit.com${post.permalink || ''})\n`;
      md += `\n### 📝 Contenu du post :\n> ${mdEscape(post.selftext)}\n`;
      md += `\n---\n`;
      md += `\n### 💬 Commentaires\n`;
      md += renderCommentsMd(post.comments, 0);
    }
  }
  const mdPath = threadsJsonPath.replace(/\.json$/, '.md');
  await fs.writeFile(mdPath, md);
  console.log(chalk.green(`Exported Markdown data to ${mdPath}`));
} 