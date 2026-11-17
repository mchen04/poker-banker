import { typeInput } from './input';
import { test, expect } from './fixtures';
import { addPlayer, call, createAccount, newSession } from './helpers';

test('roster searches debounce the final text and wait for exact-name lookup before creating a player', async ({ page }) => {
  await createAccount(page);
  await newSession(page, 'Roster search');
  await addPlayer(page, 'Justin');
  await call(page, '/players', 'POST', { op_id: crypto.randomUUID(), display_name: 'Mike' });
  const searches: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname === '/api/players') searches.push(url.searchParams.get('q') ?? ''); });
  await page.getByRole('button', { name: 'Add player', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Justin, In game', exact: true })).toBeVisible();
  searches.length = 0;
  const search = page.getByLabel('Search players', { exact: true });
  await typeInput(search, 'Justin', { append: true });
  await expect(page.getByRole('button', { name: "Add 'Justin' as new", exact: true })).toBeDisabled();
  await expect(page.getByText('An exact name match already exists.', { exact: false })).toBeVisible();
  expect(searches).toEqual(['Justin']);
  await page.getByRole('button', { name: 'Close sheet', exact: true }).click();
  await page.getByRole('button', { name: 'Players', exact: true }).click();
  await expect(page.getByTestId(/^roster-player-/)).toHaveCount(2);
  searches.length = 0;
  const find = page.getByLabel('Find a player', { exact: true });
  await typeInput(find, 'Mike', { append: true });
  await expect(page.getByTestId(/^roster-player-/)).toHaveCount(1);
  await expect(page.getByTestId(/^roster-player-/)).toContainText('Mike');
  expect(searches).toEqual(['Mike']);
});
