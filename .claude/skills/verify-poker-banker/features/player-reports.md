# Player reports

The roster shows finalized results and outstanding payments by currency. Player detail keeps a renamed player's history, presents five report groupings and explicit filters, and separates missing time or blinds from available values.

## Sub-features

- `reports-roster` searches the reusable roster and opens detail.
- `reports-rename-history` preserves IDs and past sessions after rename.
- `reports-groupings` checks Overall, Location, Game, Weekday and Month.
- `reports-filters` checks location, game, weekday, month, from and to filters.
- `reports-metrics` checks hand-computed money, duration, wins, expenses, blinds and sample variation with sessions used.
- `reports-currencies` keeps USD and JPY buckets separate.
- `reports-display-only` uses Total, Per hour and BB without changing entries, with explicit missing-blind text.

## How to get to it (user POV)

- Choose `Players`, search `Find a player`, then choose a roster row.
- In detail choose `Rename player` or a Past sessions button.
- Under Cash game report choose a grouping or `Filter: Off`; apply or clear filters.
- In Table choose `Total`, `Per hour` or `BB` beside Players.

## Driving it with Playwright

Preconditions:

- Doctor succeeds. The recipe creates its own player and three closed sessions through public API fixture setup.
- The two USD fixtures are independent inputs: +$60 over two hours at a $2 blind with $3 expenses; −$20 over one hour at a $1 blind with $5 expenses. Both are Tuesday games at Home/NLH in November 2026. Fixture setup does not count as UI ledger proof.

- **Check groupings, filters, rename and display.** Save as `.cache/verify-reports.ts`, then run `.claude/skills/verify-poker-banker/scripts/verify.sh recipe .cache/verify-reports.ts --run RUN_ID --context iphone-webkit`. Every expected number below is hand-computable from the declared inputs.

