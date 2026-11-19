// U4.22 (docs/HEALTH.md): the Health place, each person's own (a household member's in their own
// space; a child reads theirs and marks doses, src/family.ts). Never the demo. Not in the audit
// trail (its rows would name health things).
//   GET    /api/health-log                         {settings, meds, doses, appts, entries, names, kids, trends, imports}
//   PUT    /api/health-log/settings                {cloudOk?, includeInAsk?, reminders?, namesInAlerts?}
//   POST   /api/health-log/meds                    {name, dose, times[], days?, supply?, perDose?, refilledOn?, notes?}
//   PATCH  /api/health-log/meds/:id · DELETE
//   POST   /api/health-log/doses                   {medId, status}      (taken/skipped now)
//   POST   /api/health-log/doses/:id               {status}             (answers a reminder)
//   POST   /api/health-log/appts                   {title, when, where?, questions?}
//   PATCH  /api/health-log/appts/:id · DELETE · GET /appts/:id/ics
//   POST   /api/health-log/entries                 {text} | {type, name, value, value2?, scale?, unit?, note?, at?}
//   DELETE /api/health-log/entries/:id
//   GET    /api/health-log/series?name=&days=
//   GET    /api/health-log/summary.pdf?from=&to=
//   POST   /api/health-log/import?name=         raw file body: Apple Health / Google Takeout Fit / Garmin (V4.3)
//   DELETE /api/health-log/imports/:id            undo one import
//   GET    /api/health-log/kids/:id                a parent: the child's medicines and doses
//   POST   /api/health-log/kids/:id/meds · PATCH/DELETE /kids/:id/meds/:mid · POST /kids/:id/doses
//   GET    /api/health-log/care                    V5.4 {grants, contacts, checkins, people, caringFor}
//   PUT    /api/health-log/care/grants             {person, doses, checkins} (both false = withdraw) · DELETE /care/grants/:person
//   POST   /api/health-log/care/checkin            {status: ok|notgreat|help} · PUT /care/contacts {contacts}
//   GET    /api/health-log/care/of/:person         a caregiver: only what that person consented to (403 otherwise)
//   GET    /api/health-log/coach                   W4.4 the coach's week (never for a child)
//   POST   /api/health-log/coach/goals/:id         {action: accept|skip}
import { HttpError, readJson, readRaw, SECURITY_HEADERS, send } from '../http.ts';
import { readHealthExport } from '../health-import.ts';
import { trOwner } from '../i18n.ts';
import { careCandidates, careViewOf, caringFor, cleanContacts, setCareGrant } from '../caregiver.ts';
import { HealthError, healthFor, type HealthLog, kidHealth, parseQuick, type Quick } from '../health-log.ts';
import { coachFor, coachGoalAction } from '../health-coach.ts';
import { NEXT, type RouteCtx, type RouteHandler } from './context.ts';

