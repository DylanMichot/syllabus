'use strict';

// ---- Réglages ----

// Réglages modifiables depuis l'écran d'accueil (valeurs par défaut ici).
const SETTINGS = [
  { key: 'timerStart', label: 'Temps au départ', unit: 's', min: 2, max: 60, step: 0.5, def: 12 },
  { key: 'timerFloor', label: 'Temps plancher', unit: 's', min: 1, max: 60, step: 0.5, def: 5 },
  { key: 'timerFloorAt', label: 'Plancher atteint après', unit: 'mots', min: 1, max: 500, step: 1, def: 12,
    hint: 'Compté depuis le dernier alphabet complété' },
  { key: 'reserveLives', label: 'Vies de réserve', unit: 'max', min: 0, max: 5, step: 1, def: 1 },
  { key: 'syllableMinWords', label: 'Mots par syllabe', unit: 'min', min: 50, max: 20000, step: 50, def: 300 },
  { key: 'weightExponent', label: 'Poids des syllabes', unit: '', min: 0, max: 1, step: 0.1, def: 0.5,
    hint: '0 : toutes égales · 1 : fréquence réelle' },
  { key: 'excludedLetters', label: 'Lettres exclues', type: 'text', def: 'KW' },
];

const FIXED = {
  syllableNoRepeat: 15,    // une syllabe ne revient pas parmi les N dernières
  restartLockMs: 900,      // délai avant de pouvoir relancer (évite un Entrée accidentel)
  familiarLevel: 2,        // niveau de fréquence minimal des suggestions (élargi si besoin)
  // v2 : le timer repart à chaque alphabet, les anciens réglages et records ne sont plus comparables.
  settingsKey: 'syllabus.settings.v2',
  recordsKey: 'syllabus.records.v2',
  // Couleur du timer : jaune quand il est plein, rouge quand il est vide.
  ringFull: [255, 210, 63],
  ringEmpty: [255, 59, 79],
};

const FULL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

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
  menu: $('menu'),
  settings: $('settings'),
  play: $('play'),
  reset: $('reset'),
  record: $('record'),
  result: $('result'),
  resultPoints: $('result-points'),
  resultDetail: $('result-detail'),
  resultTiming: $('result-timing'),
  resultExamples: $('result-examples'),
};

// ---- Stockage local (facultatif : le jeu fonctionne sans) ----

function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignoré */ }
}

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

// Décode DICT_GZ_B64 : base64 -> gzip -> mots encodés en préfixes, saut de ligne,
// puis un niveau de fréquence (0 = rare à 4 = très courant) par mot (voir build-dict.js).
async function loadDictionary() {
  const binary = atob(DICT_GZ_B64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const text = await new Response(stream).text();
  const end = text.indexOf('\n');

  const list = [];
  let prev = '';
  let start = 0;
  let shared = 0;
  for (let i = 0; i <= end; i++) {
    const c = text.charCodeAt(i);
    if (c >= 65 && c <= 90) continue; // lettre majuscule : suite du mot en cours
    if (i > 0) {
      prev = prev.slice(0, shared) + text.slice(start, i);
      list.push(prev);
    }
    if (i < end) {
      shared = c <= 57 ? c - 48 : c - 87; // chiffre base 36 : 0-9 puis a-z
      start = i + 1;
    }
  }

  const levels = new Uint8Array(list.length);
  for (let i = 0; i < list.length; i++) levels[i] = text.charCodeAt(end + 1 + i) - 48;
  return { list, levels };
}

const SYLLABLE_DATA = SYLLABLE_COUNTS.split(' ').map((entry) => {
  const [syllable, count] = entry.split(':');
  return [syllable, +count];
});

// Table de tirage : poids cumulés, pour un tirage pondéré par recherche dichotomique.
function buildSyllableTable(minWords, exponent) {
  const list = [];
  const cumulative = [];
  let total = 0;
  for (const [syllable, count] of SYLLABLE_DATA) {
    if (count < minWords) continue;
    total += Math.pow(count, exponent);
    list.push(syllable);
    cumulative.push(total);
  }
  return { list, cumulative, total };
}

let wordList = [];
let wordLevels = new Uint8Array(0); // niveau de fréquence de chaque mot de wordList
let dictionary = new Set();

// ---- État ----

let settings = loadSettings();

const state = {
  phase: 'loading', // loading | ready | playing | over
  alphabet: '',
  syllables: null,
  points: 0,
  wordsCount: 0,
  alphabetWords: 0, // mots validés depuis le dernier alphabet complété (règle le timer)
  lives: 0,
  used: new Set(),
  responses: [], // mots validés : { ms, atFloor } (temps depuis l'affichage de la syllabe)
  remaining: new Set(),
  syllable: '',
  recent: [],
  turnStart: 0,
  turnDuration: 0,
  overAt: 0,
};

function drawSyllable() {
  const { list, cumulative, total } = state.syllables;
  const noRepeat = Math.min(FIXED.syllableNoRepeat, list.length - 1);
  for (;;) {
    const r = Math.random() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > r) hi = mid; else lo = mid + 1;
    }
    const syllable = list[lo];
    if (state.recent.slice(-noRepeat).includes(syllable)) continue;
    state.recent.push(syllable);
    if (state.recent.length > FIXED.syllableNoRepeat) state.recent.shift();
    return syllable;
  }
}

