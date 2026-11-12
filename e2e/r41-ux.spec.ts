import { test } from './fixtures';
import { createAccount } from './helpers';
import { uxCloseReadiness } from './ux-close-readiness';

test('close readiness, one desktop New, narrow toast and lasting retained timer stay actionable', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120000);
  if (!baseURL) throw new Error('Owned local server is required');
  await createAccount(page);
  await uxCloseReadiness({ page, browser, baseURL, evidence: info.outputPath('ux-close-readiness'), runId: info.project.name });
});
