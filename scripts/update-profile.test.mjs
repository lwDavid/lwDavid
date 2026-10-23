import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { periodFor, fetchProfileData, parseGitHubCalendar, validateData, languageShares, renderFiles, updateReadme, writeProfile } from './update-profile.mjs';

const now = new Date('2026-10-24T03:00:00Z');
function fixture() {
  const period = periodFor(now);
  const weeks = [];
  for (let day = new Date(period.from); day <= now; day.setUTCDate(day.getUTCDate() + 1)) {
    const weekday = day.getUTCDay();
    if (!weeks.length || weekday === 0) weeks.push({ contributionDays: [] });
    weeks.at(-1).contributionDays.push({ date: day.toISOString().slice(0, 10), weekday, contributionCount: 1, contributionLevel: 'FIRST_QUARTILE' });
  }
  return {
    login: 'lwDavid', updatedAt: now.toISOString(), period,
    contributions: { total: weeks.flatMap(week => week.contributionDays).length, commits: 20, pullRequests: 30, reviews: 5, issues: 4, repositories: 2, restrictedContributions: 0, weeks },
    languages: { repositoryCount: 3, includesForks: true, bytes: { 'C++': 50, Python: 30, CMake: 5, Shell: 5, HTML: 4, JavaScript: 6 } },
  };
}
const page = (nodes, hasNextPage = false, endCursor = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
const langs = (edges, hasNextPage = false, endCursor = null) => ({ edges: edges.map(([name, size]) => ({ size, node: { name } })), pageInfo: { hasNextPage, endCursor } });
function collection(data = fixture()) {
  const c = data.contributions;
  return { totalCommitContributions: c.commits, totalPullRequestContributions: c.pullRequests, totalPullRequestReviewContributions: c.reviews, totalIssueContributions: c.issues, totalRepositoryContributions: c.repositories, restrictedContributionsCount: c.restrictedContributions, contributionCalendar: { totalContributions: c.total, weeks: c.weeks } };
}
const readme = '<picture><img src="./assets/overview-light.svg" width="900" alt="Old numbers"></picture>\n';
const calendarRequest = async () => {
  const data = fixture();
  return { total: data.contributions.total, weeks: data.contributions.weeks, period: data.period };
};
function calendarHtml() {
  const days = fixture().contributions.weeks.flatMap(week => week.contributionDays);
  // GitHub emits cells in weekday rows, not chronological order.
  days.sort((a, b) => a.weekday - b.weekday || a.date.localeCompare(b.date));
  return `<h2>366 contributions in the last year</h2>${days.map((day, index) => `<td data-date="${day.date}" id="day-${index}" data-level="1"></td><tool-tip for="day-${index}">1 contribution on a day.</tool-tip>`).join('')}`;
}

test('the public calendar parser handles weekday rows and matches the displayed total', () => {
  const parsed = parseGitHubCalendar(calendarHtml());
  assert.equal(parsed.total, 366);
  assert.equal(parsed.weeks[0].contributionDays[0].date, '2025-10-24');
  assert.equal(parsed.weeks.at(-1).contributionDays.at(-1).date, '2026-10-24');
  validateData({ ...fixture(), calendarPeriod: parsed.period, contributions: { ...fixture().contributions, ...parsed } });
});

test('changed or incomplete public calendar markup fails without inventing counts', () => {
  assert.throws(() => parseGitHubCalendar('<h2>New GitHub markup</h2>'), /heading/);
  assert.throws(() => parseGitHubCalendar(calendarHtml().replace('366 contributions in the last year', '367 contributions in the last year')), /total is inconsistent/);
  assert.throws(() => parseGitHubCalendar(calendarHtml().replace('1 contribution on a day.', 'Hidden count')), /missing its count/);
});

test('a leap-day update uses a valid one-year start date', () => {
  assert.equal(periodFor(new Date('2024-02-29T12:00:00Z')).from, '2023-02-28T12:00:00.000Z');
});

test('repository and nested language pagination both contribute to totals', async () => {
  const calls = [];
  const request = async (query, variables) => {
    calls.push({ query, variables });
    if (query.includes('repository(owner:')) return { repository: { languages: langs([['C++', 9]]) } };
    if (variables.after) return { user: { repositories: page([{ name: 'fork', languages: langs([['C++', 7], ['Python', 4]]) }]) } };
    return { user: { contributionsCollection: collection(), repositories: page([{ name: 'main', languages: langs([['C++', 1]], true, 'lang-page-2') }], true, 'repo-page-2') } };
  };
  const data = await fetchProfileData({ login: 'lwDavid', token: 'test-only', now, request, calendarRequest });
  assert.deepEqual(data.languages.bytes, { 'C++': 17, Python: 4 });
  assert.equal(data.languages.repositoryCount, 2);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].variables.after, 'lang-page-2');
  assert.equal(calls[2].variables.after, 'repo-page-2');
  assert.match(calls[0].query, /privacy: PUBLIC, ownerAffiliations: OWNER/);
  assert.doesNotMatch(calls[0].query, /isFork: false/);
});

