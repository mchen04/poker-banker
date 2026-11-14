import type { LedgerEntry, PaymentMethod } from '../domain/session';

export function moneyOptions(entries: LedgerEntry[], playerId: string) {
  const voided = new Set(entries.flatMap(entry => entry.voids_entry_id ? [entry.voids_entry_id] : []));
  const effective = entries.filter(entry => !entry.voids_entry_id && !voided.has(entry.id))
    .sort((left, right) => BigInt(left.revision) < BigInt(right.revision) ? -1 : BigInt(left.revision) > BigInt(right.revision) ? 1 : 0);
  const counts = new Map<string, number>();
  let typicalBuy: string | undefined;
  let lastBuy: string | undefined;
  let method: PaymentMethod = 'cash';
  let lastBuyRevision: string | undefined;
  for (const entry of effective) {
    if (entry.kind === 'buy_in') {
      const count = (counts.get(entry.amount_minor) ?? 0) + 1;
      counts.set(entry.amount_minor, count);
      if (!typicalBuy || count > counts.get(typicalBuy)!) typicalBuy = entry.amount_minor;
    }
    if (entry.player_id !== playerId) continue;
    if (entry.method) method = entry.method;
    if (entry.kind === 'buy_in') { lastBuy = entry.amount_minor; lastBuyRevision = entry.revision; }
  }
  const lastBuyPaid = lastBuyRevision !== undefined && effective.some(entry => entry.player_id === playerId && entry.kind === 'payment_in' && entry.revision === lastBuyRevision);
  return { typicalBuy, lastBuy, lastBuyPaid, method };
}
