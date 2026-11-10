export type EntryKind = 'buy_in' | 'cash_out' | 'payment_in' | 'payment_out';
export type LedgerEntry = {
  id: string;
  player_id: string;
  kind: EntryKind;
  amount_minor: string;
  note: string | null;
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
};
export type PlayerState = PlayerAmounts & (
  | { state: 'seated' }
  | { state: 'playing' }
  | { state: 'cashed_out'; result_minor: string }
);
export type SessionState = {
  session: SessionSettings;
  revision: string;
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
): SessionState {
  const voided = new Set(entries.flatMap(entry => entry.voids_entry_id ? [entry.voids_entry_id] : []));
  const effective = entries.filter(entry => !entry.voids_entry_id && !voided.has(entry.id))
    .sort((a, b) => BigInt(a.revision) < BigInt(b.revision) ? -1 : BigInt(a.revision) > BigInt(b.revision) ? 1 : 0);
  const amounts = new Map(players.map(player => [player.id, {
    ...player, buy_in: 0n, cash_out: 0n, payment_in: 0n, payment_out: 0n,
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
    const base: PlayerAmounts = {
      id: player.id, display_name: player.display_name,
      bought_in_minor: String(player.buy_in), cashed_out_minor: String(player.cash_out),
      payment_in_minor: String(player.payment_in), payment_out_minor: String(player.payment_out),
      balance_minor: String(player.buy_in - player.cash_out - player.payment_in + player.payment_out),
      buy_in_count: player.buy_in_count,
    };
    return player.state === 'cashed_out'
      ? { ...base, state: 'cashed_out', result_minor: String(player.cash_out - player.buy_in) }
      : { ...base, state: player.state };
  });
  const totalIn = states.reduce((sum, player) => sum + BigInt(player.bought_in_minor), 0n);
  const totalOut = states.reduce((sum, player) => sum + BigInt(player.cashed_out_minor), 0n);
  const playing = states.some(player => player.state === 'playing');
  return {
    session, revision, players: states,
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
