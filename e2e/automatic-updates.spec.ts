import { test, expect } from './fixtures';
import { createAccount } from './helpers';
import { verifyUpdateJourney } from '../scripts/verify-update-journey';

test('automatic release adoption preserves previous clients, drafts, offline writes and live old tabs', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(900000);
  if (!baseURL) throw new Error('The owned local TLS server is required');
  await createAccount(page);
  const result = await verifyUpdateJourney({ page, browser, baseURL, evidence: info.outputPath('automatic-updates'), tag: info.project.name });
  expect(result?.table).toHaveLength(5);
  expect(result?.compatibility.previousSource).toMatch(/^dc2082b/);
  expect(result?.review?.rows).toHaveLength(4);
  expect(result?.review?.errors).toEqual([]);
});
