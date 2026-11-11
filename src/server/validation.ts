import { z } from 'zod';
import { currencyExponent, MAX_MINOR } from '../domain/money.js';

export const id = z.uuid();
export const opId = z.uuidv4();
export const name = z.string().trim().min(1).max(100);
export const username = z.string().toLowerCase().regex(/^[a-z0-9_.-]{3,32}$/);
export const loginPassword = z.string().min(1).max(256);
const common = new Set(['password123', 'password1234', 'password12345', '1234567890', '12345678901', 'qwerty12345', 'letmein1234', 'iloveyou123']);
export const password = z.string().min(10).max(256).refine(value => !common.has(value.toLowerCase()), 'Choose a less common password');
export const date = z.iso.date().refine(value => !value.startsWith('0000-'));
export const currency = z.string().regex(/^[A-Z]{3}$/).refine(value => {
  try { currencyExponent(value); return true; } catch { return false; }
}, 'Unsupported ISO currency');
export const positiveMinor = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= MAX_MINOR);
export const signedMinor = z.string().max(1000).regex(/^(?:0|-?[1-9]\d*)$/);
export const revision = z.union([z.string().regex(/^(?:0|[1-9]\d{0,18})$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)])
  .refine(value => BigInt(value) <= MAX_MINOR);
export const timestamp = z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString())
  .refine(value => /^\d{4}-/.test(value) && !value.startsWith('0000-'), 'Use a UTC year from 0001 through 9999');
const details = { location: name.nullable().optional(), game: name.nullable().optional(), big_blind_minor: positiveMinor.nullable().optional() };
export const sessionCreate = z.strictObject({ op_id: opId, name, played_on: date, currency, ...details });
export const sessionPatch = z.strictObject({ op_id: opId, name: name.optional(), played_on: date.optional(), ...details })
  .refine(value => Object.keys(value).some(key => key !== 'op_id'));
export const startTimer = z.strictObject({ op_id: opId });
export const timingPatch = z.strictObject({ op_id: opId, started_at: timestamp, ended_at: timestamp.nullable() })
  .refine(value => value.ended_at === null || Date.parse(value.ended_at) >= Date.parse(value.started_at), 'End must be at or after start');
export const playerCreate = z.strictObject({ op_id: opId, display_name: name });
export const seatPlayer = z.union([
  z.strictObject({ op_id: opId, player_id: id }),
  z.strictObject({ op_id: opId, new_player_name: name }),
]);
export const method = z.enum(['cash', 'venmo', 'zelle']);
export const entryCreate = z.strictObject({
  op_id: opId, player_id: id, kind: z.enum(['buy_in', 'cash_out', 'payment_in', 'payment_out', 'expense']),
  amount_minor: positiveMinor, note: z.string().trim().max(500).optional(), paid_now: z.boolean().optional(),
  method: method.optional(), occurred_at: timestamp.optional(),
}).superRefine((value, context) => {
  const payment = value.kind === 'payment_in' || value.kind === 'payment_out';
  const paidChip = (value.kind === 'buy_in' && value.paid_now !== false) || (value.kind === 'cash_out' && value.paid_now === true);
  if (value.paid_now !== undefined && value.kind !== 'buy_in' && value.kind !== 'cash_out') context.addIssue({ code: 'custom', message: 'Paid now applies to chip entries' });
  if ((payment || paidChip) !== (value.method !== undefined)) context.addIssue({ code: 'custom', message: 'A payment requires a method; other entries have none' });
});
export const voidEntry = z.strictObject({
  op_id: opId, replacement_amount_minor: positiveMinor.optional(),
  replacement_method: method.optional(), replacement_occurred_at: timestamp.optional(),
});
export const reportQuery = z.strictObject({
  group: z.enum(['overall', 'location', 'game', 'weekday', 'month']).optional(),
  location: z.string().max(100).optional(), game: z.string().max(100).optional(),
  weekday: z.enum(['1', '2', '3', '4', '5', '6', '7']).optional(), month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).optional(),
  from: date.optional(), to: date.optional(),
}).refine(value => !value.from || !value.to || value.from <= value.to, 'From must not follow to');
export const closeSession = z.strictObject({ op_id: opId, expected_revision: revision, accept_discrepancy_minor: signedMinor.optional() });
export const reopenSession = z.strictObject({ op_id: opId, reason: z.string().trim().min(1).max(500) });
export const shareSession = z.strictObject({ op_id: opId, action: z.enum(['enable', 'rotate', 'disable']) });
export const sinceQuery = z.strictObject({ since: revision.optional() });
export const searchQuery = z.strictObject({ q: z.string().max(100).optional() });
export const listQuery = z.strictObject({ q: z.string().max(100).optional(), before: z.string().max(100).optional() });
export const cursor = z.tuple([date, id]);
