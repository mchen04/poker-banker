ALTER TABLE game_sessions ADD COLUMN deleted_at timestamptz;
ALTER TABLE players ADD COLUMN deleted_at timestamptz;
ALTER TABLE session_players ADD COLUMN removed_at timestamptz;
CREATE INDEX game_sessions_deleted ON game_sessions(banker_id, deleted_at DESC) WHERE deleted_at IS NOT NULL;
CREATE INDEX players_deleted ON players(banker_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX session_players_removed ON session_players(banker_id, session_id) WHERE removed_at IS NOT NULL;
CREATE TABLE session_player_removals (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  player_id uuid NOT NULL,
  banker_id uuid NOT NULL REFERENCES bankers(id),
  removed_at timestamptz NOT NULL DEFAULT now(),
  restored_at timestamptz,
  UNIQUE (id, session_id, player_id, banker_id),
  FOREIGN KEY (session_id, player_id, banker_id) REFERENCES session_players(session_id, player_id, banker_id)
);
CREATE INDEX session_player_removals_history ON session_player_removals(banker_id, session_id, player_id, removed_at DESC);
CREATE UNIQUE INDEX session_player_removals_active ON session_player_removals(session_id, player_id) WHERE restored_at IS NULL;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_identity UNIQUE (id, session_id, player_id, banker_id);
ALTER TABLE ledger_entries ADD COLUMN restores_entry_id uuid UNIQUE;
ALTER TABLE ledger_entries ADD COLUMN removal_id uuid;
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_restores
  FOREIGN KEY (restores_entry_id, session_id, player_id, banker_id)
  REFERENCES ledger_entries(id, session_id, player_id, banker_id);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_removal
  FOREIGN KEY (removal_id, session_id, player_id, banker_id)
  REFERENCES session_player_removals(id, session_id, player_id, banker_id);
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_restore_shape
  CHECK (restores_entry_id IS NULL OR (voids_entry_id IS NULL AND removal_id IS NULL AND restores_entry_id <> id));
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_removal_shape
  CHECK (removal_id IS NULL OR voids_entry_id IS NOT NULL);
CREATE INDEX ledger_entries_removal ON ledger_entries(removal_id) WHERE removal_id IS NOT NULL;
CREATE FUNCTION enforce_restore_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.restores_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger_entries WHERE voids_entry_id = NEW.restores_entry_id
  ) THEN
    RAISE EXCEPTION 'Cannot restore an entry that is not voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_restore_original BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_restore_original();
