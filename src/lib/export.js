import fs from 'fs/promises';
import path from 'path';
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

// Export group to Markdown with size limits
export async function exportGroupToMarkdown(meta, jsonOutput, threadsJsonPath, options = {}) {
  const maxFileSizeMB = options.maxMarkdownSizeMB || 1; // Default to 1MB per file
  const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024; // Convert to bytes
  const isAutosave = options.isAutosave || false;
  
  // Utiliser le dirname du jsonPath pour s'assurer que les fichiers MD sont dans le même dossier
  const baseMdPath = threadsJsonPath.replace(/\.json$/, '');
  const baseMdDir = path.dirname(baseMdPath);
  const baseMdName = path.basename(baseMdPath);
  
  let mdHeader = `# Export Reddit — Groupe : ${meta}\n\n`;
  if (isAutosave) {
    mdHeader += `> *Sauvegarde automatique - ${new Date().toLocaleString()}*\n\n`;
  }
  
  let currentMd = mdHeader;
  let partNumber = 1;
  let partsCreated = [];
  
  // Function to save current markdown and start a new file
  async function saveCurrentMarkdown() {
    const mdFilename = partNumber === 1 
      ? `${baseMdName}.md` 
      : `${baseMdName}-part${partNumber}.md`;
    const mdPath = path.join(baseMdDir, mdFilename);
    
    await fs.writeFile(mdPath, currentMd);
    partsCreated.push(mdPath);
    partNumber++;
    currentMd = mdHeader + `\n> *Suite de l'export (partie ${partNumber})*\n\n`;
  }
  
  // Process each subreddit and its posts
  for (const subredditKey of Object.keys(jsonOutput)) {
    const subreddit = jsonOutput[subredditKey];
    if (!subreddit || !subreddit.posts || !subreddit.posts.length) continue;
    
    const subredditHeader = `\n---\n\n## 🧵 Subreddit : r/${subreddit.subreddit}\n`;
    currentMd += subredditHeader;
    
    // Check if adding subreddit header pushed us over the limit
    if (Buffer.byteLength(currentMd, 'utf8') > maxFileSizeBytes) {
      currentMd = mdHeader + subredditHeader; // Reset with just header + subreddit
      await saveCurrentMarkdown();
    }
    
    // Process each post in the subreddit
    for (const post of subreddit.posts) {
      // Generate markdown for this post
      let postMd = `\n---\n\n## 🧵 Post : ${mdEscape(post.title)}\n`;
      postMd += `**Auteur** : u/${mdEscape(post.author?.username)} (karma : ${post.author?.karma || 0})  \n`;
      postMd += `**Date** : ${formatDate(post.created_utc)}  \n`;
      postMd += `**Score** : ${post.score} points  \n`;
      postMd += `**Commentaires** : ${post.num_comments}  \n`;
      postMd += `**Lien** : [Voir sur Reddit](https://www.reddit.com${post.permalink || ''})\n`;
      postMd += `\n### 📝 Contenu du post :\n> ${mdEscape(post.selftext)}\n`;
      postMd += `\n---\n`;
      postMd += `\n### 💬 Commentaires\n`;
      postMd += renderCommentsMd(post.comments, 0);
      
      // Check if adding this post would exceed the limit
      if (Buffer.byteLength(currentMd + postMd, 'utf8') > maxFileSizeBytes && currentMd !== mdHeader) {
        await saveCurrentMarkdown();
      }
      
      // Add the post to current markdown
      currentMd += postMd;
    }
  }
  
  // Save the final part if there's content
  if (currentMd !== mdHeader && Buffer.byteLength(currentMd, 'utf8') > 0) {
    await saveCurrentMarkdown();
  }
  
  // Log the result
  if (partsCreated.length === 1) {
    console.log(chalk.green(`Exported Markdown data to ${partsCreated[0]}`));
  } else if (partsCreated.length > 1) {
    console.log(chalk.green(`Exported Markdown data to ${partsCreated.length} files:`));
    partsCreated.forEach(p => console.log(chalk.green(`- ${path.basename(p)}`)));
  } else {
    console.log(chalk.yellow(`No Markdown data was exported (no content found).`));
  }
  
  return partsCreated;
} 