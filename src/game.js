'use strict';

// ---- Réglages ----

const CONFIG = {
  timerStart: 12,          // secondes pour le premier mot
  timerFloor: 5,           // secondes une fois le plancher atteint
  timerFloorAt: 40,        // mots validés pour atteindre le plancher (descente linéaire)
  reserveLives: 1,         // timeouts tolérés avant la fin de partie
  syllableMinWords: 300,   // une syllabe doit apparaître dans au moins ce nombre de mots
  weightExponent: 0.5,     // poids = (nombre de mots) ^ exposant ; 1 = fréquence brute, 0 = uniforme
  syllableNoRepeat: 15,    // une syllabe ne revient pas parmi les N dernières
  alphabet: 'ABCDEFGHIJLMNOPQRSTUVXYZ', // sans K ni W
  restartLockMs: 900,      // délai avant de pouvoir relancer (évite un Entrée accidentel)
  storageKey: 'syllabus.best',
};

// ---- Éléments ----

const $ = (id) => document.getElementById(id);
const els = {
  points: $('points'),
  words: $('words'),
  lives: $('lives'),
  stage: $('stage'),
  ringBar: $('ring-bar'),
  letters: $('letters'),
  syllable: $('syllable'),
  word: $('word'),
  message: $('message'),
  input: $('input'),
  overlay: $('overlay'),
  card: $('card'),
};

// ---- Données ----

// Même normalisation que build/build-dict.js : majuscules, sans accents, A-Z seulement.
function normalize(text) {
  return text
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

// Décode DICT_GZ_B64 : base64 -> gzip -> encodage en préfixes (voir build-dict.js).
async function loadDictionary() {
  const binary = atob(DICT_GZ_B64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();

  const list = [];
  let prev = '';
  let start = 0;
  let shared = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 65 && c <= 90) continue; // lettre majuscule : suite du mot en cours
    if (i > 0) {
      prev = prev.slice(0, shared) + text.slice(start, i);
      list.push(prev);
    }
    if (i < text.length) {
      shared = c <= 57 ? c - 48 : c - 87; // chiffre base 36 : 0-9 puis a-z
      start = i + 1;
    }
  }
  return list;
}

// Table de tirage : poids cumulés, pour un tirage pondéré par recherche dichotomique.
function buildSyllableTable() {
  const list = [];
  const cumulative = [];
  let total = 0;
  for (const entry of SYLLABLE_COUNTS.split(' ')) {
    const [syllable, count] = entry.split(':');
    if (+count < CONFIG.syllableMinWords) continue;
    total += Math.pow(+count, CONFIG.weightExponent);
    list.push(syllable);
    cumulative.push(total);
  }
  return { list, cumulative, total };
}

let wordList = [];
let dictionary = new Set();
const syllables = buildSyllableTable();

// ---- État ----

const state = {
  phase: 'loading', // loading | ready | playing | over
  points: 0,
  wordsCount: 0,
  lives: 0,
  used: new Set(),
  remaining: new Set(),
  syllable: '',
  recent: [],
  turnStart: 0,
  turnDuration: 0,
  overAt: 0,
};

function drawSyllable() {
  const { list, cumulative, total } = syllables;
  for (;;) {
    const r = Math.random() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > r) hi = mid; else lo = mid + 1;
    }
    const syllable = list[lo];
    if (state.recent.includes(syllable)) continue;
    state.recent.push(syllable);
    if (state.recent.length > CONFIG.syllableNoRepeat) state.recent.shift();
    return syllable;
  }
}

function turnDuration(validatedWords) {
  const progress = Math.min(validatedWords / CONFIG.timerFloorAt, 1);
  return (CONFIG.timerStart + (CONFIG.timerFloor - CONFIG.timerStart) * progress) * 1000;
}

