// GitHub digest (Sara Store, first-party): every morning one card with what's new on the public
// repositories the owner follows (issues and pull requests opened since yesterday, failed checks on
// the default branch) and the pull requests waiting for his review. It reads GitHub's public API
// (api.github.com) without a token: plugin fetches in contract v1 carry no headers, so private
// repositories are not covered; GitHub allows 60 such requests an hour, and a digest uses at most 22.
import { plugin } from './sara-plugin.mjs';

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const USER = /^[A-Za-z0-9-]{1,39}$/;
export const reposOf = (text) => [...new Set(String(text ?? '').split(',').map((s) => s.trim()).filter((s) => REPO.test(s)))].slice(0, 10);

async function getJson(sara, path) {
  const r = await sara.fetch(`https://api.github.com${path}`);
  if (r.status !== 200) throw new Error(`GitHub answered ${r.status} for ${path.split('?')[0]}`);
  return JSON.parse(r.body);
}

export function summarize(repo, items, since) {
  const fresh = items.filter((x) => x.created_at > since);
  const prs = fresh.filter((x) => x.pull_request).length;
  return { repo, issues: fresh.length - prs, prs };
}

async function digest(sara) {
  const repos = reposOf(sara.settings.repos);
  const user = String(sara.settings.user ?? '').trim();
  if (!repos.length && !USER.test(user)) return null;
  const since = (await sara.kv.get('since')) ?? new Date(Date.now() - 86400_000).toISOString();
  const lines = [];
  for (const repo of repos) {
    try {
      const items = await getJson(sara, `/repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=30&since=${encodeURIComponent(since)}`);
      const s = summarize(repo, items, since);
      const runs = await getJson(sara, `/repos/${repo}/actions/runs?per_page=10&status=failure&created=%3E${since.slice(0, 10)}`).catch(() => ({ workflow_runs: [] }));
      const failed = (runs.workflow_runs ?? []).length;
      if (s.issues || s.prs || failed) lines.push(`${repo}: ${s.issues} new issue${s.issues === 1 ? '' : 's'}, ${s.prs} new pull request${s.prs === 1 ? '' : 's'}${failed ? `, ${failed} failed check${failed === 1 ? '' : 's'}` : ''}`);
    } catch (err) {
      lines.push(`${repo}: ${err.message}`);
    }
  }
  if (USER.test(user)) {
    const r = await getJson(sara, `/search/issues?q=${encodeURIComponent(`is:pr is:open review-requested:${user}`)}&per_page=10`).catch(() => null);
    if (r?.total_count) lines.push(`${r.total_count} pull request${r.total_count === 1 ? '' : 's'} waiting for your review: ${r.items.slice(0, 3).map((x) => x.title.slice(0, 60)).join('; ')}`);
  }
  await sara.kv.set('since', new Date().toISOString());
  return lines;
}

plugin({
  schedules: {
    morning: async (sara) => {
      const lines = await digest(sara);
      if (!lines?.length) return {};
      await sara.card({ title: 'GitHub this morning', lines: lines.slice(0, 12) });
      return {};
    },
  },
});
