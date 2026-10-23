import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const THEMES = {
  light: { background: '#f8faf8', border: '#d5e1da', text: '#142d29', secondary: '#4c665f', muted: '#637d73', heat: ['#e4ece7', '#bbdfcc', '#7dbb9b', '#428c6a', '#176746'], languages: ['#247557', '#467f91', '#8e9851', '#8681a8', '#acbdb6'] },
  dark: { background: '#131e27', border: '#293942', text: '#f0f4f2', secondary: '#acbdc5', muted: '#7f949f', heat: ['#1f3038', '#285b50', '#398b70', '#62b998', '#a3e2c4'], languages: ['#9bd9ba', '#8cbfc9', '#c3cba2', '#aaafca', '#526b74'] },
};
const LEVELS = ['NONE', 'FIRST_QUARTILE', 'SECOND_QUARTILE', 'THIRD_QUARTILE', 'FOURTH_QUARTILE'];
const COLLECTION = `
  contributionsCollection(from: $from, to: $to) {
    totalCommitContributions totalPullRequestContributions
    totalPullRequestReviewContributions totalIssueContributions totalRepositoryContributions
    restrictedContributionsCount
    contributionCalendar {
      totalContributions
      weeks { contributionDays { date weekday contributionCount contributionLevel } }
    }
  }`;
const REPOSITORIES = `
  repositories(first: 100, after: $after, privacy: PUBLIC, ownerAffiliations: OWNER,
    orderBy: {field: NAME, direction: ASC}) {
    nodes {
      name
      languages(first: 100, orderBy: {field: SIZE, direction: DESC}) {
        edges { size node { name } }
        pageInfo { hasNextPage endCursor }
      }
    }
    pageInfo { hasNextPage endCursor }
  }`;

export function periodFor(now) {
  const to = new Date(now);
  if (!Number.isFinite(to.getTime())) throw new Error('Invalid update date');
  const from = new Date(to);
  from.setUTCFullYear(to.getUTCFullYear() - 1);
  if (from.getUTCMonth() !== to.getUTCMonth()) from.setUTCDate(0);
  return { from: from.toISOString(), to: to.toISOString() };
}

async function githubRequest(query, variables, token) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'lwDavid-profile-updater' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === 2) throw new Error(`GitHub request failed: ${error.cause?.code ?? error.name}`);
    }
    if (response?.ok) {
      const payload = await response.json();
      if (payload.errors?.length) throw new Error(`GitHub GraphQL: ${payload.errors.map(error => error.message).join('; ')}`);
      if (!payload.data) throw new Error('GitHub returned no data');
      return payload.data;
    }
    if (response && ![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`GitHub returned HTTP ${response.status}`);
    if (attempt === 2) throw new Error(`GitHub returned HTTP ${response?.status ?? 'unavailable'}`);
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

function nextCursor(connection, previous, label) {
  if (!connection?.pageInfo) throw new Error(`Missing pagination for ${label}`);
  if (!connection.pageInfo.hasNextPage) return null;
  const cursor = connection.pageInfo.endCursor;
  if (!cursor || cursor === previous) throw new Error(`Invalid pagination for ${label}`);
  return cursor;
}

export async function fetchProfileData({ login, token, now = new Date(), request = githubRequest }) {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login)) throw new Error('Invalid GitHub login');
  if (!token) throw new Error('GITHUB_TOKEN is required; run the update workflow on GitHub Actions');
  const period = periodFor(now);
  const totals = new Map();
  let collection;
  let after = null;
  let repositoryCount = 0;
  do {
    const query = collection
      ? `query($login: String!, $after: String) { user(login: $login) { ${REPOSITORIES} } }`
      : `query($login: String!, $after: String, $from: DateTime!, $to: DateTime!) { user(login: $login) { ${COLLECTION} ${REPOSITORIES} } }`;
    const result = await request(query, { login, after, ...(!collection ? period : {}) }, token);
    if (!result.user) throw new Error(`GitHub user ${login} was not found`);
    collection ??= result.user.contributionsCollection;
    const repositories = result.user.repositories;
    if (!Array.isArray(repositories?.nodes)) throw new Error('Missing repository data');
    for (const repository of repositories.nodes) {
      if (!repository) throw new Error('Incomplete repository data');
      repositoryCount++;
      let languages = repository.languages;
      let languageCursor = null;
      do {
        if (!Array.isArray(languages?.edges)) throw new Error(`Missing languages for ${repository.name}`);
        for (const edge of languages.edges) {
          if (!edge?.node?.name || !Number.isSafeInteger(edge.size) || edge.size < 0) throw new Error('Invalid language size');
          totals.set(edge.node.name, (totals.get(edge.node.name) ?? 0) + edge.size);
        }
        languageCursor = nextCursor(languages, languageCursor, repository.name);
        if (languageCursor) {
          const more = await request(`query($login: String!, $name: String!, $after: String!) {
            repository(owner: $login, name: $name) {
              languages(first: 100, after: $after, orderBy: {field: SIZE, direction: DESC}) {
                edges { size node { name } } pageInfo { hasNextPage endCursor }
              }
            }
          }`, { login, name: repository.name, after: languageCursor }, token);
          languages = more.repository?.languages;
        }
      } while (languageCursor);
    }
    after = nextCursor(repositories, after, 'repositories');
  } while (after);
  const data = {
    login, updatedAt: new Date(now).toISOString(), period,
    contributions: {
      total: collection?.contributionCalendar?.totalContributions,
      pullRequests: collection?.totalPullRequestContributions,
      commits: collection?.totalCommitContributions,
      reviews: collection?.totalPullRequestReviewContributions,
      issues: collection?.totalIssueContributions,
      repositories: collection?.totalRepositoryContributions,
      restrictedContributions: collection?.restrictedContributionsCount,
      weeks: collection?.contributionCalendar?.weeks,
    },
    languages: { repositoryCount, includesForks: true, bytes: Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b))) },
  };
  validateData(data);
  return data;
}