```ts
import { typeInput } from '../e2e/input';
import { expect } from '@playwright/test';
import { fixtureSession, workspaceReady } from '../e2e/helpers';
import type { RecipeContext } from '../.claude/skills/verify-poker-banker/scripts/control';

export default async function ({ page, runId, step, checkState }: RecipeContext) {
  await page.goto('/');
  await workspaceReady(page);
  const first = await fixtureSession(page, undefined, { name: 'Verify report one', day: '2026-11-10', result: '6000', hours: 2, blind: '200', expense: '300' });
  const player = first.players[0]!.id;
  await fixtureSession(page, player, { name: 'Verify report two', day: '2026-11-17', result: '-2000', hours: 1, blind: '100', expense: '500' });
  await page.reload();
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await typeInput(page.getByLabel('Find a player', { exact: true }), 'Report Justin');
  await page.getByTestId(`roster-player-${player}`).click();
  for (const [group, heading] of [['Overall', 'Overall'], ['Location', 'Home'], ['Game', 'NLH'], ['Weekday', 'Tuesday'], ['Month', 'November 2026']] as const) {
    await page.getByRole('button', { name: group, exact: true }).click();
    await expect(page.getByRole('heading', { name: `${heading} · USD`, exact: true })).toBeVisible();
    for (const [key, value] of [['profit_loss_minor', '+$40.00'], ['per_hour_minor', '+$13.33'], ['per_session_minor', '+$20.00'], ['duration_ms', '3 h 00 min'], ['winning_sessions', '1 of 2 (50%)'], ['expenses_minor', '$8.00'], ['net_after_expenses_minor', '+$32.00'], ['big_blinds_per_hour', '+3.33 BB/hour'], ['variation_per_hour_minor', '$35.36'], ['variation_big_blinds_per_hour', '24.75 BB/hour']] as const) await expect(page.getByTestId(`report-${key}`).locator('dd')).toHaveText(value);
    await expect(page.getByTestId('report-profit_loss_minor')).toContainText('2 sessions used');
    await step(`reports-group-${group.toLowerCase()}`);
  }
  await page.getByRole('button', { name: 'Overall', exact: true }).click();
  for (const [label, value, expected, select] of [['Filter location', 'Home', '+$40.00', false], ['Filter game', 'NLH', '+$40.00', false], ['Filter weekday', '2', '+$40.00', true], ['Filter month', '2026-11', '+$40.00', false], ['From date', '2026-11-17', '−$20.00', false], ['To date', '2026-11-10', '+$60.00', false]] as const) {
    await page.getByRole('button', { name: 'Filter: Off', exact: true }).click();
    if (select) await page.getByLabel(label, { exact: true }).selectOption(value);
    else await typeInput(page.getByLabel(label, { exact: true }), value);
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await expect(page.getByTestId('report-profit_loss_minor').locator('dd')).toHaveText(expected);
    if (label === 'Filter weekday') await expect(page.getByRole('button', { name: 'Filter: weekday Tuesday', exact: true })).toBeVisible();
    if (label === 'Filter month') await expect(page.getByRole('button', { name: 'Filter: month November 2026', exact: true })).toBeVisible();
    if (label === 'From date' || label === 'To date') await expect(page.getByTestId('report-variation_per_hour_minor')).toContainText('Unavailable · needs two sessions');
    await step(`reports-filter-${label.toLowerCase().replaceAll(' ', '-')}`);
    await page.getByRole('button', { name: /^Filter: / }).click();
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  }
  const renamed = `Report ${runId.slice(-8)}`;
  await page.getByRole('button', { name: 'Rename player', exact: true }).click();
  await typeInput(page.getByLabel('Player name', { exact: true }), renamed);
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('heading', { name: renamed, exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Verify report one/ }).click();
  await expect(page.getByRole('heading', { name: 'Verify report one', exact: true })).toBeVisible();
  await expect(page.getByTestId(`player-${player}`)).toContainText(renamed);
  const before = (await checkState()).entries;
  await page.getByRole('button', { name: 'Per hour', exact: true }).click();
  await expect(page.getByTestId(`result-${player}`)).toHaveText('+$30.00/hour');
  await page.getByRole('button', { name: 'BB', exact: true }).click();
  await expect(page.getByTestId(`result-${player}`)).toHaveText('+30.00 big blinds');
  await page.getByRole('button', { name: 'Total', exact: true }).click();
  await expect(page.getByTestId(`result-${player}`)).toHaveText('+$60.00 up');
  expect((await checkState()).entries).toEqual(before);
  const yen = await fixtureSession(page, player, { name: 'Verify yen no blind', day: '2026-11-18', result: '40', hours: 1, expense: '5', currency: 'JPY' });
  await page.goto(`/?session=${yen.session.id}`);
  await page.getByRole('button', { name: 'BB', exact: true }).click();
  await expect(page.getByTestId(`result-${player}`)).toHaveText('No big blind set');
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await page.getByTestId(`roster-player-${player}`).click();
  await expect(page.getByRole('heading', { name: 'Overall · USD', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Overall · JPY', exact: true })).toBeVisible();
  const yenBucket = page.getByRole('heading', { name: 'Overall · JPY', exact: true }).locator('..');
  await expect(yenBucket.getByTestId('report-profit_loss_minor').locator('dd')).toHaveText('+¥40');
  await expect(yenBucket.getByTestId('report-big_blinds_per_hour')).toContainText('Unavailable · needs time and big blind');
  await step('reports-currency-buckets-and-unavailable-blind');
}
```

## Gotchas

- Cumulative results and reports use closed sessions only. Reopened games disappear until reclosed.
- The location/game/weekday/month filters match both USD fixtures; date bounds deliberately isolate one. A single retained session must make sample variation unavailable.
- Rates round only at display. Do not compute expected answers from API report output or a screenshot.
- Do not merge currencies. Scope repeated metric test IDs to their currency bucket when more than one exists.
- The recipe exercises missing blind, not missing timing. A missing-timing fixture must explicitly yield No time recorded; it must not be replaced with a zero rate.
