import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { pathToFileURL } from 'node:url';
import { createDeps } from './deps.js';
import {
  handleNewReview,
  handlePubSub,
  handleWhatsAppWebhook,
  startScheduler
} from './queue.js';
import { logError, logInfo } from './util.js';
import { verifyMetaSignature } from './whatsapp.js';

function sharedSecretOk(provided, expected) {
  if (!expected) return true;
  if (!provided) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function buildServer(deps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(String(challenge ?? ''));
    }
    return res.sendStatus(403);
  });

  app.post('/webhook', (req, res) => {
    const valid = verifyMetaSignature(req.rawBody, req.get('x-hub-signature-256'), process.env.META_APP_SECRET);
    if (!valid) return res.sendStatus(403);
    res.sendStatus(200);
    setImmediate(() => {
      handleWhatsAppWebhook(deps, req.body).catch((error) => logError('whatsapp-webhook', error, {}));
    });
  });

  app.post('/pubsub', (req, res) => {
    const token = req.get('x-pubsub-token') || req.query.token;
    if (!sharedSecretOk(token, process.env.PUBSUB_PUSH_SECRET)) return res.sendStatus(401);
    res.sendStatus(200);
    setImmediate(() => {
      handlePubSub(deps, req.body).catch((error) => logError('pubsub', error, {}));
    });
  });

  app.post('/new-review', (req, res) => {
    if (!sharedSecretOk(req.get('x-webhook-secret'), process.env.NEW_REVIEW_SECRET)) return res.sendStatus(401);
    res.sendStatus(200);
    setImmediate(() => {
      handleNewReview(deps, req.body).catch((error) => logError('new-review', error, {}));
    });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const deps = createDeps();
  const app = buildServer(deps);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    logInfo('server', `Bot avis en écoute sur le port ${port}`);
  });
  startScheduler(deps);
}