export function validateData(data) {
  if (!data?.login || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('Invalid profile metadata');
  if (!Number.isFinite(Date.parse(data.period?.from)) || !Number.isFinite(Date.parse(data.period?.to))) throw new Error('Invalid contribution period');
  let expectedDate = Date.parse(`${data.period.from.slice(0, 10)}T00:00:00Z`);
  const lastDate = Date.parse(`${data.period.to.slice(0, 10)}T00:00:00Z`);
  if (lastDate < expectedDate || lastDate - expectedDate > 366 * 86_400_000) throw new Error('Invalid contribution period');
  const c = data.contributions;
  for (const key of ['total', 'pullRequests', 'commits', 'reviews', 'issues', 'repositories']) {
    if (!Number.isSafeInteger(c?.[key]) || c[key] < 0) throw new Error(`Invalid contribution count: ${key}`);
  }
  if (!Array.isArray(c.weeks) || !c.weeks.length || c.weeks.length > 54) throw new Error('Invalid contribution calendar');
  let sum = 0;
  let previousDate = '';
  for (const week of c.weeks) {
    if (!Array.isArray(week.contributionDays) || !week.contributionDays.length || week.contributionDays.length > 7) throw new Error('Incomplete calendar week');
    for (const day of week.contributionDays) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || day.date <= previousDate || !Number.isFinite(Date.parse(day.date))) throw new Error('Invalid calendar date order');
      if (Date.parse(`${day.date}T00:00:00Z`) !== expectedDate) throw new Error('Calendar contains missing or out-of-period dates');
      if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6 || new Date(`${day.date}T00:00:00Z`).getUTCDay() !== day.weekday) throw new Error('Invalid calendar weekday');
      if (!Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0 || !LEVELS.includes(day.contributionLevel)) throw new Error('Invalid calendar contribution');
      sum += day.contributionCount;
      previousDate = day.date;
      expectedDate += 86_400_000;
    }
  }
  if (sum !== c.total) throw new Error('Calendar total does not match daily contributions');
  if (expectedDate !== lastDate + 86_400_000) throw new Error('Calendar does not cover the entire contribution period');
  if (!data.languages || !Number.isSafeInteger(data.languages.repositoryCount) || data.languages.repositoryCount < 0 || data.languages.includesForks !== true || !data.languages.bytes) throw new Error('Missing language data');
  for (const bytes of Object.values(data.languages.bytes)) if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid language total');
}

