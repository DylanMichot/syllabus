// Prépare le dictionnaire et la table des syllabes à partir du lexique Grammalecte.
//
// Usage : node build/build-dict.js
// Entrée : data/source/lexique-grammalecte-fr-v7.7.txt (MPL 2.0, https://grammalecte.net/)
// Sortie : data/generated/data.js (dictionnaire compressé + syllabes)

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'data', 'source', 'lexique-grammalecte-fr-v7.7.txt');
const OUT_DIR = path.join(ROOT, 'data', 'generated');

// Syllabes conservées dans le fichier généré. Le seuil de jeu (300 mots) est
// appliqué au moment du tirage, ce qui permet de l'ajuster sans tout reconstruire.
const SYLLABLE_LENGTHS = [2, 3];
const SYLLABLE_STORE_MIN = 50;

// Étiquettes de noms propres : prénoms, patronymes, titres, noms propres.
const EXCLUDED_TAGS = new Set(['npr', 'prn', 'patr', 'titr']);
// Forme fléchie entièrement en minuscules : écarte sigles, noms de lieux,
// mots composés (tiret, apostrophe, espace) et formules chimiques.
const LOWERCASE_WORD = /^[a-zàâäçéèêëîïôöùûüÿœæ]+$/;
const HAS_VOWEL = /[AEIOUY]/;

function normalize(word) {
  return word
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase();
}

function readWords() {
  const words = new Set();
  const stats = { entries: 0, notLowercase: 0, properNoun: 0, noVowel: 0 };
  for (const line of fs.readFileSync(SOURCE, 'utf8').split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 20 || cols[0] === 'id') continue;
    stats.entries++;
    const [, , form, , tags] = cols;
    if (!LOWERCASE_WORD.test(form)) { stats.notLowercase++; continue; }
    if (tags.split(' ').some((t) => EXCLUDED_TAGS.has(t))) { stats.properNoun++; continue; }
    const word = normalize(form);
    if (!/^[A-Z]+$/.test(word)) throw new Error(`Normalisation incomplète : ${form} -> ${word}`);
    if (!HAS_VOWEL.test(word)) { stats.noVowel++; continue; }
    words.add(word);
  }
  return { words: [...words].sort(), stats };
}

// Chaque mot devient : 1 caractère base 36 (longueur du préfixe commun avec le
// mot précédent, 0-9 puis a-z) suivi du suffixe en majuscules. Le caractère de
// préfixe n'étant jamais une majuscule, aucun séparateur n'est nécessaire.
function prefixEncode(words) {
  let prev = '';
  let out = '';
  for (const word of words) {
    let n = 0;
    const max = Math.min(prev.length, word.length, 35);
    while (n < max && prev[n] === word[n]) n++;
    out += n.toString(36) + word.slice(n);
    prev = word;
  }
  return out;
}

function prefixDecode(encoded) {
  const words = [];
  let prev = '';
  for (const [, n, suffix] of encoded.matchAll(/([0-9a-z])([A-Z]*)/g)) {
    prev = prev.slice(0, parseInt(n, 36)) + suffix;
    words.push(prev);
  }
  return words;
}

// Nombre de mots contenant chaque suite de lettres (un mot ne compte qu'une
// fois, même si la suite y apparaît plusieurs fois : ESSES compte 1 pour ES).
function countSyllables(words) {
  const counts = new Map();
  for (const word of words) {
    const seen = new Set();
    for (const len of SYLLABLE_LENGTHS) {
      for (let i = 0; i + len <= word.length; i++) seen.add(word.substr(i, len));
    }
    for (const s of seen) counts.set(s, (counts.get(s) || 0) + 1);
  }
  return [...counts]
    .filter(([, c]) => c >= SYLLABLE_STORE_MIN)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function main() {
  const { words, stats } = readWords();
  const encoded = prefixEncode(words);

  const decoded = prefixDecode(encoded);
  if (decoded.length !== words.length || decoded.some((w, i) => w !== words[i])) {
    throw new Error("L'encodage en préfixes ne se relit pas à l'identique");
  }

  const gzipped = zlib.gzipSync(Buffer.from(encoded, 'ascii'), { level: 9 });
  const base64 = gzipped.toString('base64');
  const syllables = countSyllables(words);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const js =
    '// Généré par build/build-dict.js — ne pas modifier à la main.\n' +
    '// Mots issus du lexique Grammalecte v7.7 (MPL 2.0, https://grammalecte.net/).\n' +
    `// ${words.length} mots, encodés en préfixes, gzip, base64.\n` +
    `const DICT_GZ_B64 = "${base64}";\n` +
    '// Syllabes : "SYLLABE:nombre de mots qui la contiennent", triées par fréquence.\n' +
    `const SYLLABLE_COUNTS = "${syllables.map(([s, c]) => `${s}:${c}`).join(' ')}";\n`;
  fs.writeFileSync(path.join(OUT_DIR, 'data.js'), js);

  console.log('Entrées du lexique      ', stats.entries);
  console.log('  pas en minuscules     ', stats.notLowercase);
  console.log('  noms propres          ', stats.properNoun);
  console.log('  sans voyelle          ', stats.noVowel);
  console.log('Mots uniques            ', words.length);
  console.log('Texte brut (octets)     ', words.join('\n').length);
  console.log('Préfixes (octets)       ', encoded.length);
  console.log('Préfixes + gzip         ', gzipped.length);
  console.log('… en base64             ', base64.length);
  console.log('Syllabes stockées (>=%d)', SYLLABLE_STORE_MIN, syllables.length);
  console.log('data.js (octets)        ', Buffer.byteLength(js));
}

main();