export function createHealthLogRoutes(ctx: RouteCtx): RouteHandler {
  const { app } = ctx;
  const T = (s: string) => trOwner(s, app.settings.get());
  const wrap = <R>(f: () => R): R => {
    try {
      return f();
    } catch (err) {
      if (err instanceof HealthError) throw new HttpError(err.status, T(err.message));
      throw err;
    }
  };
  const id = (v: string | undefined) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'Not found');
    return n;
  };
  const medBody = (b: Record<string, unknown>) => ({
    name: String(b.name ?? ''),
    dose: String(b.dose ?? ''),
    times: Array.isArray(b.times) ? b.times.map(String) : String(b.times ?? '').split(/[,\s]+/).filter(Boolean),
    ...(Array.isArray(b.days) ? { days: b.days.map(Number) } : {}),
    ...(b.supply !== undefined && b.supply !== '' && b.supply !== null ? { supply: Number(b.supply) } : {}),
    ...(b.perDose !== undefined && b.perDose !== '' && b.perDose !== null ? { perDose: Number(b.perDose) } : {}),
    ...(typeof b.refilledOn === 'string' ? { refilledOn: b.refilledOn } : {}),
    ...(typeof b.notes === 'string' ? { notes: b.notes } : {}),
    ...(typeof b.active === 'boolean' ? { active: b.active } : {}),
  });
  const kidsOf = () => {
    const f = app.family;
    if (!f || !f.store.isParent(f.person)) return [];
    return f.people().filter((p) => p.child && p.id !== f.person).map((p) => ({ id: p.id, name: p.name }));
  };
  const withRefill = (h: HealthLog) => h.meds(true).map((m) => ({ ...m, refill: h.refill(m.id) }));
  const q = (req: { url?: string }) => new URL(req.url ?? '/', 'http://x').searchParams;
  return async (req, res, method, parts) => {
    const [a, b, c, d, e] = parts;
    if (a !== 'health-log') return NEXT;
    if (ctx.opts.demo) {
      if (method !== 'GET') await readJson(req).catch(() => undefined);
      throw new HttpError(404, 'Not found');
    }
    const h = healthFor(app);
    const now = app.now().getTime();
    if (!b && method === 'GET') {
      const entries = h.entries({ from: new Date(now - 90 * 86_400_000).toISOString(), limit: 400, manual: true });
      return send(res, 200, {
        settings: h.settings(),
        meds: withRefill(h),
        doses: h.doses({ from: new Date(now - 14 * 86_400_000).toISOString() }),
        appts: h.appts(),
        entries,
        names: [...new Set(entries.filter((x) => typeof x.value === 'number').map((x) => x.name))],
        kids: kidsOf(),
        trends: h.trends(),
        imports: h.imports(),
      });
    }
    if (b === 'settings' && method === 'PUT') {
      if (app.member?.child?.()) throw new HttpError(403, T('A parent turned this off for you.'));
      return send(res, 200, { settings: h.setSettings((await readJson(req)) as never) });
    }
    if (b === 'meds' && !c && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { med: wrap(() => h.addMed(medBody(body))) });
    }
    if (b === 'meds' && c && !d && method === 'PATCH') {
      const body = await readJson(req);
      return send(res, 200, { med: wrap(() => h.updateMed(id(c), medBody({ ...h.med(id(c)), ...body }))) });
    }
    if (b === 'meds' && c && !d && method === 'DELETE') return send(res, 200, { ok: h.removeMed(id(c)) });
    if (b === 'doses' && method === 'POST') {
      const body = await readJson(req);
      const status = body.status === 'skipped' ? 'skipped' : 'taken';
      return send(res, 200, { dose: wrap(() => (c ? h.markDose(id(c), status) : h.logDose(id(String(body.medId)), status))) });
    }
    if (b === 'appts' && !c && method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, { appt: wrap(() => h.addAppt({ title: String(body.title ?? ''), when: String(body.when ?? ''), ...(typeof body.where === 'string' ? { where: body.where } : {}), ...(Array.isArray(body.questions) ? { questions: body.questions.map(String) } : {}) })) });
    }
    if (b === 'appts' && c && !d && method === 'PATCH') {
      const body = await readJson(req);
      return send(res, 200, { appt: wrap(() => h.updateAppt(id(c), body as never)) });
    }
    if (b === 'appts' && c && !d && method === 'DELETE') return send(res, 200, { ok: h.removeAppt(id(c)) });
    if (b === 'appts' && c && d === 'ics' && method === 'GET') {
      const ics = wrap(() => h.ics(id(c)));
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="appointment.ics"', 'cache-control': 'no-store' });
      return void res.end(ics);
    }
    if (b === 'entries' && !c && method === 'POST') {
      const body = await readJson(req);
      const quick: Quick | undefined = typeof body.text === 'string' ? parseQuick(body.text) : undefined;
      if (typeof body.text === 'string' && !quick) throw new HttpError(400, T('Try “headache 6/10”, “mood 7/10”, “slept 7h”, “BP 128/82” or “weight 172 lb”.'));
      const draft = quick ?? ({ type: body.type, name: String(body.name ?? ''), value: typeof body.value === 'number' ? body.value : undefined, value2: typeof body.value2 === 'number' ? body.value2 : undefined, scale: typeof body.scale === 'number' ? body.scale : undefined, unit: typeof body.unit === 'string' ? body.unit : undefined } as Quick);
      return send(res, 200, { entry: wrap(() => h.addEntry({ ...draft, ...(typeof body.note === 'string' && body.note ? { note: body.note } : {}), ...(typeof body.at === 'string' ? { at: body.at } : {}) })) });
    }
    if (b === 'entries' && c && method === 'DELETE') return send(res, 200, { ok: h.removeEntry(id(c)) });
    // V4.3: a health export from a watch or phone app (read in memory here, never kept as a file).
    if (b === 'import' && !c && method === 'POST') {
      const name = q(req).get('name') ?? '';
      const buf = await readRaw(req, 512 * 1024 * 1024);
      if (!buf.length) throw new HttpError(400, T('Pick a file first.'));
      let read;
      try {
        read = await readHealthExport(name, buf, { tz: app.settings.get().timeZone || undefined });
      } catch (err) {
        if (err instanceof HealthError) throw new HttpError(err.status, T(err.message));
        throw err;
      }
      return send(res, 200, wrap(() => h.importReadings(read.readings, read.source, name)));
    }
    if (b === 'imports' && c && !d && method === 'DELETE') return send(res, 200, { removed: wrap(() => h.removeImport(id(c))) });
    if (b === 'series' && method === 'GET') {
      const sp = q(req);
      return send(res, 200, { points: h.series(String(sp.get('name') ?? ''), Math.max(1, Math.min(365, Number(sp.get('days')) || 30))) });
    }
    if (b === 'summary.pdf' && method === 'GET') {
      const sp = q(req);
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      const to = iso.test(sp.get('to') ?? '') ? sp.get('to')! : new Date(now).toISOString().slice(0, 10);
      const from = iso.test(sp.get('from') ?? '') ? sp.get('from')! : new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
      if (from > to) throw new HttpError(400, T('The start date is after the end date.'));
      const who = app.member ? (app.member.record()?.name ?? '') : (app.settings.get().ownerName ?? '');
      const pdf = h.summaryPdf(from, to, who);
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="health-summary-${from}-${to}.pdf"`, 'content-length': pdf.length, 'cache-control': 'no-store' });
      return void res.end(pdf);
    }
    // W4.4 the health coach: adults only, each their own.
    if (b === 'coach') {
      if (app.member?.child?.()) throw new HttpError(403, T('The health coach is for adults.'));
      if (!c && method === 'GET') return send(res, 200, wrap(() => coachFor(app)));
      if (c === 'goals' && d && method === 'POST') {
        const body = await readJson(req);
        if (body.action !== 'accept' && body.action !== 'skip') throw new HttpError(400, T('Pick accept or skip.'));
        return send(res, 200, wrap(() => coachGoalAction(app, decodeURIComponent(d), body.action as 'accept' | 'skip')));
      }
    }
    // V5.4 caregivers: the person's own consent, check-ins and family to call; a caregiver's view.
    if (b === 'care') {
      const page = () => ({ child: !!app.member?.child?.(), grants: h.care().grants.map(({ told: _t, ...g }) => g), contacts: h.care().contacts, checkins: h.checkins(7), people: careCandidates(app), caringFor: caringFor(app) });
      if (!c && method === 'GET') return send(res, 200, page());
      if (c === 'grants' && !d && method === 'PUT') {
        const body = await readJson(req);
        wrap(() => setCareGrant(app, body));
        return send(res, 200, page());
      }
      if (c === 'grants' && d && method === 'DELETE') {
        h.removeCareGrant(d);
        return send(res, 200, page());
      }
      if (c === 'checkin' && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { checkin: wrap(() => h.checkIn(String(body.status ?? '') as never)), checkins: h.checkins(7) });
      }
      if (c === 'contacts' && method === 'PUT') {
        const body = await readJson(req);
        return send(res, 200, { contacts: h.setCare({ ...h.care(), contacts: cleanContacts(body.contacts) }).contacts });
      }
      if (c === 'of' && d && method === 'GET') return send(res, 200, wrap(() => careViewOf(app, d)));
    }
    // A parent and a child's medicines (the child's own space; symptoms and mood stay the child's).
    if (b === 'kids' && c) {
      const k = wrap(() => kidHealth(app, c));
      if (!d && method === 'GET') return send(res, 200, k.parentView());
      if (d === 'meds' && !e && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { med: wrap(() => k.addMed({ ...medBody(body), managedBy: 'parent' })) });
      }
      if (d === 'meds' && e && method === 'PATCH') {
        const body = await readJson(req);
        return send(res, 200, { med: wrap(() => k.updateMed(id(e), medBody({ ...k.med(id(e)), ...body }))) });
      }
      if (d === 'meds' && e && method === 'DELETE') return send(res, 200, { ok: k.removeMed(id(e)) });
      if (d === 'doses' && method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, { dose: wrap(() => k.logDose(id(String(body.medId)), body.status === 'skipped' ? 'skipped' : 'taken')) });
      }
    }
    throw new HttpError(404, 'Not found');
  };
}
