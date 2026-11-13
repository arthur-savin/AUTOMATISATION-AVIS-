# AUTOMATISATION-AVIS-

Bot WhatsApp pour un restaurateur qui ne veut pas ouvrir Google : le bot lit les avis de sa fiche, propose une réponse dans son style, et ne publie que lorsqu'il a cliqué **Publier** ou envoyé sa propre version.

Un établissement = une fiche Google Business Profile + le numéro WhatsApp du patron. Plusieurs établissements cohabitent dans la même base.

## Ce que fait le bot

1. **Scan initial.** Il récupère tous les avis (`accounts.locations.reviews.list`, pages de 50). Il garde ceux qui n'ont pas de réponse, négatifs (1 à 3 étoiles) d'abord, puis du plus récent au plus ancien. Les réponses déjà publiées deviennent les premiers exemples de style.
2. **File d'attente.** Un seul avis attend une décision à la fois. Un avis qui vient d'arriver passe devant le backlog. Au plus N publications par jour et par établissement (10 par défaut) : au-delà, la réponse validée part le lendemain, pour ne pas déclencher le filtre anti-spam de Google.
3. **Nouveaux avis.** `POST /pubsub` reçoit les notifications Google (Pub/Sub). `POST /new-review` accepte la même chose depuis Make, Zapier ou un parseur d'e-mails. Un avis déjà répondu est ignoré. Un `reviewId` déjà vu n'est jamais retraité.
4. **Message au patron.** Si il a écrit il y a moins de 24 h, le bot envoie un message interactif avec les boutons Publier, Modifier, Ignorer. Sinon il envoie le template approuvé `alerte_avis`. Les variables n'ont ni saut de ligne, ni tabulation, ni plus de 3 espaces d'affilée. Un avis trop long est coupé avec « … », et le texte complet part dès que la fenêtre de 24 h est ouverte. Une note sans commentaire est annoncée par « Note seule, sans commentaire ».
5. **Apprentissage.** Chaque correction est enregistrée (note, texte, thèmes, brouillon, version finale). Un brouillon publié tel quel est aussi gardé, avec un poids plus faible. Tous les 5 exemples corrigés, Claude réécrit un guide de style de 10 règles maximum. Le brouillon suivant reçoit ce guide et les 3 à 5 exemples les plus proches (même tranche de note, thèmes communs, similarité).
6. **Publication.** Juste avant l'envoi, le bot revérifie que Google n'a toujours pas de réponse. Il publie avec `PUT .../reviews/{reviewId}/reply`. Il confirme « ✅ Réponse envoyée sur Google », puis relit l'avis à 30 minutes et à 24 heures. Si Google refuse, le patron reçoit la raison et une nouvelle proposition. **Ignorer** passe à l'avis suivant sans rien publier.

Le patron peut répondre `STOP` (le backlog se met en pause, les nouveaux avis continuent d'arriver) et `REPRENDRE`. Une question hors sujet reçoit une seule phrase qui rappelle que le bot ne s'occupe que des avis Google.

## Modules

| Fichier | Rôle |
| --- | --- |
| `server.js` | Express : webhooks Meta, Pub/Sub, `/new-review`. Répond 200 tout de suite, traite ensuite. |
| `whatsapp.js` | Signature Meta, template `alerte_avis`, message interactif, troncature. |
| `google/` | `GoogleReviewsProvider` : `GbpApiProvider` (OAuth, API v4) ou `WebhookProvider` (Make/Zapier). |
| `llm.js` | Prompt, choix des exemples, appel Claude, réponse de secours. |
| `db.js` | SQLite (`better-sqlite3`) et migrations. |
| `queue.js` | File, priorités, publication, apprentissage, relances. |
| `prompts/reply-system.md` | Prompt système de rédaction. |

Le choix Google se fait avec `GOOGLE_PROVIDER=api` ou `GOOGLE_PROVIDER=webhook`. Le mode webhook ne sait pas scanner les avis existants : le script d'onboarding échoue avec un message explicite, et les avis entrent alors par `POST /new-review`.

## Installation

```bash
npm install
cp .env.example .env
npm start
npm test
```

Créer un établissement (le téléphone est en format international, sans le `+`) :

```bash
node scripts/add-establishment.js \
  --name "Chez Marco" \
  --phone 33612345678 \
  --account 123456789 \
  --location 987654321 \
  --city Lyon \
  --type restaurant \
  --contact "04 78 00 00 00" \
  --limit 10 \
  --use-env-token
```

`--use-env-token` copie `GOOGLE_REFRESH_TOKEN` dans la fiche. Sans ce drapeau, le jeton d'environnement sert de secours au moment des appels.

Lancer le scan :

```bash
npm run onboard -- --establishment 1
```

Si le patron n'a pas écrit au bot dans les 24 dernières heures, le message de synthèse (« J'ai trouvé X avis sans réponse… ») est mis de côté et part à son prochain message. Les alertes d'avis partent quand même, via le template.

