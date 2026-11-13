import crypto from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { insertEstablishment, openDatabase } from '../db.js';
import { handleInbound } from '../queue.js';
import { buildServer } from '../server.js';
import { verifyMetaSignature } from '../whatsapp.js';

const previous = {
  secret: process.env.META_APP_SECRET,
  token: process.env.META_VERIFY_TOKEN
};

afterAll(() => {
  process.env.META_APP_SECRET = previous.secret;
  process.env.META_VERIFY_TOKEN = previous.token;
});

describe('sécurité WhatsApp', () => {
  it('vérifie la signature X-Hub-Signature-256', () => {
    const body = Buffer.from('{"ok":true}');
    const secret = 'app-secret';
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    expect(verifyMetaSignature(body, signature, secret)).toBe(true);
    expect(verifyMetaSignature(body, signature, 'autre')).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=00', secret)).toBe(false);
    expect(verifyMetaSignature(body, signature, '')).toBe(false);
  });

  it('refuse un webhook sans signature et répond 200 tout de suite si elle est valide', async () => {
    process.env.META_APP_SECRET = 'app-secret';
    process.env.META_VERIFY_TOKEN = 'verify-token';
    const app = buildServer({
      db: openDatabase(':memory:'),
      google: {},
      whatsapp: { async sendText() {}, async sendReviewAlert() { return { id: '1', truncated: false }; } },
      llm: { async generateDraft() { return { reply: 'x', themes: [], langue: 'fr' }; } },
      now: () => Date.now()
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    try {
      const challenge = await fetch(`http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=12345`);
      expect(await challenge.text()).toBe('12345');

      const denied = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      expect(denied.status).toBe(403);

      const body = JSON.stringify({ entry: [] });
      const signature = `sha256=${crypto.createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
      const accepted = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        body
      });
      expect(accepted.status).toBe(200);
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('ignore un numéro qui n\'est pas celui d\'un patron', async () => {
    const db = openDatabase(':memory:');
    insertEstablishment(db, { name: 'Chez Marco', owner_phone: '33601020304' });
    const sent = [];
    const result = await handleInbound({
      db,
      now: () => Date.now(),
      whatsapp: { async sendText(_to, body) { sent.push(body); } }
    }, { phone: '33699999999', messageId: 'x', type: 'text', text: 'bonjour' });
    expect(result.ignored).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
