import { openDatabase } from './db.js';
import { createGoogleProvider } from './google/index.js';
import { createLlm } from './llm.js';
import { createWhatsAppClient } from './whatsapp.js';

export function createDeps(overrides = {}) {
  return {
    db: overrides.db || openDatabase(overrides.databasePath),
    google: overrides.google || createGoogleProvider(overrides.googleOptions),
    whatsapp: overrides.whatsapp || createWhatsAppClient(overrides.whatsappOptions),
    llm: overrides.llm || createLlm(overrides.llmOptions),
    now: overrides.now || (() => Date.now())
  };
}
