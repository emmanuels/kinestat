# KinéStat v1

Web app installable (PWA) pour iPhone : le kiné prend une photo, place 3 points (A, B, C) et obtient l'angle ABC et la valeur clinique du test. Le suivi montre la progression par côté, l'indice de symétrie et la comparaison de deux photos.

**Toutes les données restent sur l'iPhone** (IndexedDB). Rien n'est envoyé sur un serveur : pas de compte, pas d'hébergement de données de santé.

## Contenu de la v1

- **Patients** identifiés par leurs initiales (+ complément facultatif), consentement photo obligatoire avant toute mesure, suppression en cascade avec confirmation.
- **Mesure** : 13 tests des membres inférieurs (hanche, genou, cheville) + mesure libre, placement guidé A → B → C, loupe, zoom à deux doigts, date reprise de la photo (EXIF), angle ABC **et** valeur clinique, réouverture et correction d'une mesure.
- **Suivi** : courbe gauche/droite, écart avec la mesure précédente et avec la première, indice de symétrie, comparaison de 2 photos annotées, export CSV du patient.
- **Réglages** : sauvegarde chiffrée (AES-GCM 256, clé dérivée par PBKDF2-SHA256, 310 000 itérations) et restauration, export CSV global, état du stockage, patient exemple.
- **Hors ligne** : service worker ; l'app fonctionne sans réseau une fois installée.

## Déployer sur GitHub Pages

1. Créer un dépôt (ex. `kinestat`) et y pousser le contenu de ce dossier à la racine.
2. Sur GitHub : **Settings → Pages → Build and deployment → Source : Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. L'app est servie sur `https://<compte>.github.io/kinestat/` (HTTPS obligatoire pour le chiffrement et le service worker).

```bash
git init && git add . && git commit -m "KinéStat v1"
git branch -M main
git remote add origin git@github.com:<compte>/kinestat.git
git push -u origin main
```

> Le dépôt peut rester public : il ne contient que le code, jamais de données patient.

## Installer sur l'iPhone

1. Ouvrir l'adresse dans **Safari**.
2. Bouton **Partager** → **Sur l'écran d'accueil**.
3. Lancer KinéStat depuis l'icône. **Important** : sans installation, iOS peut effacer les données du site après quelques semaines sans visite.

## Catalogue des tests (`tests.json`)

Les tests, leurs repères A/B/C, les consignes de position et la formule de la valeur clinique sont dans `tests.json`, pas dans le code. La valeur clinique se calcule par `a × ABC + b` (ex. déficit d'extension : `a = -1`, `b = 180`).

- Pour corriger un repère ou une formule après les retours de la kiné : modifier `tests.json`, incrémenter `CACHE` dans `sw.js`, pousser.
- Ne jamais renommer l'identifiant d'un test (`ake`, `slr`…) : les mesures enregistrées y font référence.
- Ce fichier est la **source de vérité** à reprendre dans Kinésia lors du portage natif (décodable directement avec `Codable` en Swift).

## Catalogue des tests (`tests.json`)

Les tests, leurs repères A/B/C, les consignes de position et la formule de la valeur clinique sont dans `tests.json`, pas dans le code. La valeur clinique se calcule par `a × ABC + b` (ex. déficit d'extension : `a = -1`, `b = 180`).

- Pour corriger un repère ou une formule après les retours de la kiné : modifier `tests.json`, incrémenter `CACHE` dans `sw.js`, pousser.
- Ne jamais renommer l'identifiant d'un test (`ake`, `slr`…) : les mesures enregistrées y font référence.
- Ce fichier est la **source de vérité** à reprendre dans Kinésia lors du portage natif (décodable directement avec `Codable` en Swift).

## Sauvegarde

Réglages → *Sauvegarde chiffrée* → phrase secrète → **Préparer la sauvegarde** → **Enregistrer le fichier** (feuille de partage iOS : « Enregistrer dans Fichiers », AirDrop…). Le fichier `kinestat-sauvegarde-AAAA-MM-JJ.json` est illisible sans la phrase secrète, qui ne peut pas être récupérée. Un rappel s'affiche dans Patients au-delà de 14 jours sans sauvegarde.

## Publier une mise à jour

Modifier les fichiers, **incrémenter `CACHE` dans `sw.js`** (ex. `kinestat-v1.0.1`) et `VERSION` dans `app.js`, puis pousser. L'iPhone récupère la nouvelle version au lancement suivant (parfois au second lancement).

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Écrans Patients, Mesure, Suivi, Réglages |
| `app.css` | Styles (clair / sombre, zones sûres iPhone) |
| `app.js` | Logique : gestes, stockage, suivi, CSV, chiffrement |
| `tests.json` | Catalogue des tests (repères, consignes, formules) |
| `sw.js` | Cache hors ligne |
| `manifest.webmanifest`, `icons/` | Installation sur l'écran d'accueil |

## Limites connues

- Précision d'une mesure photo : environ ±3 à 5°, dépend surtout du placement du téléphone (perpendiculaire au mouvement, même distance).
- Angle non orienté (0 à 180°) : un récurvatum ne se distingue pas d'un flessum ; le préciser en note.
- Un seul appareil : pas de synchronisation (prévue éventuellement via iCloud chiffré, sans photos, en version native).
