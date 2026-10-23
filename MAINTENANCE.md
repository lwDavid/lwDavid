# Profile statistics

The profile cards are repository-hosted SVG files generated from GitHub's GraphQL
API. They do not depend on an external statistics image service.

The **Update profile statistics** workflow runs approximately every six hours,
after changes to its scripts, and on manual dispatch from the Actions tab.
Scheduled runs use the default branch and can be delayed by GitHub. In public
repositories GitHub disables scheduled workflows after 60 days without repository
activity; re-enable the workflow in Actions if that happens.

The workflow's built-in `GITHUB_TOKEN` reads the public profile and commits the
generated files. No personal access token or paid server is required. A failing
API request or invalid response fails the workflow before rendering or committing;
the previous successful images remain available and retain their update date.

## What the numbers mean

- Activity covers the rolling past twelve months, ending at the refresh time.
- The heatmap and total come from `contributionsCollection.contributionCalendar`.
  They follow GitHub's contribution rules, not the recent-events feed. The total
  is validated against the sum of the daily counts.
- Pull requests, commits, reviews, issues and created repositories use the
  contribution collection's corresponding totals. Visibility follows the workflow
  token, so private contribution details are not included. A profile's anonymized
  private contributions can make its calendar total differ from visible subtotals.
- Language shares use code bytes across **all owned public repositories,
  including forks**, preserving the original card's scope. Both repository and
  language connections are paginated. These percentages do not measure skill or
  code personally authored. The four largest languages and an Other group are
  displayed, rounded to a combined 100.0%.
- Every refresh regenerates light/dark activity and language cards, desktop/mobile
  overviews, the README image description, and `assets/profile-data.json`.
- Update timestamps are UTC. GitHub's image caches and its contribution indexing
  can introduce further delay; these cards are periodically refreshed, not live.

## Development

Use Node.js 24, with no third-party dependencies:

```sh
node --test scripts/update-profile.test.mjs
GITHUB_TOKEN=... PROFILE_LOGIN=lwDavid node scripts/update-profile.mjs
```

Keep tokens in the environment, never in tracked files. The workflow tests run on
pull requests with read-only permissions; only trusted push/scheduled/manual runs
can write generated statistics to their branch.
