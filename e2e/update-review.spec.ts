import { test, expect } from './fixtures';
import { createAccount } from './helpers';
import { verifyUpdateReviewCases } from '../scripts/verify-update-review';

test('reviewed update gaps use real stalled responses, archived live clients and initial bundle skew', async ({ page, browser, baseURL }, info) => {
  test.skip(!process.env.PB_UPDATE_REVIEW_MODE && !process.env.PB_UPDATE_REVIEW_CASES, 'The complete automatic-update journey already includes these cases; this entry point selects archived baseline or focused review proofs');
  test.setTimeout(900000);
  if (!baseURL) throw new Error('The owned local TLS server is required');
  await createAccount(page);
  const result = await verifyUpdateReviewCases({ page, browser, baseURL, evidence: info.outputPath('update-review'), tag: info.project.name });
  expect(result?.errors).toEqual([]);
  expect(result?.rows).toHaveLength(process.env.PB_UPDATE_REVIEW_CASES?.split(',').length ?? 4);
});
