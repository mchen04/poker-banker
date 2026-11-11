import { effectiveEntries, playingTime, type PlayingInterval } from './timing.js';

export type EntryKind = 'buy_in' | 'cash_out' | 'payment_in' | 'payment_out' | 'expense';
export type PaymentMethod = 'cash' | 'venmo' | 'zelle';
export type LedgerEntry = {
  id: string;
  player_id: string;
  kind: EntryKind;
  amount_minor: string;
  note: string | null;
  method: PaymentMethod | null;
  occurred_at: string | null;
  voids_entry_id: string | null;
  created_at: string;
  revision: string;
};
export type SessionSettings = {
  id: string;
  name: string;
  played_on: string;
  currency: string;
  status: 'open' | 'closed';
  location: string | null;
  game: string | null;
  big_blind_minor: string | null;
  started_at: string | null;
  ended_at: string | null;
  closed_balanced: boolean | null;
  closed_at: string | null;
  share_token: string | null;
  created_at: string;
  updated_at: string;
};
export type SessionEvent = {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  created_at: string;
  revision: string;
};
type PlayerAmounts = {
  id: string;
  display_name: string;
  bought_in_minor: string;
  cashed_out_minor: string;
  payment_in_minor: string;
  payment_out_minor: string;
  balance_minor: string;
  buy_in_count: number;
  expense_minor: string;
  intervals: PlayingInterval[];
  duration_ms: string | null;
  performance: {
    result_minor: string | null;
    duration_ms: string | null;
    big_blind_minor: string | null;
    per_hour: { numerator: string; denominator: string } | null;
    big_blinds: { numerator: string; denominator: string } | null;
  };
};
export type PlayerState = PlayerAmounts & (
  | { state: 'seated' }
  | { state: 'playing' }
  | { state: 'cashed_out'; result_minor: string }
);
export type SessionState = {
  session: SessionSettings;
  revision: string;
  server_now: string;
  timing: { started_at: string | null; ended_at: string | null; elapsed_ms: string | null };
  players: PlayerState[];
  entries: LedgerEntry[];
  events: SessionEvent[];
  totals: {
    total_in_minor: string;
    total_out_minor: string;
    on_table_minor: string | null;
    discrepancy_minor: string | null;
    owed_to_banker_minor: string;
    owed_by_banker_minor: string;
  };
};

export function deriveSession(
  session: SessionSettings,
  revision: string,
  players: { id: string; display_name: string }[],
  entries: LedgerEntry[],
  events: SessionEvent[] = [],
  serverNow = session.updated_at || '1970-01-01T00:00:00.000Z',
): SessionState {
  const effective = effectiveEntries(entries);
  const amounts = new Map(players.map(player => [player.id, {
    ...player, buy_in: 0n, cash_out: 0n, payment_in: 0n, payment_out: 0n, expense: 0n,
    buy_in_count: 0, state: 'seated' as 'seated' | 'playing' | 'cashed_out',
  }]));
  for (const entry of effective) {
    const player = amounts.get(entry.player_id);
    if (!player) throw new Error('Entry has no seated player');
    player[entry.kind] += BigInt(entry.amount_minor);
    if (entry.kind === 'buy_in') { player.state = 'playing'; player.buy_in_count++; }
    if (entry.kind === 'cash_out') player.state = 'cashed_out';
  }
  const states: PlayerState[] = [...amounts.values()].map(player => {
    const timing = playingTime(effective.filter(entry => entry.player_id === player.id), session.ended_at, serverNow);
    const result = player.state === 'cashed_out' ? String(player.cash_out - player.buy_in) : null;
    const base: PlayerAmounts = {
      id: player.id, display_name: player.display_name,
      bought_in_minor: String(player.buy_in), cashed_out_minor: String(player.cash_out),
      payment_in_minor: String(player.payment_in), payment_out_minor: String(player.payment_out),
      balance_minor: String(player.buy_in - player.cash_out - player.payment_in + player.payment_out),
      buy_in_count: player.buy_in_count,
      expense_minor: String(player.expense),
      ...timing,
      performance: {
        result_minor: result, duration_ms: timing.duration_ms, big_blind_minor: session.big_blind_minor,
        per_hour: result !== null && timing.duration_ms !== null && BigInt(timing.duration_ms) > 0n
          ? { numerator: String(BigInt(result) * 3600000n), denominator: timing.duration_ms } : null,
        big_blinds: result !== null && session.big_blind_minor !== null && BigInt(session.big_blind_minor) > 0n
          ? { numerator: result, denominator: session.big_blind_minor } : null,
      },
    };
    return player.state === 'cashed_out'
      ? { ...base, state: 'cashed_out', result_minor: String(player.cash_out - player.buy_in) }
      : { ...base, state: player.state };
  });
  const totalIn = states.reduce((sum, player) => sum + BigInt(player.bought_in_minor), 0n);
  const totalOut = states.reduce((sum, player) => sum + BigInt(player.cashed_out_minor), 0n);
  const playing = states.some(player => player.state === 'playing');
  const elapsed = session.started_at === null ? null : Date.parse(session.ended_at ?? serverNow) - Date.parse(session.started_at);
  return {
    session, revision, players: states, server_now: serverNow,
    timing: {
      started_at: session.started_at, ended_at: session.ended_at,
      elapsed_ms: elapsed !== null && Number.isSafeInteger(elapsed) && elapsed >= 0 ? String(BigInt(elapsed)) : null,
    },
    entries: [...entries].sort((a, b) => BigInt(a.revision) > BigInt(b.revision) ? -1 : BigInt(a.revision) < BigInt(b.revision) ? 1 : b.id.localeCompare(a.id)),
    events,
    totals: {
      total_in_minor: String(totalIn), total_out_minor: String(totalOut),
      on_table_minor: playing ? String(totalIn - totalOut) : null,
      discrepancy_minor: playing ? null : String(totalOut - totalIn),
      owed_to_banker_minor: String(states.reduce((sum, player) => sum + (BigInt(player.balance_minor) > 0n ? BigInt(player.balance_minor) : 0n), 0n)),
      owed_by_banker_minor: String(states.reduce((sum, player) => sum + (BigInt(player.balance_minor) < 0n ? -BigInt(player.balance_minor) : 0n), 0n)),
    },
  };
}

export function viewerState(state: SessionState) {
  const { share_token: _, ...session } = state.session;
  return { ...state, session };
}
