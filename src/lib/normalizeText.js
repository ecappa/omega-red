import natural from 'natural';

const tokenizer = new natural.TreebankWordTokenizer();

// Text normalization for Omega-Red-Cappa-Edition

export function normalizeText(text) {
  if (!text) return '';
  return tokenizer.tokenize(text.toLowerCase()).join(' ');
} 