test('incomplete pagination fails instead of publishing truncated statistics', async () => {
  const request = async () => ({ user: { contributionsCollection: collection(), repositories: page([], true, null) } });
  await assert.rejects(fetchProfileData({ login: 'lwDavid', token: 'test-only', now, request, calendarRequest }), /Invalid pagination/);
});

test('the card follows the public profile calendar when the API total differs', async () => {
  const request = async () => ({ user: { contributionsCollection: { ...collection(), contributionCalendar: { totalContributions: 123 } }, repositories: page([]) } });
  const data = await fetchProfileData({ login: 'lwDavid', token: 'test-only', now, request, calendarRequest });
  assert.equal(data.contributions.total, 366);
  assert.equal(data.contributions.apiTotal, 123);
  await assert.rejects(fetchProfileData({ login: 'lwDavid', token: 'test-only', now, request, calendarRequest: async () => { throw new Error('Public calendar unavailable'); } }), /Public calendar unavailable/);
});

test('an API failure is propagated instead of silently using zeroes', async () => {
  await assert.rejects(fetchProfileData({ login: 'lwDavid', token: 'test-only', now, calendarRequest, request: async () => { throw new Error('HTTP 403'); } }), /HTTP 403/);
  await assert.rejects(fetchProfileData({ login: 'lwDavid', token: '', now }), /GITHUB_TOKEN is required/);
});

test('calendar counts and ordering must match the GitHub total', () => {
  const mismatch = fixture();
  mismatch.contributions.total++;
  assert.throws(() => validateData(mismatch), /Calendar total/);
  const disorder = fixture();
  disorder.contributions.weeks.reverse();
  assert.throws(() => validateData(disorder), /date order|out-of-period dates/);
});

test('a truncated calendar is rejected even if its daily sum matches the total', () => {
  const data = fixture();
  data.contributions.weeks.at(-1).contributionDays.pop();
  data.contributions.total--;
  assert.throws(() => validateData(data), /entire contribution period/);
});

test('zero-valued profiles and repositories without languages render honestly', () => {
  const data = fixture();
  for (const key of ['total', 'pullRequests', 'commits', 'reviews', 'issues', 'repositories']) data.contributions[key] = 0;
  for (const week of data.contributions.weeks) for (const day of week.contributionDays) { day.contributionCount = 0; day.contributionLevel = 'NONE'; }
  data.languages.bytes = {};
  const files = renderFiles(data);
  assert.match(files.get('assets/languages-light.svg'), /No public language data yet/);
  assert.doesNotMatch([...files.values()].join(''), /NaN|Infinity/);
});

test('language ranking groups the tail and rounds to exactly 100 percent', () => {
  const shares = languageShares({ A: 1, B: 1, C: 1, D: 1, E: 1, F: 1 });
  assert.equal(shares.length, 5);
  assert.equal(shares.at(-1).name, 'Other');
  assert.equal(shares.at(-1).count, 2);
  assert.equal(shares.reduce((sum, entry) => sum + Math.round(Number(entry.percentage) * 10), 0), 1000);
  assert.equal(languageShares({ A: 1 })[0].percentage, '100.0');
});

test('all eight SVG variants and the public dataset use the new data', () => {
  const data = fixture();
  const files = renderFiles(data);
  assert.equal(files.size, 9);
  for (const [name, content] of files) {
    if (!name.endsWith('.svg')) continue;
    assert.match(content, /2026-10-24/);
    assert.doesNotMatch(content, /508 public contributions|19 Oct 2026/);
    const ids = [...content.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${name} contains duplicate SVG IDs`);
  }
  assert.match(files.get('assets/overview-light.svg'), /width="900" height="334"/);
  assert.match(files.get('assets/overview-mobile-dark.svg'), /width="440" height="664"/);
  assert.deepEqual(JSON.parse(files.get('assets/profile-data.json')), data);
});

test('language names are escaped before being inserted into SVG markup', () => {
  const data = fixture();
  data.languages.bytes = { 'A<&"': 1 };
  const svg = renderFiles(data).get('assets/languages-light.svg');
  assert.match(svg, /A&lt;&amp;&quot;/);
  assert.doesNotMatch(svg, /A<&"/);
});

test('README alternative text updates while the visitor counter is preserved', () => {
  const source = '<img src="https://count.getloli.com/@lwDavid" alt="Profile views">\n' + readme;
  const updated = updateReadme(source, fixture());
  assert.match(updated, /366 contributions on GitHub/);
  assert.match(updated, /Updated 24 Oct 2026/);
  assert.equal(updated.split('\n')[0], source.split('\n')[0]);
  assert.throws(() => updateReadme('README without a card', fixture()), /was not found/);
});

test('failed validation or a missing README marker preserves all existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'profile-stats-test-'));
  try {
    await writeFile(join(root, 'README.md'), 'No card');
    await assert.rejects(writeProfile(fixture(), root), /was not found/);
    assert.deepEqual(await readdir(root), ['README.md']);
    await writeFile(join(root, 'README.md'), readme);
    const data = fixture();
    data.contributions.total++;
    await assert.rejects(writeProfile(data, root), /Calendar total/);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), readme);
    assert.deepEqual(await readdir(root), ['README.md']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
