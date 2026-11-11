import { test, expect } from '@playwright/test';
import { typeInput } from './input';

test('physical input retains text, prefixes, replacements, and native date segments', async ({ page, context }, testInfo) => {
  if (testInfo.project.name === 'iphone-standalone') await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  });
  await page.setContent('<label>Text<input></label><label>Password<input type="password"></label><label>Search<input type="search"></label><label>Decimal<input inputmode="decimal"></label><label>Notes<textarea></textarea></label><label>Date<input type="date"></label><label>Time<input type="datetime-local" step="1"></label>');
  for (const label of ['Text', 'Password', 'Search', 'Decimal', 'Notes']) {
    const field = page.getByLabel(label, { exact: true });
    await typeInput(field, '1');
    await expect(field).toHaveValue('1');
    await typeInput(field, '2', { append: true });
    await expect(field).toHaveValue('12');
    await typeInput(field, '37.25');
    await expect(field).toHaveValue('37.25');
    await typeInput(field, ' abc-XYZ');
    await expect(field).toHaveValue(' abc-XYZ');
    await typeInput(field, ' appended', { append: true });
    await expect(field).toHaveValue(' abc-XYZ appended');
    await typeInput(field, '');
    await expect(field).toHaveValue('');
  }
  await typeInput(page.getByLabel('Notes', { exact: true }), 'First line\nSecond line');
  await expect(page.getByLabel('Notes', { exact: true })).toHaveValue('First line\nSecond line');
  const date = page.getByLabel('Date', { exact: true });
  await typeInput(date, '2028-02-29');
  await expect(date).toHaveValue('2028-02-29');
  await typeInput(date, '2026-11-10');
  await expect(date).toHaveValue('2026-11-10');
  await typeInput(date, '');
  await expect(date).toHaveValue('');
  const time = page.getByLabel('Time', { exact: true });
  await typeInput(time, '2028-02-29T00:00:00');
  await expect(time).toHaveValue('2028-02-29T00:00');
  await typeInput(time, '2026-11-10T23:07:45');
  await expect(time).toHaveValue('2026-11-10T23:07:45');
  await typeInput(time, '2026-11-10T12:34:00');
  await expect(time).toHaveValue('2026-11-10T12:34');
  await typeInput(time, '');
  await expect(time).toHaveValue('');
});