// Durée du tour selon le nombre de mots validés depuis le dernier alphabet complété.
function turnDuration(validatedWords) {
  const progress = Math.min(validatedWords / settings.timerFloorAt, 1);
  return (settings.timerStart + (settings.timerFloor - settings.timerStart) * progress) * 1000;
}

// Suggestions pour une syllabe manquée, par ordre de priorité :
// 1. des mots familiers : niveau de fréquence 2 ou plus (« assiette », « crise »),
//    élargi au niveau 1 puis à tout le dictionnaire s'il n'y en a pas assez ;
// 2. le plus de lettres encore à placer dans l'alphabet ;
// 3. les mots les plus fréquents, puis au hasard en cas d'égalité.
// Chaque suggestion suivante compte seulement les lettres que les précédentes ne couvrent pas.
function examples(syllable, count) {
  const byLevel = [[], [], [], [], []];
  for (let i = 0; i < wordList.length; i++) {
    const word = wordList[i];
    if (word.includes(syllable) && !state.used.has(word)) byLevel[wordLevels[i]].push(i);
  }
  let pool = [];
  for (let level = 4; level >= 0; level--) {
    if (level < FIXED.familiarLevel && pool.length >= count) break;
    pool = pool.concat(byLevel[level]);
  }

  const missing = new Set(state.remaining);
  const tieBreak = new Map(pool.map((i) => [i, Math.random()]));
  const picked = [];
  while (picked.length < count && pool.length) {
    let best = -1;
    let bestLetters = -1;
    for (let k = 0; k < pool.length; k++) {
      const i = pool[k];
      const letters = new Set([...wordList[i]].filter((l) => missing.has(l))).size;
      if (best < 0 || letters > bestLetters
        || (letters === bestLetters && (wordLevels[i] > wordLevels[pool[best]]
          || (wordLevels[i] === wordLevels[pool[best]] && tieBreak.get(i) > tieBreak.get(pool[best]))))) {
        best = k;
        bestLetters = letters;
      }
    }
    const word = wordList[pool.splice(best, 1)[0]];
    for (const l of word) missing.delete(l);
    picked.push(word);
  }
  return picked;
}

// Mot le plus « évident » qui aurait coché au moins une lettre restante : le plus
// fréquent, puis celui qui en coche le plus, puis le plus court. null s'il n'y en a pas.
function missedOpportunity(syllable) {
  let best = null;
  let bestLevel = -1;
  let bestLetters = 0;
  for (let i = 0; i < wordList.length; i++) {
    const word = wordList[i];
    const level = wordLevels[i];
    if (level < bestLevel || !word.includes(syllable) || state.used.has(word)) continue;
    const letters = new Set([...word].filter((l) => state.remaining.has(l))).size;
    if (!letters) continue;
    if (level > bestLevel || letters > bestLetters
      || (letters === bestLetters && word.length < best.length)) {
      best = word;
      bestLevel = level;
      bestLetters = letters;
    }
  }
  return best;
}

// ---- Réglages ----

function defaultSettings() {
  return Object.fromEntries(SETTINGS.map((s) => [s.key, s.def]));
}

function cleanSettings(raw) {
  const clean = {};
  for (const s of SETTINGS) {
    const value = raw ? raw[s.key] : undefined;
    if (s.type === 'text') {
      clean[s.key] = [...new Set(normalize(String(value ?? s.def)))].sort().join('');
    } else {
      const n = parseFloat(value);
      clean[s.key] = Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : s.def;
    }
  }
  // Il faut garder au moins quelques lettres, et le plancher ne dépasse pas le départ.
  if (FULL_ALPHABET.length - clean.excludedLetters.length < 5) clean.excludedLetters = defaultSettings().excludedLetters;
  clean.timerFloor = Math.min(clean.timerFloor, clean.timerStart);
  return clean;
}

