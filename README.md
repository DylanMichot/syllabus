# Syllabus

Jeu de mots solo inspiré de Bomb Party, en un seul fichier HTML.

Une syllabe de 2 ou 3 lettres s'affiche : tapez un mot qui la contient avant la fin du cercle.
Chaque mot ne sert qu'une fois. Utiliser les 24 lettres de la couronne (sans K ni W) rapporte
un point. Le temps passe de 12 à 5 secondes au fil des mots, avec une seule vie de réserve.

## Jouer

Ouvrir `index.html` dans un navigateur récent (Chrome 80+, Firefox 113+, Safari 16.4+),
en local ou via GitHub Pages. Aucune dépendance, aucun réseau nécessaire.

## Structure

```
index.html              jeu complet, généré (ne pas modifier à la main)
src/                    sources du jeu : index.html, style.css, game.js
build/build-dict.js     lexique -> data/generated/data.js
build/build-html.js     src + data -> index.html
data/generated/data.js  dictionnaire compressé et table des syllabes (généré)
data/source/            lexique Grammalecte brut (non versionné)
```

Les réglages (timer, seuil et poids des syllabes, alphabet) sont en tête de `src/game.js`.
Pendant le développement, `src/index.html` fonctionne directement via un serveur local.

## Reconstruire

```bash
npm run build
```

Pour regénérer le dictionnaire, télécharger d'abord le lexique dans `data/source/` :

```bash
curl -L -o data/source/lexique.zip https://grammalecte.net/dic/lexique-grammalecte-fr-v7.7.zip
unzip data/source/lexique.zip -d data/source/
npm run build:dict && npm run build
```

## Dictionnaire

Les mots proviennent du [lexique des formes fléchies de Grammalecte](https://grammalecte.net/)
(v7.7, Olivier R.), distribué sous licence [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/).
La liste a été filtrée (noms propres, sigles, mots composés, mots sans voyelle) et normalisée
(majuscules, sans accents) par `build/build-dict.js`.
