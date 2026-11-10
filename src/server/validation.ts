import { z } from 'zod';
import { currencyExponent, MAX_MINOR } from '../domain/money';

export const id = z.uuid();
export const opId = z.uuidv4();
export const name = z.string().trim().min(1).max(100);
export const username = z.string().toLowerCase().regex(/^[a-z0-9_.-]{3,32}$/);
export const loginPassword = z.string().min(1).max(256);
const common = new Set(['password123', 'password1234', 'password12345', '1234567890', '12345678901', 'qwerty12345', 'letmein1234', 'iloveyou123']);
export const password = z.string().min(10).max(256).refine(value => !common.has(value.toLowerCase()), 'Choose a less common password');
export const date = z.iso.date();
export const currency = z.string().regex(/^[A-Z]{3}$/).refine(value => {
  try { currencyExponent(value); return true; } catch { return false; }
}, 'Unsupported ISO currency');
export const positiveMinor = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= MAX_MINOR);
export const signedMinor = z.string().max(1000).regex(/^(?:0|-?[1-9]\d*)$/);
export const revision = z.union([z.string().regex(/^(?:0|[1-9]\d{0,18})$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)])
  .refine(value => BigInt(value) <= MAX_MINOR);
export const sessionCreate = z.strictObject({ op_id: opId, name, played_on: date, currency });
export const sessionPatch = z.strictObject({ op_id: opId, name: name.optional(), played_on: date.optional() }).refine(value => value.name !== undefined || value.played_on !== undefined);
export const playerCreate = z.strictObject({ op_id: opId, display_name: name });
export const seatPlayer = z.union([
  z.strictObject({ op_id: opId, player_id: id }),
  z.strictObject({ op_id: opId, new_player_name: name }),
]);
export const entryCreate = z.strictObject({
  op_id: opId, player_id: id, kind: z.enum(['buy_in', 'cash_out', 'payment_in', 'payment_out']),
  amount_minor: positiveMinor, note: z.string().trim().max(500).optional(), paid_now: z.boolean().optional(),
}).refine(value => value.paid_now === undefined || value.kind === 'buy_in' || value.kind === 'cash_out', 'Paid now applies to chip entries');
export const voidEntry = z.strictObject({ op_id: opId, replacement_amount_minor: positiveMinor.optional() });
export const closeSession = z.strictObject({ op_id: opId, expected_revision: revision, accept_discrepancy_minor: signedMinor.optional() });
export const reopenSession = z.strictObject({ op_id: opId, reason: z.string().trim().min(1).max(500) });
export const shareSession = z.strictObject({ op_id: opId, action: z.enum(['enable', 'rotate', 'disable']) });
export const sinceQuery = z.strictObject({ since: revision.optional() });
export const searchQuery = z.strictObject({ q: z.string().max(100).optional() });
export const listQuery = z.strictObject({ q: z.string().max(100).optional(), before: z.string().max(100).optional() });
export const cursor = z.tuple([date, id]);
