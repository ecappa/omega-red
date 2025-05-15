// Helpers for Omega-Red-Cappa-Edition
export function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function padNumber(num, length = 4) {
  return String(num).padStart(length, '0');
}

export function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

export function formatElapsed(startTime) {
  const elapsed = (Date.now() - startTime) / 1000;
  return formatEta(elapsed);
}

export function calculateEta(startTime, completed, total) {
  if (completed <= 0) return 0;
  const elapsed = (Date.now() - startTime) / 1000;
  const rate = elapsed / completed;
  const remaining = Math.max(0, total - completed);
  return rate * remaining;
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString('fr-FR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function mdEscape(str) {
  return (str || '').replace(/([*_`>])/g, '\\$1');
}

import readline from 'readline';
import chalk from 'chalk';
export async function promptYesNo(question, defaultYes = true) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  return new Promise(resolve => {
    rl.question(chalk.yellow(question + suffix), answer => {
      rl.close();
      answer = answer.trim().toLowerCase();
      if (!answer) return resolve(defaultYes);
      if (['y', 'yes', 'o', 'oui'].includes(answer)) return resolve(true);
      if (['n', 'no', 'non'].includes(answer)) return resolve(false);
      resolve(defaultYes);
    });
  });
} 