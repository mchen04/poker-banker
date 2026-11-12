import { test } from './fixtures';
import { createAccount } from './helpers';
import { uxFollowups } from './ux-followups';

test('footer semantics, actionable blockers and deliberate Undo stay clear across themes', async ({ page, browser, baseURL }, info) => {
  test.setTimeout(150000);
  if (!baseURL) throw new Error('Owned local server is required');
  await createAccount(page);
  await uxFollowups({ page, browser, baseURL, evidence: info.outputPath('ux-followups'), runId: info.project.name });
});