export function languageShares(bytes) {
  const sorted = Object.entries(bytes).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = sorted.reduce((sum, [, count]) => sum + count, 0);
  const result = sorted.slice(0, 4);
  if (sorted.length > 4) result.push(['Other', sorted.slice(4).reduce((sum, [, count]) => sum + count, 0)]);
  // Largest-remainder rounding keeps displayed percentages at exactly 100.0%.
  const tenths = result.map(([, count]) => Math.floor(count / total * 1000));
  const order = result.map(([, count], index) => ({ index, remainder: count / total * 1000 - tenths[index] })).sort((a, b) => b.remainder - a.remainder);
  const remaining = 1000 - tenths.reduce((sum, count) => sum + count, 0);
  for (let i = 0; i < remaining && order.length; i++) tenths[order[i].index]++;
  return result.map(([name, count], index) => ({ name, count, share: count / total, percentage: (tenths[index] / 10).toFixed(1) }));
}

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const number = value => value.toLocaleString('en-US');
const dateLabel = value => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
function text(x, y, content, color, size = 13, options = '') {
  return `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" ${options}>${escape(content)}</text>`;
}
function frame(id, title, description, body, theme, x = 0, y = 0) {
  return `<svg xmlns="http://www.w3.org/2000/svg" x="${x}" y="${y}" width="440" height="310" viewBox="0 0 440 310" fill="none" role="img" aria-labelledby="${id}-title ${id}-desc"><title id="${id}-title">${escape(title)}</title><desc id="${id}-desc">${escape(description)}</desc><g font-family="${escape(FONT)}"><rect x=".5" y=".5" width="439" height="309" rx="18" fill="${theme.background}" stroke="${theme.border}"/>${text(24, 42, title, theme.text, 23, 'font-weight="600" letter-spacing="-.6"')}${body}</g></svg>`;
}
function activity(data, theme, x = 0, y = 0) {
  const c = data.contributions;
  const displayTotal = number(c.total);
  const totalSize = Math.min(65, 215 / Math.max(displayTotal.length * .58, 1));
  let body = text(24, 116, displayTotal, theme.text, totalSize, 'font-weight="600" letter-spacing="-2"');
  body += text(416, 113, 'public contributions', theme.secondary, 15, 'text-anchor="end"');
  for (const [index, [value, label]] of [[c.pullRequests, 'Pull requests'], [c.commits, 'Commits'], [c.reviews, 'Reviews']].entries()) {
    body += text(24 + index * 138, 164, number(value), theme.text, 24, 'font-weight="600"');
    body += text(24 + index * 138, 185, label, theme.muted, 12);
  }
  const step = Math.min(7.25, 392 / c.weeks.length);
  let previousMonth = '';
  c.weeks.forEach((week, weekIndex) => {
    week.contributionDays.forEach(day => {
      const dx = 24 + weekIndex * step;
      const dy = 224 + day.weekday * 7.25;
      body += `<rect x="${dx.toFixed(2)}" y="${dy.toFixed(2)}" width="5.6" height="5.6" rx="1.5" fill="${theme.heat[LEVELS.indexOf(day.contributionLevel)]}"><title>${day.date}: ${number(day.contributionCount)} public contributions</title></rect>`;
      if (day.date.endsWith('-01') && day.date.slice(0, 7) !== previousMonth && weekIndex < c.weeks.length - 3) {
        body += text(dx, 213, new Date(`${day.date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), theme.muted, 10);
        previousMonth = day.date.slice(0, 7);
      }
    });
  });
  body += text(24, 291, `Past 12 months · Updated ${dateLabel(data.updatedAt)}`, theme.muted, 11);
  theme.heat.forEach((color, index) => { body += `<rect x="${368 + index * 9}" y="282" width="6" height="6" rx="1.4" fill="${color}"/>`; });
  return frame('activity', 'GitHub activity', `${c.total} public contributions in the past twelve months. ${c.pullRequests} pull requests, ${c.commits} commits, ${c.reviews} reviews, ${c.issues} issues and ${c.repositories} repositories created visible to the workflow token. Calendar from GitHub. Updated ${data.updatedAt}.`, body, theme, x, y);
}
function languages(data, theme, x = 0, y = 0) {
  const shares = languageShares(data.languages.bytes);
  let body = '<defs><clipPath id="languages-bar"><rect x="24" y="70" width="392" height="15" rx="7.5"/></clipPath></defs><g clip-path="url(#languages-bar)">';
  let offset = 24;
  shares.forEach((language, index) => {
    const width = language.share * 392;
    body += `<rect x="${offset.toFixed(4)}" y="70" width="${(width + .05).toFixed(4)}" height="15" fill="${theme.languages[index]}"/>`;
    offset += width;
  });
  body += '</g>';
  shares.forEach((language, index) => {
    const baseline = 121 + index * 32;
    body += `<circle cx="29" cy="${baseline - 4}" r="4.5" fill="${theme.languages[index]}"/>`;
    body += text(44, baseline, language.name, theme.secondary, 13, 'font-weight="500"');
    body += text(416, baseline, `${language.percentage}%`, theme.secondary, 13, 'font-weight="500" text-anchor="end"');
  });
  if (!shares.length) body += text(24, 121, 'No public language data yet', theme.secondary);
  body += text(24, 291, 'Public code · includes forks', theme.muted, 11);
  return frame('languages', 'Most used languages', `${shares.map(language => `${language.name} ${language.percentage}%`).join(', ')}. Language shares by code bytes in ${data.languages.repositoryCount} owned public repositories, including forks; not proficiency. Updated ${data.updatedAt}.`, body, theme, x, y);
}

export function renderFiles(data) {
  validateData(data);
  const files = new Map();
  for (const [mode, theme] of Object.entries(THEMES)) {
    files.set(`assets/activity-${mode}.svg`, activity(data, theme));
    files.set(`assets/languages-${mode}.svg`, languages(data, theme));
    for (const mobile of [false, true]) {
      const width = mobile ? 440 : 900;
      const height = mobile ? 664 : 334;
      files.set(`assets/overview-${mobile ? 'mobile-' : ''}${mode}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" role="img" aria-labelledby="overview-title overview-desc"><title id="overview-title">GitHub activity and most used languages</title><desc id="overview-desc">Public GitHub contributions and owned public repository languages, including forks. Updated ${data.updatedAt}.</desc>${activity(data, theme, 0, 24)}${languages(data, theme, mobile ? 0 : 460, mobile ? 354 : 24)}</svg>`);
    }
  }
  files.set('assets/profile-data.json', `${JSON.stringify(data, null, 2)}\n`);
  return files;
}

export function updateReadme(readme, data) {
  const alt = `${number(data.contributions.total)} public GitHub contributions in the past twelve months. Public repository language shares include forks. Updated ${dateLabel(data.updatedAt)}.`;
  const pattern = /(<img\b[^>]*src="\.\/assets\/overview-light\.svg"[^>]*\balt=")[^"]*(")/;
  if (!pattern.test(readme)) throw new Error('README overview image was not found; no files were updated');
  return readme.replace(pattern, (_, prefix, suffix) => `${prefix}${escape(alt)}${suffix}`);
}

export async function writeProfile(data, root = ROOT) {
  // Fetching, validation and rendering all finish before touching tracked files.
  const files = renderFiles(data);
  files.set('README.md', updateReadme(await readFile(resolve(root, 'README.md'), 'utf8'), data));
  for (const [name, content] of files) {
    await mkdir(dirname(resolve(root, name)), { recursive: true });
    await writeFile(resolve(root, name), content);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const data = await fetchProfileData({ login: process.env.PROFILE_LOGIN ?? 'lwDavid', token: process.env.GITHUB_TOKEN });
    await writeProfile(data);
    console.log(`Updated ${data.login}: ${data.contributions.total} contributions; ${data.languages.repositoryCount} public repositories; ${data.updatedAt}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
