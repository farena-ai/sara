// Her: persona, character files and cards, look, avatar, together, gallery, adult mode, companions, phone widgets.
// Moved from src/server.ts unchanged (wave 3); shared state comes from the RouteCtx (src/routes/context.ts).
import { policy } from '../policy-profile.ts';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { deviceLabel } from '../auth.ts';
import { AWAY, CONFLICT, INTIMACY_LEVELS, intimacyLevel, OTHERS, RELATIONSHIP_INFO } from '../bond.ts';
import { CardError, type CardImport, cardPng, cardToCharacter, isPng, MAX_CARD_JSON, MAX_CARD_PNG, parseCardFile, personaToCard, placeholderPicture, portraitPng } from '../character-cards.ts';
import { type CharacterChoices, quickCharacter, RELATIONSHIPS, TALK, VIBES, writeCharacter } from '../character.ts';
import { exportCharacter, parseCharacter, withCharacterVoice } from '../characterfile.ts';
import { bondContext } from '../chat.ts';
import { applyBring, BRING_SOURCE_NAME, BringError, type BringPlan, type BringRead, MAX_BRING_BYTES, MAX_BRING_FILES, MAX_PASTE, planBring, readBring } from '../companion-import/bring.ts';
import { createCompanionDir, newCompanionPersona, retireCompanionDir } from '../companions.ts';
import { galleryEntry, galleryLine, galleryList, NoBrainError } from '../gallery.ts';
import { as400, AVATAR_TYPES, fromPhoneApp, fromSaraApp, HttpError, MAX_AVATAR, MAX_CHARACTER, readJson, readRaw, SECURITY_HEADERS, send } from '../http.ts';
import { expressionFor, leansPlayful, moodLabel } from '../inner.ts';
import { cleanMeta, isAdultOutfit, LOOK_STYLES, type LookMeta, outfitPrompt, OUTFITS, PARTS, PLACES } from '../look.ts';
import { localDate } from '../memory-worker.ts';
import { privateLocalOn } from '../net-guard.ts';
import { fillNames, scrubPersona } from '../packs/scrub.ts';
import { loadPersona, type Persona, SAFETY_BOUNDARIES, validatePersona, withOwnPronouns } from '../persona.ts';
import { talksHere } from '../private-local.ts';
import { detectMinorSexualContent } from '../safety.ts';
import { adultModeOn, type Settings } from '../settings.ts';
import { appearanceFor, DEFAULT_LOOK_IDS, DEFAULT_LOOKS, defaultLookFor, toDefaultLookSetting } from '../default-look.ts';
import { applyArchetype, applyRelationship, applyTalk, ARCHETYPES, fillLife, fillLifeQuick, makeUnique, savePersona, SCENARIOS, surprise, trySamples } from '../studio.ts';
import { ACTIVITIES, type ListId, LISTS } from '../together.ts';
import { GROUP_TITLES, HUMOURS, initiativeToProactive, LIFE_FIELDS, NEVER_CONTROLLING, QUIET_FOCUS, QUIET_FOCUS_SAY, TRAITS } from '../traits.ts';
import { allScenarios, cleanWardrobe, type WardrobeSettings, wardrobeSettings } from '../wardrobe.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createHerRoutes(ctx: RouteCtx): RouteHandler {
  const { app, opts, rootDir, webRoot } = ctx;
  /** The owner's own picture for her, if uploaded (data dir, never the repo). */
  function avatarFile(): string | undefined {
    for (const ext of Object.keys(AVATAR_TYPES)) {
      const f = join(app.dataDir, `avatar.${ext}`);
      if (existsSync(f)) return f;
    }
    return undefined;
  }
  // Phase 57: character cards being previewed (in memory, 15 minutes, up to 5).
  const cardDrafts = new Map<string, { imp: CardImport; png: Buffer | undefined; expires: number }>();
  // C7: companions being brought from another app (in memory, 30 minutes, up to 3; never written or logged).
  const bringDrafts = new Map<string, { read: BringRead; expires: number }>();
  return async (req, res, method, parts) => {
    const [a, b, c] = parts;
    // Phase 31: companions (more than one on this server).
    if (a === 'companions') {
      const cm = opts.companions;
      if (!cm) throw new HttpError(404, 'Not found');
      if (opts.demo && method !== 'GET') throw new HttpError(403, 'Not on the demo server.');
      // Phase 67: companions whose model isn't on this computer show as paused in private local mode.
      const view = () => ({ companions: cm.view(app.companionId ?? 'main').map((x) => ({ ...x, ...(privateLocalOn() && !talksHere(cm.get(x.id)?.app.settings.get() ?? app.settings.get()) ? { pausedLocal: true } : {}) })), planner: app.settings.get().companionPlanner ?? 'shared' });
      if (!b && method === 'GET') return send(res, 200, await view());
      if (!b && method === 'POST') {
        const body = (await readJson(req)) as { name?: unknown; pronouns?: unknown; from?: unknown };
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 40) throw new HttpError(400, 'Give her (or him) a name of up to 40 characters.');
        if (cm.all().length >= 8) throw new HttpError(400, 'Up to 8 companions on one server.');
        if (cm.all().some((c) => c.app.persona.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'There\'s already a companion called {name}.', { params: { name } });
        const pronouns = ['she', 'he', 'they'].includes(String(body.pronouns)) ? String(body.pronouns) : 'she';
        const from = body.from ? cm.get(String(body.from)) : undefined;
        if (body.from && !from) throw new HttpError(400, 'No such companion to copy.');
        const persona = newCompanionPersona(from ? from.app.persona : app.defaultPersonaPath ? loadPersona(app.defaultPersonaPath) : app.persona, name, pronouns, !from);
        const { id, dir } = createCompanionDir(rootDir, persona, app.now());
        try {
          const c = cm.build!(id, dir);
          cm.add(c);
          c.start();
        } catch (err) {
          retireCompanionDir(rootDir, id, app.now());
          throw err;
        }
        return send(res, 200, { ...view(), id });
      }
      // C7: bring your companion from Character.AI, Replika, Kindroid or Nomi (src/companion-import/bring.ts).
      if (b === 'bring' && (c === 'preview' || c === 'import') && !parts[3] && method === 'POST') {
        const bad = (err: unknown) => (err instanceof BringError ? new HttpError(400, err.message, err.params ? { params: err.params } : undefined) : err);
        const now = Date.now();
        for (const [k, v] of bringDrafts) if (v.expires < now) bringDrafts.delete(k);
        if (c === 'preview') {
          const body = await readJson(req, Math.ceil(MAX_BRING_BYTES * 1.4) + 2 * MAX_PASTE);
          const list = Array.isArray(body.files) ? body.files : [];
          if (list.length > MAX_BRING_FILES) throw new HttpError(400, 'Choose up to 10 files at a time.');
          const files = list.map((f) => {
            const o = (f && typeof f === 'object' ? f : {}) as { name?: unknown; data?: unknown };
            return { name: String(o.name ?? 'file').slice(0, 200), bytes: Buffer.from(String(o.data ?? ''), 'base64') };
          });
          const settings = app.settings.get();
          let read: BringRead;
          let plan: BringPlan;
          try {
            read = readBring({ files, text: typeof body.text === 'string' ? body.text : '', source: String(body.source ?? ''), name: typeof body.name === 'string' ? body.name : undefined }, app.now());
            plan = planBring(read, { adultOn: adultModeOn(settings), ownerName: settings.ownerName });
          } catch (err) {
            throw bad(err);
          }
          while (bringDrafts.size >= 3) bringDrafts.delete(bringDrafts.keys().next().value!);
          const token = randomBytes(12).toString('base64url');
          bringDrafts.set(token, { read, expires: now + 30 * 60_000 });
          const p = plan.persona;
          return send(res, 200, {
            token,
            preview: {
              source: read.source,
              sourceName: BRING_SOURCE_NAME[read.source],
              sourceChosen: read.sourceChosen,
              name: p.name,
              pronouns: p.pronouns ?? 'she',
              age: p.age,
              summary: p.summary,
              personality: p.personality.slice(0, 6),
              appearance: p.appearance ?? '',
              greeting: plan.greeting.slice(0, 1200),
              examples: plan.examples.slice(0, 6).map((x) => x.slice(0, 600)),
              memories: plan.memories.map((m) => ({ index: m.index, text: app.redactor.redact(m.text), label: m.label, about: m.about, date: m.date ?? null })),
              conversations: plan.conversations.length,
              messages: plan.messages,
              notes: plan.notes,
              nsfw: plan.nsfw,
              canAdd: Boolean(cm.build) && cm.all().length < 8 && !cm.all().some((x) => x.app.persona.name.toLowerCase() === p.name.toLowerCase()),
            },
          });
        }
        const body = await readJson(req);
        const d = bringDrafts.get(String(body.token ?? ''));
        if (!d) throw new HttpError(404, 'This preview has expired. Choose the files again.');
        if (!cm.build) throw new HttpError(400, 'More companions are not available on this server.');
        if (cm.all().length >= 8) throw new HttpError(400, 'Up to 8 companions on one server.');
        const settings = app.settings.get();
        let plan: BringPlan;
        try {
          const picks = { backstory: body.backstory !== false, greeting: body.greeting !== false, examples: body.examples !== false, ...(Array.isArray(body.memories) ? { memories: body.memories.map(Number).filter(Number.isInteger) } : {}) };
          plan = planBring(d.read, { adultOn: adultModeOn(settings), ownerName: settings.ownerName, picks, name: typeof body.name === 'string' ? body.name : undefined });
        } catch (err) {
          throw bad(err);
        }
        const name = plan.persona.name;
        if (cm.all().some((x) => x.app.persona.name.toLowerCase() === name.toLowerCase())) throw new HttpError(400, 'There\'s already a companion called {name}.', { params: { name } });
        const { id, dir } = createCompanionDir(rootDir, plan.persona as unknown as Record<string, unknown>, app.now());
        let comp;
        try {
          comp = cm.build(id, dir);
          cm.add(comp);
          comp.start();
        } catch (err) {
          retireCompanionDir(rootDir, id, app.now());
          throw err;
        }
        bringDrafts.delete(String(body.token));
        const saved = applyBring(comp.app, d.read, plan, { chats: body.chats === true });
        writeFileSync(join(comp.app.dataDir, 'character-card.json'), JSON.stringify({ spec: 'imported', first_mes: plan.greeting, mes_example: d.read.profile.examples, importedFrom: plan.source, importedAt: app.now().toISOString() }, null, 2) + '\n', { mode: 0o600 });
        return send(res, 200, { ...view(), companion: id, name, ...saved });
      }
      // Phase 66: another companion's face (her own picture or look), for group chat bubbles.
      if (b && c === 'face' && !parts[3] && method === 'GET') {
        const other = cm.get(b);
        if (!other) throw new HttpError(404, 'No such companion.');
        for (const ext of Object.keys(AVATAR_TYPES)) {
          const f = join(other.app.dataDir, `avatar.${ext}`);
          if (!existsSync(f)) continue;
          res.writeHead(200, { 'content-type': AVATAR_TYPES[ext], 'cache-control': 'no-cache', ...SECURITY_HEADERS });
          return void createReadStream(f).pipe(res);
        }
        req.url = '/sara-avatar.jpg';
        return void other.server.emit('request', req, res);
      }
      // Which companion a conversation belongs to (answering another companion's call).
      if (b === 'of' && c && method === 'GET') {
        const owner = cm.byConversation(c);
        if (!owner) throw new HttpError(404, 'Not found');
        return send(res, 200, { id: owner.id, name: owner.app.persona.name });
      }
      if (b === 'planner' && method === 'PUT') {
        const body = (await readJson(req)) as { planner?: unknown };
        if (body.planner !== 'shared' && body.planner !== 'separate') throw new HttpError(400, 'Choose shared or separate.');
        app.settings.update({ companionPlanner: body.planner });
        return send(res, 200, { ...view(), restart: cm.all().length > 1 });
      }
      if (b && !c && method === 'DELETE') {
        if (!cm.get(b)) throw new HttpError(404, 'No such companion.');
        await cm.remove(b).catch((err: Error) => {
          throw new HttpError(400, err.message);
        });
        return send(res, 200, await view());
      }
    }

    // Phase 34: the personality studio. Everything here returns a draft; only PUT /api/persona saves.
    if (a === 'persona' && b === 'studio') {
      const owner = app.settings.get().ownerName?.trim() || 'the owner';
      const draftOf = (v: unknown): Persona => {
        try {
          return validatePersona(v ?? app.persona);
        } catch (err) {
          throw as400(err);
        }
      };
      const tryIt = <T>(f: () => T): T => {
        try {
          return f();
        } catch (err) {
          throw as400(err);
        }
      };
      if (!c && method === 'GET') {
        return send(res, 200, {
          // Phase 114: a word, meaning and sample line per band (UI copy, never sent to the model), the
          // moment the lines answer, the plain group name, and the real first-message limit per band.
          traits: TRAITS.map(({ id, label, group, low, high, tip, examples, steps, when, was }) => ({
            id, label, group, groupTitle: GROUP_TITLES[group], low, high, tip, examples, steps, when, ...(was ? { was } : {}),
            ...(id === 'jealousy' || id === 'possessive' ? { note: NEVER_CONTROLLING } : {}),
            ...(id === 'initiative' ? { limits: [0, 2, 5, 7, 9].map((v) => initiativeToProactive(v)) } : {}),
          })),
          humours: Object.entries(HUMOURS).map(([id, h]) => ({ id, label: h.label, say: h.say })),
          life: LIFE_FIELDS.map(({ id, label, placeholder }) => ({ id, label, placeholder })),
          archetypes: ARCHETYPES.map(({ id, emoji, label, blurb }) => ({ id, emoji, label, blurb })),
          talk: Object.entries(TALK).map(([id, t]) => ({ id, label: t.label })),
          relationships: Object.entries(RELATIONSHIPS).map(([id, r]) => ({ id, label: r.label })),
          scenarios: SCENARIOS.map(({ id, label, text, set }) => ({ id, label, text, set })),
          inCharacter: app.settings.get().persona?.inCharacter ?? 'off',
          // Phase 51: the "Quiet when I'm focused" switch (the work dials are in `traits`).
          quietFocus: { label: QUIET_FOCUS.label, tip: QUIET_FOCUS.tip, say: QUIET_FOCUS_SAY },
          // Phase 35: you and her.
          relationshipTypes: Object.entries(RELATIONSHIPS).map(([id, r]) => ({ id, label: r.label, ...RELATIONSHIP_INFO[id] })),
          away: Object.entries(AWAY).map(([id, x]) => ({ id, label: x.label })),
          conflict: Object.entries(CONFLICT).map(([id, x]) => ({ id, label: x.label })),
          others: Object.entries(OTHERS).map(([id, x]) => ({ id, label: x.label })),
          otherCompanions: bondContext(app).otherCompanions,
          // Explicit levels: only with Adult mode on, and only offered in a web browser.
          intimacy: INTIMACY_LEVELS.filter((l) => !l.adult || (adultModeOn(app.settings.get()) && !fromSaraApp(req))).map(({ id, label, adult }) => ({ id, label, adult })),
        });
      }
      if (c === 'apply' && method === 'POST') {
        const body = await readJson(req);
        let p = draftOf(body.persona);
        if (body.archetype) p = tryIt(() => applyArchetype(p, String(body.archetype), owner));
        if (body.relationship) p = tryIt(() => applyRelationship(p, String(body.relationship), owner));
        if (body.talk) p = tryIt(() => applyTalk(p, String(body.talk), owner));
        return send(res, 200, { persona: p });
      }
      if (c === 'unique' && method === 'POST') return send(res, 200, { persona: makeUnique(draftOf((await readJson(req)).persona)) });
      if (c === 'surprise' && method === 'POST') {
        const body = await readJson(req);
        const pronouns = body.pronouns === 'he' || body.pronouns === 'they' ? body.pronouns : body.pronouns === 'she' ? 'she' : (app.persona.pronouns ?? 'she');
        return send(res, 200, { persona: tryIt(() => surprise({ name: String(body.name ?? '').slice(0, 40), pronouns, relationship: String(body.relationship ?? app.persona.relationship ?? ''), appearance: app.persona.appearance }, owner)) });
      }
      if (c === 'fill' && method === 'POST') {
        const body = await readJson(req);
        const p = draftOf(body.persona);
        return send(res, 200, body.write === true ? await fillLife(app, p) : { persona: fillLifeQuick(p), written: false });
      }
      if (c === 'try' && method === 'POST') {
        const body = await readJson(req);
        const only = Array.isArray(body.scenarios) ? body.scenarios.map(String) : undefined;
        // "Before" is how she was when the owner opened the page (settings save by themselves).
        const before = body.before && typeof body.before === 'object' ? draftOf(body.before) : app.persona;
        return send(res, 200, { samples: await trySamples(app, before, draftOf(body.persona), only, body.set === 'bond' ? 'bond' : body.set === 'work' ? 'work' : 'personality') });
      }
      if (c === 'check' && method === 'PUT') {
        const v = String((await readJson(req)).inCharacter);
        if (v !== 'off' && v !== 'some' && v !== 'every') throw new HttpError(400, 'Choose off, some or every');
        app.settings.update({ persona: { ...app.settings.get().persona, inCharacter: v } });
        return send(res, 200, { inCharacter: v });
      }
      if (c === 'drift' && method === 'GET') {
        const since = new Date(app.now().getTime() - 7 * 86_400_000).toISOString();
        return send(res, 200, { mode: app.settings.get().persona?.inCharacter ?? 'off', week: app.drift?.stats(since) ?? { checks: 0, average: null, drifted: 0 }, recent: app.drift?.recent(10) ?? [] });
      }
    }
    if (a === 'persona' && b === 'choices' && method === 'GET') {
      const pick = (o: Record<string, { label: string }>) => Object.entries(o).map(([id, v]) => ({ id, label: v.label }));
      return send(res, 200, { relationships: pick(RELATIONSHIPS), vibes: pick(VIBES), talk: pick(TALK) });
    }
    if (a === 'persona' && b === 'draft' && method === 'POST') {
      // A draft character from simple choices. Nothing is saved until the owner presses Save.
      const body = await readJson(req);
      const choices: CharacterChoices = {
        name: String(body.name ?? '').trim(),
        pronouns: body.pronouns === 'he' || body.pronouns === 'they' ? body.pronouns : 'she',
        age: Number(body.age) || 28,
        relationship: String(body.relationship ?? 'friend'),
        vibe: String(body.vibe ?? 'warm'),
        talk: String(body.talk ?? 'texting'),
        interests: String(body.interests ?? '').slice(0, 300),
        appearance: String(body.appearance ?? '').slice(0, 600),
        extra: String(body.extra ?? '').slice(0, 1000),
      };
      try {
        if (body.write === true) return send(res, 200, await writeCharacter(app, choices));
        return send(res, 200, { persona: quickCharacter(choices, app.settings.get().ownerName?.trim() || 'the owner'), written: false });
      } catch (err) {
        throw as400(err);
      }
    }
    // Phase 21: the whole character as one file (name, personality, look, voice choice).
    if (a === 'character' && b === 'export' && method === 'GET') {
      const body = JSON.stringify(exportCharacter(app));
      const name = `${app.persona.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'character'}.sara-character.json`;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
      return void res.end(body);
    }
    // Phase 57: character cards (SillyTavern / Character Card V2 and V3, PNG or JSON).
    if (a === 'character' && b === 'card') {
      if (opts.demo) throw new HttpError(403, 'Not in the demo.');
      if (c === 'preview' && method === 'POST') {
        const raw = await readRaw(req, MAX_CARD_PNG);
        if (!raw.length) throw new HttpError(400, 'Choose a character card (a PNG or JSON file).');
        if (!isPng(raw) && raw.length > MAX_CARD_JSON) throw new HttpError(413, 'The character card is too big (up to 2 MB).');
        let imp: CardImport;
        let png: Buffer | undefined;
        try {
          const parsed = parseCardFile(raw);
          // UX 25: the plain picture made when she had no portrait never replaces a real one.
          png = parsed.placeholder ? undefined : parsed.png;
          imp = cardToCharacter(parsed.card, { adultOn: adultModeOn(app.settings.get()), ownerName: app.settings.get().ownerName });
        } catch (err) {
          if (err instanceof CardError) throw new HttpError(400, err.message);
          throw err;
        }
        const now = Date.now();
        for (const [k, v] of cardDrafts) if (v.expires < now) cardDrafts.delete(k);
        while (cardDrafts.size >= 5) cardDrafts.delete(cardDrafts.keys().next().value!);
        const token = randomBytes(12).toString('base64url');
        cardDrafts.set(token, { imp, png, expires: now + 15 * 60_000 });
        const p = imp.persona;
        const cm = opts.companions;
        return send(res, 200, {
          token,
          preview: {
            name: p.name,
            pronouns: p.pronouns ?? 'she',
            age: p.age,
            summary: p.summary,
            personality: p.personality.slice(0, 6),
            greeting: imp.greeting.slice(0, 1200),
            tags: (imp.extras.tags as string[]).slice(0, 12),
            lore: imp.lore.length,
            nsfw: imp.check.nsfw,
            notes: imp.notes,
            picture: png && png.length <= MAX_AVATAR ? `data:image/png;base64,${png.toString('base64')}` : null,
            pictureTooBig: Boolean(png && png.length > MAX_AVATAR),
            canAdd: Boolean(cm?.build) && (cm?.all().length ?? 9) < 8 && !cm?.all().some((x) => x.app.persona.name.toLowerCase() === p.name.toLowerCase()),
          },
        });
      }
      if (c === 'import' && method === 'POST') {
        const body = await readJson(req);
        const d = cardDrafts.get(String(body.token ?? ''));
        if (!d) throw new HttpError(404, 'This preview has expired. Choose the card again.');
        const as = body.as === 'new' ? 'new' : 'this';
        let target = app;
        let created: string | null = null;
        if (as === 'new') {
          const cm = opts.companions;
          if (!cm?.build) throw new HttpError(400, 'More companions are not available on this server.');
          if (cm.all().length >= 8) throw new HttpError(400, 'Up to 8 companions on one server.');
          if (cm.all().some((x) => x.app.persona.name.toLowerCase() === d.imp.persona.name.toLowerCase())) throw new HttpError(400, 'There\'s already a companion called {name}.', { params: { name: d.imp.persona.name } });
          const { id, dir } = createCompanionDir(rootDir, d.imp.persona as unknown as Record<string, unknown>, app.now());
          try {
            const comp = cm.build(id, dir);
            cm.add(comp);
            comp.start();
            target = comp.app;
            created = id;
          } catch (err) {
            retireCompanionDir(rootDir, id, app.now());
            throw err;
          }
        } else {
          savePersona(app, d.imp.persona); // renames her in memories and applies her "Starts conversations" dial
        }
        cardDrafts.delete(String(body.token));
        // Her picture: the card's PNG (the single uploaded picture, like Settings → Look → Upload).
        let picture = false;
        if (d.png && body.picture !== false && d.png.length <= MAX_AVATAR) {
          for (const ext of Object.keys(AVATAR_TYPES)) rmSync(join(target.dataDir, `avatar.${ext}`), { force: true });
          writeFileSync(join(target.dataDir, 'avatar.png'), d.png, { mode: 0o600 });
          picture = true;
        }
        // The lorebook: her own notes (replacing notes from an earlier card).
        let lore = 0;
        if (target.memory && d.imp.lore.length) {
          for (const m of target.memory.list({ kind: 'self', limit: 500 })) if (m.evidence?.startsWith('character card')) target.memory.delete(m.id);
          const day = localDate(target.now().toISOString(), target.settings.get().timeZone);
          for (const e of d.imp.lore) {
            target.memory.add({ kind: 'self', content: `${e.keys.length ? `${e.keys.slice(0, 4).join(', ')}: ` : ''}${e.content}`, conversationId: null, sourceMessageId: null, happenedOn: day, evidence: `character card: ${d.imp.persona.name}${e.name ? ` · ${e.name}` : ''}` });
            lore++;
          }
        }
        writeFileSync(join(target.dataDir, 'character-card.json'), JSON.stringify({ ...d.imp.extras, importedAt: app.now().toISOString() }, null, 2) + '\n', { mode: 0o600 });
        return send(res, 200, { persona: target.persona, companion: created, picture, lore });
      }
      if ((c === 'json' || c === 'png') && (method === 'GET' || (c === 'png' && method === 'POST'))) {
        let extras: Record<string, unknown> = {};
        try {
          const v = JSON.parse(readFileSync(join(app.dataDir, 'character-card.json'), 'utf8')) as unknown;
          if (v && typeof v === 'object' && !Array.isArray(v)) extras = v as Record<string, unknown>;
        } catch {
          /* no card imported before */
        }
        // Phase 127 (§16 Q8): never the owner's name, his notes about the two of them or his hard limits.
        const card = personaToCard(scrubPersona(app.persona, app.settings.get().ownerName).persona, extras, app.now());
        const base = app.persona.name.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'character';
        if (c === 'json') {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${base}.card.json"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
          return void res.end(JSON.stringify(card, null, 2));
        }
        // The picture: one the browser drew from her portrait (POST), her uploaded PNG, a PNG look, or a plain one.
        let picture: Buffer | undefined;
        if (method === 'POST') {
          picture = await readRaw(req, MAX_CARD_PNG);
          if (!isPng(picture)) throw new HttpError(400, 'Send a PNG picture.');
        } else {
          // UX 25: her real portrait as a PNG (her uploaded picture, her current look, or the
          // built-in portrait; JPEGs are converted), and only then a marked plain picture.
          const read = (file: string | undefined) => {
            try {
              return file ? readFileSync(file) : undefined;
            } catch {
              return undefined;
            }
          };
          const uploaded = avatarFile();
          picture = (uploaded ? portraitPng(read(uploaded)) : (portraitPng(read(app.look?.fileOrDefault('sara-portrait.jpg'))) ?? portraitPng(read(join(webRoot, 'sara-portrait.jpg'))))) ?? placeholderPicture(app.persona.name);
        }
        let out: Buffer;
        try {
          out = cardPng(picture, card);
        } catch (err) {
          if (err instanceof CardError) throw new HttpError(400, err.message);
          throw err;
        }
        res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': `attachment; filename="${base}.card.png"`, 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(out);
      }
    }
    if (a === 'character' && b === 'import' && method === 'POST') {
      const body = await readJson(req, MAX_CHARACTER);
      let c: ReturnType<typeof parseCharacter>;
      try {
        c = parseCharacter(body.file);
        // Phase 127: a shared file says {{user}} where the owner's name was; this owner's name goes back in.
        c = { ...c, persona: validatePersona(fillNames(c.persona, app.settings.get().ownerName, c.persona.name)) };
      } catch (err) {
        throw as400(err);
      }
      const parts = { look: body.look !== false, voice: body.voice !== false };
      if (parts.look && c.look && !app.look) throw new HttpError(400, "This server can't show custom looks.");
      // Everything was checked above; now apply.
      const renamed = savePersona(app, c.persona).renamedMemories;
      let lookDone = false;
      if (parts.look && app.look) {
        try {
          if (c.look) app.look.importFiles(c.look, app.now());
          else app.look.reset(); // the file has the default look
          lookDone = true;
        } catch (err) {
          throw new HttpError(409, 'Her name and personality were imported, but not the look: {error}', { params: { error: (err as Error).message } });
        }
      }
      if (parts.voice && c.voice) app.settings.update({ voice: withCharacterVoice(app, c.voice) });
      return send(res, 200, { persona: c.persona, look: lookDone, voice: Boolean(parts.voice && c.voice), renamedMemories: renamed });
    }
    if (a === 'persona' && !b) {
      const file = join(app.dataDir, 'persona.json');
      if (method === 'GET') {
        // The shipped description follows the built-in look that shows (he/they defaults).
        const p = withOwnPronouns(app.persona);
        const appearance = app.look?.custom ? p.appearance : appearanceFor(p.appearance, defaultLookFor(app.settings.get().defaultLook, p.pronouns));
        return send(res, 200, { persona: { ...p, appearance }, custom: existsSync(file), safetyBoundaries: SAFETY_BOUNDARIES });
      }
      if (method === 'PUT') {
        let p: Persona;
        try {
          // A rename takes the shipped character's lines along (src/persona.ts withOwnPronouns).
          p = withOwnPronouns(validatePersona(await readJson(req)));
        } catch (err) {
          throw as400(err);
        }
        // Phase 35: choosing an explicit intimacy level needs Adult mode, from a web browser.
        const level = p.intimacy?.level;
        if (level && intimacyLevel(level)?.adult && level !== app.persona.intimacy?.level) {
          if (fromSaraApp(req)) throw new HttpError(403, 'Explicit levels can only be chosen in a web browser.');
          if (!adultModeOn(app.settings.get())) throw new HttpError(403, 'Explicit levels need Adult mode: turn it on first (Settings → You → Adult mode, in a web browser).');
        }
        const saved = savePersona(app, p);
        return send(res, 200, { persona: p, custom: true, renamedMemories: saved.renamedMemories });
      }
      if (method === 'DELETE') {
        if (!app.defaultPersonaPath) throw new HttpError(404, 'No default character');
        rmSync(file, { force: true });
        app.persona = loadPersona(app.defaultPersonaPath);
        return send(res, 200, { persona: app.persona, custom: false });
      }
    }
    if (a === 'phone' && b === 'widget' && method === 'GET') {
      const s = app.settings.get();
      const now = app.now();
      const st = app.inner && s.persona?.innerLife !== false ? app.inner.get(now) : undefined;
      const expression = st ? expressionFor(st, now, s.timeZone, leansPlayful(app.persona.traits)) : 'default';
      const last = app.store.db
        .prepare("SELECT m.id, m.conversation_id, m.content, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'assistant' AND c.partner IS NULL AND m.content != '' AND (m.meta IS NULL OR m.meta NOT LIKE '%\"importedFrom\"%') ORDER BY m.id DESC LIMIT 1")
        .get() as { id: number; conversation_id: string; content: string; created_at: string } | undefined;
      return send(res, 200, {
        name: app.persona.name,
        ...(st ? { mood: moodLabel(st, now, s.timeZone).mood } : {}),
        face: expression === 'default' ? '/sara-portrait.jpg' : `/sara/portrait-${expression}.jpg`,
        ...(last ? { last: { id: last.id, conversationId: last.conversation_id, text: last.content.replace(/\s+/g, ' ').slice(0, 200), at: last.created_at } } : {}),
      });
    }
    if (a === 'phone' && b === 'inbox' && method === 'GET') {
      const after = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('after') ?? 0) || 0;
      const rows = app.store.db
        .prepare(
          "SELECT m.id, m.conversation_id, m.content, m.created_at, m.meta FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'assistant' AND c.partner IS NULL AND m.id > ? AND (m.meta LIKE '%\"proactive\"%' OR m.meta LIKE '%\"reminder\"%' OR m.meta LIKE '%\"job\"%' OR m.meta LIKE '%\"briefing\"%' OR m.meta LIKE '%\"background\"%') ORDER BY m.id DESC LIMIT 5",
        )
        .all(after) as { id: number; conversation_id: string; content: string; created_at: string; meta: string | null }[];
      const latest = (app.store.db.prepare('SELECT MAX(id) AS n FROM messages').get() as { n: number | null }).n ?? 0;
      const kind = (meta: string | null) => (meta?.includes('"reminder"') ? 'reminder' : meta?.includes('"job"') ? 'job' : 'message');
      return send(res, 200, { latest, name: app.persona.name, messages: rows.reverse().map((r) => ({ id: r.id, conversationId: r.conversation_id, text: r.content.slice(0, 500), at: r.created_at, kind: kind(r.meta) })) });
    }

    if (a === 'sara' && b === 'state' && method === 'GET') {
      const s = app.settings.get();
      const now = app.now();
      if (!app.inner || s.persona?.innerLife === false) return send(res, 200, { enabled: false });
      const st = app.inner.get(now);
      const today = localDate(now.toISOString(), s.timeZone);
      return send(res, 200, { enabled: true, ...moodLabel(st, now, s.timeZone), expression: expressionFor(st, now, s.timeZone, leansPlayful(app.persona.traits)), customAvatar: Boolean(avatarFile()), closeness: Math.round(st.closeness * 100) / 100, day: app.life?.get(today) ?? null, today });
    }
    // Phase 12: her ongoing life threads (owner can see, edit, add and remove them).
    if (a === 'sara' && b === 'threads') {
      const life = app.life;
      if (!life) throw new HttpError(404, 'Not available');
      const today = localDate(app.now().toISOString(), app.settings.get().timeZone);
      const id = Number(c);
      if (!c && method === 'GET') return send(res, 200, life.threads());
      if (!c && method === 'POST') {
        const body = await readJson(req);
        const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
        if (title.length < 3 || title.length > 200) throw new HttpError(400, 'Describe it in 3 to 200 characters.');
        if (detectMinorSexualContent(title)) throw new HttpError(400, 'Not allowed.');
        return send(res, 201, life.addThread(title, today, { byOwner: true }));
      }
      if (Number.isInteger(id) && method === 'PATCH') {
        const body = await readJson(req);
        const title = body.title === undefined ? undefined : String(body.title).replace(/\s+/g, ' ').trim();
        if (title !== undefined && (title.length < 3 || title.length > 200)) throw new HttpError(400, 'Describe it in 3 to 200 characters.');
        const status = body.status === 'done' || body.status === 'active' ? body.status : undefined;
        const t = life.updateThread(id, { ...(title ? { title } : {}), ...(status ? { status } : {}) });
        if (!t) throw new HttpError(404, 'Not found');
        return send(res, 200, t);
      }
      if (Number.isInteger(id) && method === 'DELETE') {
        if (!life.deleteThread(id)) throw new HttpError(404, 'Not found');
        return send(res, 200, { ok: true });
      }
    }
    // Phase 37: things to do together, and the shared lists.
    if (a === 'together' && app.together) {
      const tg = app.together;
      const view = () => ({ activities: ACTIVITIES.map(({ id, label, emoji, blurb, start, topic }) => ({ id, label, emoji, blurb, start, topic: topic ?? null })), lists: Object.entries(LISTS).map(([id, l]) => ({ id, ...l })), items: tg.items() });
      if (!b && method === 'GET') return send(res, 200, view());
      if (b === 'items' && !c && method === 'POST') {
        const body = await readJson(req);
        try {
          tg.add(String(body.list ?? '') as ListId, String(body.title ?? ''), typeof body.note === 'string' ? body.note : null, 'owner');
        } catch (err) {
          throw as400(err);
        }
        return send(res, 200, view());
      }
      const id = Number(c);
      if (b === 'items' && Number.isInteger(id)) {
        if (method === 'PUT') {
          const body = await readJson(req);
          if (!tg.setDone(id, body.done !== false)) throw new HttpError(404, 'Not found');
          return send(res, 200, view());
        }
        if (method === 'DELETE') {
          if (!tg.remove(id)) throw new HttpError(404, 'Not found');
          return send(res, 200, view());
        }
      }
    }
    if (a === 'look') {
      const look = app.look;
      if (!look) throw new HttpError(404, 'Not available');
      // Phase 36: adults-only looks are listed only with Adult mode on, and never in the apps.
      const adultOk = () => adultModeOn(app.settings.get()) && !fromSaraApp(req);
      const view = async () => {
        const w = wardrobeSettings(app);
        const plan = await app.wardrobe?.plan().catch(() => undefined);
        return {
          custom: look.custom,
          // The built-in looks (Sara, he, they): which one shows until a custom look exists.
          defaults: DEFAULT_LOOK_IDS.map((id) => ({ id, label: DEFAULT_LOOKS[id].label })),
          defaultLook: toDefaultLookSetting(app.settings.get().defaultLook),
          defaultShown: defaultLookFor(app.settings.get().defaultLook, app.persona.pronouns),
          defaultMatch: defaultLookFor('auto', app.persona.pronouns),
          defaultOffered: app.settings.get().defaultLookOffered ?? null,
          missing: look.missingFrames().length,
          status: look.status,
          hasDraft: Boolean(look.draftBytes()),
          draft: look.draftBytes() ? look.draftMeta() : null,
          styles: Object.keys(LOOK_STYLES),
          uploaded: Boolean(avatarFile()),
          outfits: Object.entries(OUTFITS).map(([id, o]) => ({ id, label: o.label })),
          places: Object.entries(PLACES).map(([id, o]) => ({ id, label: o.label })),
          parts: Object.entries(PARTS).map(([id, o]) => ({ id, label: o.label, options: o.options ?? [] })),
          saved: look.saved().filter((x) => adultOk() || !x.adult),
          current: look.currentSavedId() ?? null,
          wearing: look.custom ? look.currentMeta() : {},
          faceLock: app.settings.get().faceLock !== false,
          hasFace: Boolean(look.faceRef()) || existsSync(look.faceFile),
          wardrobe: { ...w, manual: w.manual && Date.parse(w.manual.until) > app.now().getTime() ? w.manual : undefined },
          scenarios: allScenarios(w),
          active: plan?.active ?? [],
          pick: plan?.pick ? { id: plan.pick.look.id, name: plan.pick.look.name, scenario: plan.pick.scenario } : null,
          last: app.wardrobe?.last ?? null,
        };
      };
      if (!b && method === 'GET') return send(res, 200, await view());
      if (!b && method === 'DELETE') {
        look.reset();
        return send(res, 200, await view());
      }
      if (b === 'draft' && method === 'POST') {
        const body = await readJson(req);
        const appearance = String(body.appearance ?? '');
        if (/\b(child|kid|minor|teen|underage|toddler|1[0-7] ?(yo|years? old))\b/i.test(appearance)) throw new HttpError(400, 'The look must be an adult.');
        look.draft(appearance, String(body.style ?? 'illustrated')).catch(() => {});
        return send(res, 202, await view());
      }
      if (b === 'complete' && method === 'POST') {
        look.complete().then(() => app.events?.publish({ type: 'look' }), () => {});
        return send(res, 202, await view());
      }
      // Phase 21: the current look in another outfit (a draft to accept like any other).
      // Phase 36: optionally somewhere else too; adults-only outfits need Adult mode (web only).
      if ((b === 'outfit' || b === 'tweak' || b === 'place') && method === 'POST') {
        const body = await readJson(req);
        if (look.status.state === 'drafting' || look.status.state === 'building') throw new HttpError(409, 'A picture is already being made.');
        const current = readFileSync(look.fileOrDefault('sara-portrait.jpg') ?? join(webRoot, 'sara-portrait.jpg'));
        try {
          if (b === 'outfit') {
            const outfit = String(body.outfit ?? '').trim();
            const wear = outfitPrompt(outfit);
            if (isAdultOutfit(wear) && !adultOk()) throw new Error(fromSaraApp(req) ? 'Adults-only outfits can only be made in a web browser.' : 'That outfit is adults-only: turn on Adult mode first (Settings → You → Adult mode, in a web browser).');
            const place = typeof body.place === 'string' && body.place ? body.place.slice(0, 200) : undefined;
            if (place && /\b(child|kid|minor|teen|school)\b/i.test(place)) throw new Error('Pick another place.');
            look.outfit(current, outfit, { place, adultOk: adultOk() }).catch(() => {});
          } else if (b === 'tweak') {
            const part = String(body.part ?? '');
            const value = String(body.value ?? '');
            if (!PARTS[part]) throw new Error('Pick what to change.');
            if (!value.trim()) throw new Error('Say how to change it.');
            if (isAdultOutfit(value) && !adultOk()) throw new Error('That change is adults-only: it needs Adult mode (in a web browser).');
            look.tweak(current, part, value).catch(() => {});
          } else {
            const place = String(body.place ?? '').trim();
            if (!place) throw new Error('Pick a place.');
            look.place(current, place).catch(() => {});
          }
        } catch (err) {
          throw as400(err);
        }
        return send(res, 202, await view());
      }
      // Phase 36: face lock and the closet (scenarios per look, dress automatically).
      // Pick a built-in look by name (auto follows her pronouns). A custom look stays until reset.
      if (b === 'default' && method === 'PUT') {
        const body = await readJson(req);
        const patch: Partial<Settings> = {};
        if ('look' in body) patch.defaultLook = toDefaultLookSetting(body.look);
        if (typeof body.offered === 'string') patch.defaultLookOffered = body.offered.slice(0, 10);
        app.settings.update(patch);
        app.events?.publish({ type: 'look' });
        return send(res, 200, await view());
      }
      if (b === 'face-lock' && method === 'PUT') {
        const body = await readJson(req);
        app.settings.update({ faceLock: body.on !== false });
        return send(res, 200, await view());
      }
      if (b === 'wardrobe' && !c && method === 'PUT') {
        const body = await readJson(req);
        try {
          app.settings.update({ wardrobe: cleanWardrobe(body as Partial<WardrobeSettings>, wardrobeSettings(app)) });
        } catch (err) {
          throw as400(err);
        }
        await app.wardrobe?.tick().catch(() => undefined);
        return send(res, 200, await view());
      }
      if (b === 'wardrobe' && c === 'now' && (method === 'POST' || method === 'DELETE')) {
        const body = method === 'POST' ? await readJson(req) : {};
        const w = wardrobeSettings(app);
        if (method === 'DELETE') app.settings.update({ wardrobe: { ...w, manual: undefined } });
        else {
          const sc = String(body.scenario ?? '');
          if (!allScenarios(w).some((x) => x.id === sc)) throw new HttpError(400, 'Pick a scenario.');
          const hours = Math.min(24, Math.max(1, Number(body.hours) || 4));
          app.settings.update({ wardrobe: { ...w, manual: { scenario: sc, until: new Date(app.now().getTime() + hours * 3600_000).toISOString() } } });
        }
        await app.wardrobe?.tick().catch(() => undefined);
        return send(res, 200, await view());
      }
      // Phase 21: saved looks.
      if (b === 'saved' && !c && method === 'POST') {
        const body = await readJson(req);
        try {
          look.save(String(body.name ?? ''), app.now());
        } catch (err) {
          throw as400(err);
        }
        return send(res, 200, await view());
      }
      const sv = /^saved\/([a-f0-9]{12})(\/use|\/meta|\.jpg)?$/.exec(parts.slice(1).join('/'));
      if (sv) {
        if (sv[2] === '/meta' && method === 'PUT') {
          const body = (await readJson(req)) as LookMeta;
          if (body.adult === false && look.saved().find((x) => x.id === sv[1])?.adult && !adultOk()) throw new HttpError(403, 'Change adults-only looks in a web browser with Adult mode on.');
          try {
            look.setMeta(sv[1], cleanMeta(body));
          } catch (err) {
            throw new HttpError(404, (err as Error).message);
          }
          return send(res, 200, await view());
        }
        try {
          if (!sv[2] && method === 'DELETE') {
            look.deleteSaved(sv[1]);
            return send(res, 200, await view());
          }
          if (sv[2] === '/use' && method === 'POST') {
            const target = look.saved().find((x) => x.id === sv[1]);
            if (target?.adult && !adultOk()) throw new Error('This look is adults-only: it needs Adult mode (in a web browser).');
            look.use(sv[1], app.now());
            app.events?.publish({ type: 'look' });
            if (look.missingFrames().length) void look.complete().then(() => app.events?.publish({ type: 'look' }), () => {});
            return send(res, 200, await view());
          }
          if (sv[2] === '.jpg' && method === 'GET') {
            const f = look.savedPortrait(sv[1]);
            const img = readFileSync(f);
            res.writeHead(200, { 'content-type': img[0] === 0x89 ? 'image/png' : 'image/jpeg', 'cache-control': 'private, max-age=3600', ...SECURITY_HEADERS });
            return void res.end(img);
          }
        } catch (err) {
          throw new HttpError(404, (err as Error).message);
        }
      }
      if (b === 'draft.jpg' && method === 'GET') {
        const img = look.draftBytes();
        if (!img) throw new HttpError(404, 'No draft');
        res.writeHead(200, { 'content-type': img[0] === 0x89 ? 'image/png' : 'image/jpeg', 'cache-control': 'no-store', ...SECURITY_HEADERS });
        return void res.end(img);
      }
      if (b === 'build' && method === 'POST') {
        const body = await readJson(req);
        let base: Buffer | undefined;
        if (body.from === 'upload') {
          const f = avatarFile();
          if (!f) throw new HttpError(400, 'Upload a picture first.');
          if (body.consent !== true) throw new HttpError(400, 'Confirm the picture is AI-made, of you, or used with permission.');
          base = readFileSync(f);
        } else base = look.draftBytes();
        if (!base) throw new HttpError(400, 'Make a picture first.');
        const fromUpload = body.from === 'upload';
        look
          .build(base, fromUpload ? { newFace: true, place: 'room' } : undefined)
          .then(() => {
            // The new look replaces any single uploaded picture (which would otherwise keep showing
            // instead of it), and every open window shows it right away.
            for (const ext of Object.keys(AVATAR_TYPES)) rmSync(join(app.dataDir, `avatar.${ext}`), { force: true });
            app.events?.publish({ type: 'look' });
          })
          .catch(() => {});
        return send(res, 202, await view());
      }
    }
    if (a === 'sara' && b === 'avatar') {
      if (method === 'GET') {
        const f = avatarFile();
        if (!f) throw new HttpError(404, 'No custom picture');
        res.writeHead(200, { 'content-type': AVATAR_TYPES[extname(f).slice(1)], 'cache-control': 'no-cache', ...SECURITY_HEADERS });
        return void createReadStream(f).pipe(res);
      }
      if (method === 'PUT') {
        const data = await readRaw(req, MAX_AVATAR);
        const kind = data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'jpg' : data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'png' : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
        if (!kind) throw new HttpError(400, 'Use a JPEG, PNG or WebP picture.');
        for (const ext of Object.keys(AVATAR_TYPES)) rmSync(join(app.dataDir, `avatar.${ext}`), { force: true });
        writeFileSync(join(app.dataDir, `avatar.${kind}`), data, { mode: 0o600 });
        return send(res, 200, { customAvatar: true });
      }
      if (method === 'DELETE') {
        for (const ext of Object.keys(AVATAR_TYPES)) rmSync(join(app.dataDir, `avatar.${ext}`), { force: true });
        return send(res, 200, { customAvatar: false });
      }
    }
    if (a === 'sara' && b === 'day' && method === 'DELETE') {
      // Lets the owner make her "re-live" today (a new day note is written on the next tick).
      const s = app.settings.get();
      app.life?.delete(localDate(app.now().toISOString(), s.timeZone));
      return send(res, 200, { ok: true });
    }
    if (a === 'adult' && !b) {
      const cur = app.settings.get().adultMode ?? { on: false };
      const view = () => {
        const m = app.settings.get().adultMode ?? { on: false };
        return { on: adultModeOn(app.settings.get()), confirmedAt: m.confirmedAt ?? null, canTurnOn: !fromSaraApp(req) && !opts.demo, reason: opts.demo ? 'demo' : fromPhoneApp(req) ? 'app' : null };
      };
      if (method === 'GET') return send(res, 200, await view());
      if (method === 'PUT') {
        const body = await readJson(req);
        if (body.on === true) {
          policy().guard('adultMode', true);
          if (opts.demo) throw new HttpError(403, 'Adult mode is not available in the demo.');
          if (fromSaraApp(req)) throw new HttpError(403, 'Adult mode can only be turned on in a web browser.');
          if (body.confirm18 !== true) throw new HttpError(400, 'Confirm that you are 18 or older to turn on adult mode.');
          app.settings.update({ adultMode: { on: true, confirmedAt: app.now().toISOString(), confirmedFrom: deviceLabel(String(req.headers['user-agent'] ?? '')) } });
        } else {
          app.settings.update({ adultMode: { on: false, ...(cur.confirmedAt ? { confirmedAt: cur.confirmedAt } : {}) } });
        }
        return send(res, 200, await view());
      }
    }
    // Phase 51: ready-made characters to start from (each one a shareable character file).
    if (a === 'gallery') {
      if (!b && method === 'GET') return send(res, 200, { characters: galleryList() });
      if (b && c === 'try' && method === 'POST') {
        const g = galleryEntry(b);
        if (!g) throw new HttpError(404, 'No such character');
        try {
          return send(res, 200, { id: g.id, line: await galleryLine(app, g) });
        } catch (err) {
          // M1: in setup the character comes before the model; a friendly answer, not a logged 500.
          if (err instanceof NoBrainError) throw new HttpError(409, err.message);
          throw err;
        }
      }
      throw new HttpError(404, 'Not found');
    }
    return NEXT;
  };
}