## Variables d'environnement

Tout est dans `.env.example`. Rien de secret n'est écrit dans le code.

| Variable | Rôle |
| --- | --- |
| `PORT`, `DATABASE_PATH`, `BUSINESS_TZ` | Serveur, fichier SQLite, jour des quotas (Europe/Paris). |
| `DEFAULT_DAILY_LIMIT` | Plafond de publications par jour si la fiche n'en impose pas. |
| `META_VERIFY_TOKEN`, `META_APP_SECRET` | Vérification du webhook Meta. Sans secret, toute signature est refusée. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Envoi Cloud API. |
| `TEMPLATE_NAME`, `TEMPLATE_LANG` | Défaut : `alerte_avis`, `fr`. |
| `GOOGLE_PROVIDER` | `api` ou `webhook`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | OAuth, scope `https://www.googleapis.com/auth/business.manage`. |
| `PUBLISH_WEBHOOK_URL` | URL Make/Zapier qui publie la réponse quand `GOOGLE_PROVIDER=webhook`. |
| `PUBSUB_PUSH_SECRET`, `NEW_REVIEW_SECRET` | Secrets optionnels. Vides, les routes restent ouvertes. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Rédaction. Sans clé, une réponse de secours courte est utilisée. |

`POST /pubsub` accepte le secret en en-tête `x-pubsub-token` ou en query `?token=`. `POST /new-review` attend `x-webhook-secret`.

## Google OAuth et Business Profile

1. Dans Google Cloud, créer un projet et activer **My Business Business Information API**, **My Business Account Management API** et **Google My Business API** (reviews v4).
2. Écran de consentement OAuth, scope `https://www.googleapis.com/auth/business.manage`. Le compte Google doit être propriétaire ou gestionnaire de la fiche.
3. Créer un client OAuth « application de bureau ».
4. Récupérer un refresh token (une fois) :

```bash
# Ouvrir dans le navigateur (remplacer CLIENT_ID) :
# https://accounts.google.com/o/oauth2/v2/auth?client_id=CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/business.manage&access_type=offline&prompt=consent
curl -s https://oauth2.googleapis.com/token \
  -d client_id="$GOOGLE_CLIENT_ID" \
  -d client_secret="$GOOGLE_CLIENT_SECRET" \
  -d code="CODE" \
  -d redirect_uri="http://localhost" \
  -d grant_type="authorization_code"
```

5. Trouver les identifiants, avec un access token fraîchement échangé :

```bash
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  https://mybusinessaccountmanagement.googleapis.com/v1/accounts
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/ACCOUNT_ID/locations?readMask=name,title"
```

`google_account_id` est la partie numérique de `accounts/…`. `location_id` est celle de `locations/…`.

L'API v4 utilisée ensuite :

- `GET https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/reviews?pageSize=50`
- `PUT https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/reviews/{reviewId}/reply` avec `{ "comment": "..." }`

Si Google renvoie `reviewReplyState` (`PENDING`, `APPROVED`, `REJECTED`) ou `policyViolation`, le bot les enregistre. S'il ne renvoie pas d'état, il ne devine pas un refus.

