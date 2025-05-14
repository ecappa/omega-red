import natural from 'natural';

const tokenizer = new natural.TreebankWordTokenizer();

export function normalizeText(text) {
  if (!text) return '';
  return tokenizer.tokenize(text.toLowerCase()).join(' ');
} 