function loadSettings() {
  return cleanSettings({ ...defaultSettings(), ...readStorage(FIXED.settingsKey) });
}

function settingsSignature(s) {
  return SETTINGS.map((d) => s[d.key]).join('|');
}

function alphabetFor(s) {
  return [...FULL_ALPHABET].filter((l) => !s.excludedLetters.includes(l)).join('');
}

// Le record est propre à chaque combinaison de réglages, pour que les scores restent comparables.
function getRecord(s) {
  const records = readStorage(FIXED.recordsKey) || {};
  return records[settingsSignature(s)] || null;
}

function setRecord(s, record) {
  const records = readStorage(FIXED.recordsKey) || {};
  records[settingsSignature(s)] = record;
  writeStorage(FIXED.recordsKey, records);
}

const settingInputs = new Map();

function createSettingsForm() {
  for (const s of SETTINGS) {
    const row = document.createElement('label');
    row.className = 'setting';
    const name = document.createElement('span');
    name.className = 'setting-label';
    name.textContent = s.label;
    const input = document.createElement('input');
    input.name = s.key;
    if (s.type === 'text') {
      input.type = 'text';
      input.maxLength = 21;
      input.autocomplete = 'off';
      input.spellcheck = false;
    } else {
      input.type = 'number';
      input.min = s.min;
      input.max = s.max;
      input.step = s.step;
      input.inputMode = s.step < 1 ? 'decimal' : 'numeric';
    }
    const unit = document.createElement('span');
    unit.className = 'setting-unit';
    unit.textContent = s.unit || '';
    row.append(name, input, unit);
    if (s.hint || s.key === 'syllableMinWords' || s.key === 'excludedLetters') {
      const hint = document.createElement('span');
      hint.className = 'setting-hint';
      hint.dataset.key = s.key;
      hint.textContent = s.hint || '';
      row.append(hint);
    }
    els.settings.append(row);
    settingInputs.set(s.key, input);
  }
}

function fillSettingsForm(s) {
  for (const [key, input] of settingInputs) input.value = s[key];
  updateMenuInfo();
}

function readSettingsForm() {
  const raw = {};
  for (const [key, input] of settingInputs) raw[key] = input.value;
  return cleanSettings(raw);
}

// Informations qui dépendent des réglages en cours de saisie.
function updateMenuInfo() {
  const s = readSettingsForm();
  const syllableCount = SYLLABLE_DATA.filter(([, c]) => c >= s.syllableMinWords).length;
  els.settings.querySelector('[data-key="syllableMinWords"]').textContent =
    `${syllableCount} syllabes possibles`;
  els.settings.querySelector('[data-key="excludedLetters"]').textContent =
    `Alphabet de ${alphabetFor(s).length} lettres`;
  const record = getRecord(s);
  els.record.textContent = record
    ? `Record avec ces réglages : ${plural(record.points, 'point')} · ${plural(record.words, 'mot')}`
    : 'Pas encore de record avec ces réglages';
}

function plural(n, word) {
  return `${n} ${word}${n > 1 ? 's' : ''}`;
}

// ---- Affichage ----

const letterEls = new Map();

