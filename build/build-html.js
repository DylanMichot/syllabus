// Assemble le jeu en un seul fichier HTML autonome : index.html à la racine,
// prêt pour GitHub Pages ou pour être ouvert directement.
//
// Usage : node build/build-html.js (après build-dict.js)

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const inlines = [
  ['<link rel="stylesheet" href="style.css">', () => `<style>\n${read('src', 'style.css')}</style>`],
  ['<script src="../data/generated/data.js"></script>', () => `<script>\n${read('data', 'generated', 'data.js')}</script>`],
  ['<script src="game.js"></script>', () => `<script>\n${read('src', 'game.js')}</script>`],
];

let html = read('src', 'index.html');
for (const [tag, content] of inlines) {
  if (!html.includes(tag)) throw new Error(`Balise introuvable dans src/index.html : ${tag}`);
  html = html.replace(tag, content); // fonction : pas d'interprétation des « $ »
}

const out = path.join(ROOT, 'index.html');
fs.writeFileSync(out, html);
console.log(`index.html : ${(Buffer.byteLength(html) / 1024).toFixed(0)} Ko`);
