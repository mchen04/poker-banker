CREATE TABLE bankers (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  banker_id uuid NOT NULL REFERENCES bankers(id),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_sessions_banker ON auth_sessions(banker_id);
CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY,
  banker_id uuid NOT NULL REFERENCES bankers(id),
  code_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  UNIQUE (banker_id, code_hash)
);
CREATE TABLE login_throttle (
  key text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);
CREATE TABLE players (
  id uuid PRIMARY KEY,
  banker_id uuid NOT NULL REFERENCES bankers(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  name_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, banker_id)
);
CREATE INDEX players_name ON players(banker_id, name_key);
CREATE TABLE game_sessions (
  id uuid PRIMARY KEY,
  banker_id uuid NOT NULL REFERENCES bankers(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  played_on date NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  location text,
  game text,
  big_blind_minor bigint CHECK (big_blind_minor > 0),
  started_at timestamptz,
  ended_at timestamptz,
  CHECK (ended_at >= started_at),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_balanced boolean,
  closed_at timestamptz,
  share_token text UNIQUE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, banker_id),
  CHECK ((status = 'open' AND closed_at IS NULL AND closed_balanced IS NULL) OR
         (status = 'closed' AND closed_at IS NOT NULL AND closed_balanced IS NOT NULL))
);
CREATE INDEX game_sessions_history ON game_sessions(banker_id, played_on DESC, id DESC);
CREATE TABLE session_players (
  session_id uuid NOT NULL,
  player_id uuid NOT NULL,
  banker_id uuid NOT NULL REFERENCES bankers(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, player_id),
  UNIQUE (session_id, player_id, banker_id),
  FOREIGN KEY (session_id, banker_id) REFERENCES game_sessions(id, banker_id),
  FOREIGN KEY (player_id, banker_id) REFERENCES players(id, banker_id)
);
CREATE INDEX session_players_player ON session_players(banker_id, player_id);
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY,
  banker_id uuid NOT NULL REFERENCES bankers(id),
  session_id uuid NOT NULL,
  player_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('buy_in', 'cash_out', 'payment_in', 'payment_out', 'expense')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  note text CHECK (length(note) <= 500),
  method text CHECK (method IN ('cash', 'venmo', 'zelle')),
  CHECK ((kind IN ('payment_in', 'payment_out') AND method IS NOT NULL) OR
         (kind NOT IN ('payment_in', 'payment_out') AND method IS NULL)),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  voids_entry_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL CHECK (revision > 0),
  UNIQUE (id, session_id, player_id, banker_id, kind, amount_minor),
  CHECK (voids_entry_id IS NULL OR voids_entry_id <> id),
  FOREIGN KEY (session_id, banker_id) REFERENCES game_sessions(id, banker_id),
  FOREIGN KEY (player_id, banker_id) REFERENCES players(id, banker_id),
  FOREIGN KEY (session_id, player_id, banker_id) REFERENCES session_players(session_id, player_id, banker_id),
  FOREIGN KEY (voids_entry_id, session_id, player_id, banker_id, kind, amount_minor)
    REFERENCES ledger_entries(id, session_id, player_id, banker_id, kind, amount_minor)
);
CREATE INDEX ledger_entries_session ON ledger_entries(banker_id, session_id, revision);
CREATE TABLE session_events (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  banker_id uuid NOT NULL REFERENCES bankers(id),
  kind text NOT NULL CHECK (kind IN ('created', 'renamed', 'closed', 'reopened', 'share_enabled', 'share_rotated', 'share_disabled', 'timer_started', 'timing_corrected', 'details_changed')),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL CHECK (revision > 0),
  FOREIGN KEY (session_id, banker_id) REFERENCES game_sessions(id, banker_id)
);
CREATE INDEX session_events_session ON session_events(banker_id, session_id, revision);
CREATE TABLE idempotency_keys (
  banker_id uuid NOT NULL REFERENCES bankers(id),
  key uuid NOT NULL,
  request_hash bytea NOT NULL,
  response jsonb NOT NULL,
  status integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (banker_id, key)
);
CREATE FUNCTION enforce_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Ledger entries are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_ledger_append_only();
CREATE FUNCTION enforce_void_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.voids_entry_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM ledger_entries WHERE id = NEW.voids_entry_id AND voids_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot void a void' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_void_original BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_void_original();