// Quelques mots possibles pour une syllabe, de préférence courts et non utilisés.
function examples(syllable, count) {
  const short = [];
  const any = [];
  for (const word of wordList) {
    if (!word.includes(syllable) || state.used.has(word)) continue;
    (word.length <= 9 ? short : any).push(word);
  }
  const pool = short.length >= count ? short : short.concat(any);
  const picked = [];
  while (picked.length < count && pool.length) {
    picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return picked;
}

// ---- Record ----

function loadBest() {
  try {
    const best = JSON.parse(localStorage.getItem(CONFIG.storageKey));
    if (best && Number.isFinite(best.points)) return best;
  } catch (e) { /* stockage indisponible */ }
  return null;
}

function saveBest(best) {
  try { localStorage.setItem(CONFIG.storageKey, JSON.stringify(best)); } catch (e) { /* ignoré */ }
}

// ---- Affichage ----

const letterEls = new Map();

function createLetters() {
  const letters = [...CONFIG.alphabet];
  letters.forEach((letter, i) => {
    const angle = (i / letters.length) * 2 * Math.PI - Math.PI / 2;
    const el = document.createElement('span');
    el.className = 'letter';
    el.textContent = letter;
    el.style.left = `${50 + 46 * Math.cos(angle)}%`;
    el.style.top = `${50 + 46 * Math.sin(angle)}%`;
    els.letters.append(el);
    letterEls.set(letter, el);
  });
}

function renderLetters(hits = new Set()) {
  for (const [letter, el] of letterEls) {
    el.classList.toggle('used', !state.remaining.has(letter));
    el.classList.remove('hit');
    if (hits.has(letter)) {
      void el.offsetWidth; // relance l'animation
      el.classList.add('hit');
    }
  }
}

function renderHud() {
  els.points.textContent = state.points;
  els.words.textContent = state.wordsCount;
  els.lives.replaceChildren();
  for (let i = 0; i < CONFIG.reserveLives; i++) {
    const heart = document.createElement('span');
    heart.textContent = i < state.lives ? '♥' : '♡';
    if (i >= state.lives) heart.className = 'lost';
    els.lives.append(heart);
  }
}

function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

function renderWord() {
  const word = normalize(els.input.value);
  els.word.classList.remove('shake');
  els.word.replaceChildren();
  const at = state.syllable ? word.indexOf(state.syllable) : -1;
  if (at < 0) {
    els.word.append(word);
  } else {
    const mark = document.createElement('mark');
    mark.textContent = state.syllable;
    els.word.append(word.slice(0, at), mark, word.slice(at + state.syllable.length));
  }
  if (state.phase === 'playing') {
    const caret = document.createElement('span');
    caret.className = 'caret';
    els.word.append(caret);
  }
  // Réduit la police si le mot dépasse la largeur disponible dans le cercle.
  els.word.style.setProperty('--fit', 1);
  const available = els.word.parentElement.clientWidth;
  const needed = els.word.offsetWidth;
  if (needed > available) els.word.style.setProperty('--fit', available / needed);
}

let messageTimer = 0;
function showMessage(text, tone = '', duration = 1500) {
  clearTimeout(messageTimer);
  els.message.textContent = text;
  els.message.className = `message ${tone}`;
  if (duration) messageTimer = setTimeout(() => els.message.classList.add('hidden'), duration);
}

function setRing(fraction) {
  els.ringBar.style.strokeDashoffset = 100 * (1 - fraction);
  els.ringBar.style.visibility = fraction > 0 ? 'visible' : 'hidden'; // sinon l'extrémité arrondie reste visible
  els.stage.classList.toggle('warn', fraction <= 0.5 && fraction > 0.25);
  els.stage.classList.toggle('danger', fraction <= 0.25);
}

// ---- Partie ----

function startGame() {
  state.phase = 'playing';
  state.points = 0;
  state.wordsCount = 0;
  state.lives = CONFIG.reserveLives;
  state.used = new Set();
  state.remaining = new Set(CONFIG.alphabet);
  state.recent = [];
  els.overlay.hidden = true;
  showMessage('', '', 0);
  renderHud();
  renderLetters();
  nextTurn();
  els.input.focus();
}

function nextTurn() {
  state.syllable = drawSyllable();
  state.turnDuration = turnDuration(state.wordsCount);
  state.turnStart = performance.now();
  els.syllable.textContent = state.syllable;
  els.syllable.classList.remove('fresh');
  void els.syllable.offsetWidth;
  els.syllable.classList.add('fresh');
  els.input.value = '';
  renderWord();
  setRing(1);
  ensureTicking();
}

function submit() {
  const word = normalize(els.input.value);
  if (!word) return;

  let error = null;
  if (!word.includes(state.syllable)) error = `Le mot doit contenir ${state.syllable}`;
  else if (state.used.has(word)) error = 'Mot déjà utilisé';
  else if (!dictionary.has(word)) error = 'Mot inconnu';
  if (error) {
    showMessage(error, 'danger');
    els.word.classList.remove('shake');
    void els.word.offsetWidth;
    els.word.classList.add('shake');
    return;
  }

  state.used.add(word);
  state.wordsCount++;
  const hits = new Set();
  for (const letter of word) {
    if (state.remaining.delete(letter)) hits.add(letter);
  }

  if (state.remaining.size === 0) {
    state.points++;
    state.remaining = new Set(CONFIG.alphabet);
    renderLetters();
    els.letters.classList.remove('complete');
    void els.letters.offsetWidth;
    els.letters.classList.add('complete');
    bump(els.points);
    showMessage('Alphabet complet : +1 point !', 'accent', 1800);
  } else {
    renderLetters(hits);
    showMessage(`✓ ${word}`, 'ok', 1200);
  }
  renderHud();
  nextTurn();
}

function timeout() {
  const missed = state.syllable;
  if (state.lives > 0) {
    state.lives--;
    renderHud();
    bump(els.lives);
    const ideas = examples(missed, 2);
    showMessage(`Temps écoulé ! ${missed} : ${ideas.join(', ')}`, 'danger', 3000);
    nextTurn();
  } else {
    gameOver(missed);
  }
}

function gameOver(missed) {
  state.phase = 'over';
  state.overAt = performance.now();
  setRing(0);
  renderWord();

  const previous = loadBest();
  const isRecord = !previous
    || state.points > previous.points
    || (state.points === previous.points && state.wordsCount > previous.words);
  if (isRecord) saveBest({ points: state.points, words: state.wordsCount });
  const best = isRecord ? { points: state.points, words: state.wordsCount } : previous;

  const ideas = examples(missed, 3).map((w) => `<b>${w}</b>`).join(', ');
  els.card.innerHTML = `
    <h2>Partie terminée</h2>
    <div class="big">${state.points} point${state.points > 1 ? 's' : ''}</div>
    <p class="muted">${state.wordsCount} mot${state.wordsCount > 1 ? 's' : ''} trouvé${state.wordsCount > 1 ? 's' : ''}
      · ${isRecord ? 'Nouveau record !' : `Record : ${best.points} pt · ${best.words} mots`}</p>
    <p class="examples">Avec <b>${missed}</b>, vous auriez pu taper ${ideas}.</p>
    <div class="actions">
      <button type="button" id="play">Rejouer</button>
      <span class="muted">ou <kbd>Entrée</kbd></span>
    </div>`;
  $('play').addEventListener('click', tryStart);
  els.overlay.hidden = false;
}

function showStartScreen() {
  const best = loadBest();
  const loading = state.phase === 'loading';
  els.card.innerHTML = `
    <h1>SYLLABUS</h1>
    <p>Tapez un mot qui contient la syllabe affichée avant la fin du cercle.</p>
    <ul>
      <li>Chaque mot ne peut servir qu'une fois par partie.</li>
      <li>Utilisez les ${CONFIG.alphabet.length} lettres de la couronne (sans K ni W) pour gagner un point.</li>
      <li>Le temps passe de ${CONFIG.timerStart} à ${CONFIG.timerFloor} secondes au fil des mots.</li>
      <li>Une seule vie de réserve, jamais regagnée.</li>
      <li>Les accents sont ignorés.</li>
    </ul>
    ${best ? `<p class="muted">Record : ${best.points} pt · ${best.words} mots</p>` : ''}
    <div class="actions">
      <button type="button" id="play" ${loading ? 'disabled' : ''}>${loading ? 'Chargement…' : 'Jouer'}</button>
      ${loading ? '' : '<span class="muted">ou <kbd>Entrée</kbd></span>'}
    </div>`;
  $('play').addEventListener('click', tryStart);
  els.overlay.hidden = false;
}

function tryStart() {
  if (state.phase === 'ready') return startGame();
  if (state.phase === 'over' && performance.now() - state.overAt > CONFIG.restartLockMs) startGame();
}

// La boucle d'animation ne tourne que pendant une partie.
let frameId = 0;
function tick(now) {
  frameId = 0;
  if (state.phase !== 'playing') return;
  const left = 1 - (now - state.turnStart) / state.turnDuration;
  if (left <= 0) timeout();
  else setRing(left);
  if (state.phase === 'playing') frameId = requestAnimationFrame(tick);
}

function ensureTicking() {
  if (!frameId) frameId = requestAnimationFrame(tick);
}

// ---- Événements ----

document.addEventListener('keydown', (e) => {
  if (state.phase === 'playing') {
    if (document.activeElement !== els.input) els.input.focus();
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { els.input.value = ''; renderWord(); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    tryStart();
  }
});

els.input.addEventListener('input', renderWord);
els.input.addEventListener('blur', () => {
  if (state.phase === 'playing') setTimeout(() => els.input.focus(), 0);
});
els.stage.addEventListener('pointerdown', (e) => {
  if (state.phase === 'playing') { e.preventDefault(); els.input.focus(); }
});
window.addEventListener('resize', renderWord);

// ---- Démarrage ----

createLetters();
state.remaining = new Set(CONFIG.alphabet);
renderLetters();
renderHud();
showStartScreen();

loadDictionary()
  .then((list) => {
    wordList = list;
    dictionary = new Set(list);
    state.phase = 'ready';
    showStartScreen();
  })
  .catch((err) => {
    els.card.innerHTML = '<h2>Erreur</h2><p>Le dictionnaire n\'a pas pu être chargé. '
      + 'Ce navigateur est peut-être trop ancien.</p>';
    console.error(err);
  });
