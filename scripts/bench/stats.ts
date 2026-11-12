import type { Sample } from './types';
function median(sorted: number[]) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2 : null;
}
export function summarize(samples: Sample[]) {
  const names = [...new Set(samples.map(sample => sample.metric))].sort();
  return names.map(metric => {
    const rows = samples.filter(sample => sample.metric === metric);
    const sorted = rows.filter(sample => sample.ok && Number.isFinite(sample.ms)).map(sample => sample.ms).sort((a, b) => a - b);
    const center = median(sorted);
    const mad = center === null ? null : median(sorted.map(value => Math.abs(value - center)).sort((a, b) => a - b));
    return { metric, samples: rows.length, successfulSamples: sorted.length, errors: rows.filter(row => !row.ok || !Number.isFinite(row.ms)).length, median: center, mad, p95: sorted.length >= 20 ? sorted[Math.ceil(sorted.length * .95) - 1]! : null, p95Reason: sorted.length >= 20 ? null : 'At least 20 successful observations are required', min: sorted[0] ?? null, max: sorted.at(-1) ?? null, work: rows.map(row => row.work) };
  });
}
export function workSummary(metric: string, samples: Sample[]) {
  const rows = samples.filter(sample => sample.metric === metric && sample.ok);
  const work = rows[0]?.work;
  if (!work) return 'no completed work';
  if (metric === 'api.write10') return `${rows.length} committed writes; ${new Set(rows.map(row => `${row.work.run}/${row.work.batch}`)).size} batches of 10`;
  if (metric.startsWith('viewer.delay.')) return `${new Set(rows.map(row => `${row.work.run}/${row.work.batch ?? row.work.sample}`)).size} committed writes; ${rows.length} viewer renders`;
  if (metric === 'entry.confirm') return `${rows.length} saves; ${rows.reduce((sum, row) => sum + Number(row.work.ledger_rows_written), 0)} ledger rows`;
  const keys = ['players', 'session_entries', 'ledger_entries', 'closed_sessions', 'sessions_used', 'groups', 'rows_returned', 'rows_selected', 'unchanged'];
  return `${rows.length} completed; ${keys.filter(key => key in work).map(key => `${key}=${[...new Set(rows.map(row => String(row.work[key])))].join('/')}`).join(', ')}`;
}
