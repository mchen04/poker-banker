import { test, expect } from './fixtures';
import { addPlayer, createAccount, current, keepMoneyDraft, newSession, openMoney } from './helpers';

test.use({ serviceWorkers: 'block' });

test('consecutive player forms retain each typed name and save each selection once', async ({ page }) => {
  await createAccount(page);
  await newSession(page, 'Consecutive player names');
  const names = ['Justin', 'Riley', 'Morgan', 'Casey', 'Jordan', 'Avery'];
  for (const name of names) {
    const player = await addPlayer(page, name);
    await expect(page.getByTestId(`player-${player.id}`)).toContainText(name);
    await expect(page.getByText(/edited in another tab|not saved on this device/i)).toHaveCount(0);
  }
  const state = await current(page);
  expect(state.players.map(player => player.display_name).sort()).toEqual([...names].sort());
  expect(new Set(state.players.map(player => player.id)).size).toBe(names.length);
  expect(state.entries).toEqual([]);
});

test('a conflict after closing the form shows a non-storage notice that can be dismissed', async ({ page, context }) => {
  const account = await createAccount(page);
  const session = await newSession(page, 'Closed draft conflict notice');
  const player = await addPlayer(page, 'Shared draft player');
  const key = `${account.banker.id}/${session.session.id}/buy_in/${player.id}`;
  const storedAmount = () => page.evaluate(async key => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const opening = indexedDB.open('poker-banker');
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const reading = database.transaction('drafts').objectStore('drafts').get(key);
        reading.onsuccess = () => resolve(reading.result?.value?.amount);
        reading.onerror = () => reject(reading.error);
      });
    } finally { database.close(); }
  }, key);
  await openMoney(page, player.id);
  await page.getByLabel('Amount', { exact: true }).fill('10');
  await expect.poll(storedAmount).toBe('10');
  const other = await context.newPage();
  try {
    await other.goto(`/?session=${session.session.id}`);
    await openMoney(other, player.id);
    await expect(other.getByLabel('Amount', { exact: true })).toHaveValue('10');
    await other.getByLabel('Amount', { exact: true }).fill('25');
    await expect.poll(storedAmount).toBe('25');
    await other.evaluate(async key => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const opening = indexedDB.open('poker-banker');
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      const transaction = database.transaction('drafts', 'readwrite');
      const store = transaction.objectStore('drafts');
      let released = false;
      const completed = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onabort = transaction.onerror = () => { database.close(); reject(transaction.error); };
      });
      (window as unknown as { __releaseDraftLock: () => Promise<void> }).__releaseDraftLock = () => { released = true; return completed; };
      await new Promise<void>((resolve, reject) => {
        let first = true;
        const cycle = () => {
          const reading = store.get(key);
          reading.onsuccess = () => {
            if (first) { first = false; resolve(); }
            if (!released) cycle();
          };
          reading.onerror = () => reject(reading.error);
        };
        cycle();
      });
    }, key);
    await page.getByLabel('Amount', { exact: true }).fill('50');
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('50');
    await keepMoneyDraft(page);
    await other.evaluate(async () => { await (window as unknown as { __releaseDraftLock?: () => Promise<void> }).__releaseDraftLock?.(); });
    const notice = page.getByTestId('draft-conflict-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('This draft was edited in another tab. Review the latest draft and submit again.');
    await expect(page.getByRole('button', { name: 'Retry saving draft', exact: true })).toHaveCount(0);
    await expect(page.getByText('Not saved on this device.', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Not saved yet', exact: true })).toHaveCount(0);
    expect((await current(page)).entries).toEqual([]);
    expect(await storedAmount()).toBe('25');
    await notice.getByRole('button', { name: 'Dismiss draft change notice', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await openMoney(page, player.id);
    await expect(page.getByLabel('Amount', { exact: true })).toHaveValue('25');
    await expect(page.getByText(/edited in another tab|not saved on this device/i)).toHaveCount(0);
    await keepMoneyDraft(page);
    await expect(page.getByTestId('draft-conflict-notice')).toHaveCount(0);
  } finally {
    await other.evaluate(async () => {
      const owned = window as unknown as { __releaseDraftLock?: () => Promise<void> };
      await owned.__releaseDraftLock?.(); delete owned.__releaseDraftLock;
    }).catch(() => {});
    await other.close();
  }
});