function createLetters(alphabet) {
  els.letters.replaceChildren();
  letterEls.clear();
  [...alphabet].forEach((letter, i) => {
    const angle = (i / alphabet.length) * 2 * Math.PI - Math.PI / 2;
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
  els.lives.textContent = state.lives;
  els.lives.classList.toggle('empty', state.lives === 0);
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

// fraction : 1 = plein (jaune), 0 = vide (rouge), couleur interpolée linéairement.
function setRing(fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  const rgb = FIXED.ringEmpty.map((empty, i) => Math.round(empty + (FIXED.ringFull[i] - empty) * f));
  els.ringBar.style.stroke = `rgb(${rgb.join(',')})`;
  els.ringBar.style.strokeDashoffset = 100 * (1 - f);
  els.ringBar.style.visibility = f > 0 ? 'visible' : 'hidden'; // sinon l'extrémité arrondie reste visible
}

// ---- Partie ----

function startGame() {
  settings = readSettingsForm();
  writeStorage(FIXED.settingsKey, settings);
  fillSettingsForm(settings);

  state.phase = 'playing';
  state.alphabet = alphabetFor(settings);
  state.syllables = buildSyllableTable(settings.syllableMinWords, settings.weightExponent);
  state.points = 0;
  state.wordsCount = 0;
  state.alphabetWords = 0;
  state.lives = settings.reserveLives;
  state.used = new Set();
  state.responses = [];
  state.remaining = new Set(state.alphabet);
  state.recent = [];

  els.menu.hidden = true;
  showMessage('', '', 0);
  createLetters(state.alphabet);
  renderHud();
  renderLetters();
  nextTurn();
  els.input.focus();
}

function nextTurn() {
  state.syllable = drawSyllable();
  state.turnDuration = turnDuration(state.alphabetWords);
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
  state.responses.push({
    ms: performance.now() - state.turnStart,
    atFloor: state.alphabetWords >= settings.timerFloorAt,
  });
  state.wordsCount++;
  state.alphabetWords++;
  const hits = new Set();
  for (const letter of word) {
    if (state.remaining.delete(letter)) hits.add(letter);
  }

  if (state.remaining.size === 0) {
    state.points++;
    state.alphabetWords = 0; // le timer repart de sa durée de départ
    state.remaining = new Set(state.alphabet);
    const regained = state.lives < settings.reserveLives;
    if (regained) {
      state.lives++;
      bump(els.lives);
    }
    renderLetters();
    els.letters.classList.remove('complete');
    void els.letters.offsetWidth;
    els.letters.classList.add('complete');
    bump(els.points);
    showMessage(regained ? '+1 point · vie regagnée' : '+1 point', 'accent', 1800);
  } else {
    renderLetters(hits);
    // Aucune lettre cochée alors que c'était possible : on montre le mot évident (jaune).
    const better = hits.size ? null : missedOpportunity(state.syllable);
    if (better) showMessage(better, 'hint', 2500);
    else showMessage(word, 'ok', 1200);
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
    showMessage(examples(missed, 2).join(', '), 'danger', 3000);
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

  const previous = getRecord(settings);
  const isRecord = !previous
    || state.points > previous.points
    || (state.points === previous.points && state.wordsCount > previous.words);
  if (isRecord) setRecord(settings, { points: state.points, words: state.wordsCount });

  els.resultPoints.textContent = plural(state.points, 'point');
  els.resultDetail.textContent =
    `${plural(state.wordsCount, 'mot')} trouvé${state.wordsCount > 1 ? 's' : ''}${isRecord ? ' · Nouveau record !' : ''}`;
  els.resultTiming.textContent = timingSummary();
  const ideas = examples(missed, 3);
  els.resultExamples.replaceChildren(
    'Avec ', bold(missed), ', vous auriez pu taper ',
    ...ideas.flatMap((w, i) => (i ? [', ', bold(w)] : [bold(w)])), '.',
  );
  els.result.hidden = false;
  showMenu();
}

// Temps de réponse moyen des mots validés, en tout puis par phase du timer
// (descente et plancher), pour aider à régler les durées.
function timingSummary() {
  const average = (list) => list.reduce((sum, r) => sum + r.ms, 0) / list.length / 1000;
  const format = (s) => `${s.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
  const all = state.responses;
  if (!all.length) return '';
  const descent = all.filter((r) => !r.atFloor);
  const floor = all.filter((r) => r.atFloor);
  let text = `Temps de réponse moyen : ${format(average(all))}`;
  if (descent.length && floor.length) {
    text += ` (${format(average(descent))} pendant la descente, ${format(average(floor))} au plancher)`;
  }
  return text;
}

function bold(text) {
  const b = document.createElement('b');
  b.textContent = text;
  return b;
}

function showMenu() {
  fillSettingsForm(settings);
  const loading = state.phase === 'loading';
  els.play.disabled = loading;
  els.play.textContent = loading ? 'Chargement…' : 'Jouer';
  els.menu.hidden = false;
}

function tryStart() {
  if (state.phase === 'ready') startGame();
  else if (state.phase === 'over' && performance.now() - state.overAt > FIXED.restartLockMs) startGame();
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

els.settings.addEventListener('input', updateMenuInfo);
els.settings.addEventListener('submit', (e) => e.preventDefault());
els.settings.addEventListener('change', () => fillSettingsForm(readSettingsForm()));
els.play.addEventListener('click', tryStart);
els.reset.addEventListener('click', () => fillSettingsForm(defaultSettings()));

// ---- Démarrage ----

createSettingsForm();
createLetters(alphabetFor(settings));
state.remaining = new Set(alphabetFor(settings));
state.lives = settings.reserveLives;
renderLetters();
renderHud();
showMenu();

loadDictionary()
  .then(({ list, levels }) => {
    wordList = list;
    wordLevels = levels;
    dictionary = new Set(list);
    state.phase = 'ready';
    showMenu();
  })
  .catch((err) => {
    els.play.textContent = 'Navigateur non compatible';
    console.error(err);
  });