## Notifications Pub/Sub

1. Créer un topic, par exemple `projects/PROJECT/topics/gbp-reviews`.
2. Donner le droit `roles/pubsub.publisher` au compte `mybusiness-api-pubsub@system.gserviceaccount.com`.
3. Créer un abonnement push vers `https://VOTRE-DOMAINE/pubsub` (ajouter `?token=` si `PUBSUB_PUSH_SECRET` est défini).
4. Brancher la fiche :

```bash
curl -s -X PATCH \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "https://mybusinessnotifications.googleapis.com/v1/accounts/ACCOUNT_ID/notificationSetting?updateMask=pubsubTopic,notificationTypes" \
  -d '{
    "name": "accounts/ACCOUNT_ID/notificationSetting",
    "pubsubTopic": "projects/PROJECT/topics/gbp-reviews",
    "notificationTypes": ["NEW_REVIEW", "UPDATED_REVIEW"]
  }'
```

Le corps push est le message Pub/Sub habituel : `message.data` est le JSON Google encodé en base64 (`notificationType`, `locationName`, `reviewName`). Le bot relit alors l'avis.

Entrée alternative, même traitement :

```bash
curl -s -X POST https://VOTRE-DOMAINE/new-review \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $NEW_REVIEW_SECRET" \
  -d '{
    "establishmentId": 1,
    "reviewId": "abc",
    "stars": 2,
    "author": "Lina",
    "text": "Longue attente, tiramisu excellent",
    "lang": "fr",
    "createdAt": "2026-05-01T12:00:00.000Z",
    "hasReply": false
  }'
```

## Template WhatsApp

Dans le gestionnaire WhatsApp, créer un modèle :

- Nom : `alerte_avis`
- Catégorie : **UTILITY**
- Langue : Français
- Corps :

```text
Nouvel avis {{1}} pour {{2}}.

Avis : {{3}}

Réponse proposée : {{4}}
```

- Trois boutons de réponse rapide, dans cet ordre : **Publier**, **Modifier**, **Ignorer**.

À l'envoi, le bot remplit les 4 variables (note `4/5`, nom de l'établissement, extrait de l'avis, brouillon) et pose les charges utiles `PUBLISH:<reviewId>`, `EDIT:<reviewId>`, `IGNORE:<reviewId>`.

Webhook Meta :

- URL : `https://VOTRE-DOMAINE/webhook`
- Jeton de vérification : `META_VERIFY_TOKEN`
- Champ abonné : `messages`

Seul un numéro enregistré comme `owner_phone` reçoit une réponse. Les autres messages sont ignorés.

## Données

SQLite crée ses tables au démarrage.

- `establishments` : fiche, téléphone, jetons Google, guide de style, pause du backlog, quota du jour.
- `reviews` : avis, statut (`queued`, `sent_to_owner`, `awaiting_edit`, `published`, `ignored`, `rejected`, et `already_replied` pour un avis déjà traité sur Google), brouillon, réponse finale, état Google.
- `learning_examples` : exemples de style (`edited`, `accepted`, `google_history`).
- `wa_sessions` : dernier message entrant (fenêtre de 24 h) et avis en cours de modification.
- `followups` : contrôles à 30 minutes et 24 heures.
- `wa_inbound` : dédoublonnage des messages Meta.

## Commandes du patron

| Message | Effet |
| --- | --- |
| Bouton Publier | Publie le brouillon, après revérification sur Google. |
| Bouton Modifier, puis un texte | Publie ce texte et l'enregistre comme correction. |
| Bouton Ignorer | N'envoie rien, passe au suivant. |
| `STOP` | Met le backlog en pause. |
| `REPRENDRE` | Relance le backlog. |

## Tests

```bash
npm test
```

Vitest couvre la file et ses priorités, l'idempotence, la troncature des variables de template, le choix des exemples, et le chemin Modifier → publication → exemple enregistré.
