# Profile statistics

The profile cards are repository-hosted SVG files generated from GitHub's public
profile calendar and GraphQL API. They do not depend on an external statistics
image service.

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

- The heatmap and large total come from the same public past-year contribution
  calendar visitors see at `https://github.com/users/lwDavid/contributions`.
  GitHub's visible calendar includes week padding around its past-year period.
  Its dates, levels and sum of daily counts are validated against the heading.
  An unexpected markup change fails the update and preserves the last good cards.
- The public profile calendar is used deliberately: the token-scoped GraphQL
  calendar can return a different total. Its separate `apiTotal` and restricted
  contribution count are retained in the generated JSON for transparency.
- Pull requests, commits, reviews, issues and created repositories use the
  contribution collection's corresponding totals. Visibility follows the workflow
  token over the rolling past twelve months, so private contribution details are
  not included. The card labels these three visible subtotals as public. They need
  not sum to the main total: the public profile calendar can include anonymized
  private activity and other contribution types not visible in those subtotals.
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
