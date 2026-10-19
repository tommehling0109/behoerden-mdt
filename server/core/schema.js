// Versionierte Migrationen. Neue Phasen hängen weitere Einträge an (nie bestehende ändern).
export const SCHEMA_MIGRATIONS = [
  /* v1 – Phase 1 Foundation */ `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','blocked','rejected')),
    status_reason TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#5b8def',
    is_admin    INTEGER NOT NULL DEFAULT 0,
    is_system   INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE permissions (
    key         TEXT PRIMARY KEY,
    module      TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_custom   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE role_permissions (
    role_id        INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_key)
  );
  CREATE TABLE user_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  );
  CREATE TABLE user_permissions (
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    PRIMARY KEY (user_id, permission_key)
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE TABLE audit_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT NOT NULL,
    user_id      INTEGER,
    username     TEXT,
    action       TEXT NOT NULL,
    module       TEXT NOT NULL,
    target_type  TEXT,
    target_id    TEXT,
    target_label TEXT,
    before_value TEXT,
    after_value  TEXT,
    ip           TEXT
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
  CREATE INDEX idx_audit_module ON audit_log(module);
  `,
  /* v2 – Organisation: Dienstnummern, Ränge, Abteilungen + Verknüpfungs-/Integrationsgrundlagen */ `
  CREATE TABLE departments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#5b8def',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE ranks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description    TEXT NOT NULL DEFAULT '',
    color          TEXT NOT NULL DEFAULT '#5b8def',
    sort_order     INTEGER NOT NULL DEFAULT 0,
    department_id  INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    parent_rank_id INTEGER REFERENCES ranks(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL
  );
  CREATE TABLE rank_permissions (
    rank_id        INTEGER NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
    PRIMARY KEY (rank_id, permission_key)
  );
  ALTER TABLE users ADD COLUMN member_number TEXT;
  ALTER TABLE users ADD COLUMN rank_id INTEGER REFERENCES ranks(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN supervisor_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  CREATE UNIQUE INDEX idx_users_member_number ON users(member_number) WHERE member_number IS NOT NULL;
  CREATE INDEX idx_users_rank ON users(rank_id);
  CREATE INDEX idx_users_department ON users(department_id);
  -- Zähler für fortlaufende Nummern (nie zurückgesetzt → keine Wiederverwendung)
  CREATE TABLE sequences (
    name       TEXT PRIMARY KEY,
    next_value INTEGER NOT NULL
  );
  -- Zuordnung interner Datensätze zu externen Systemen (FiveM: Spieler, Character, Fahrzeug, Garage …)
  CREATE TABLE external_refs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER NOT NULL,
    external_id TEXT NOT NULL,
    meta        TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE (provider, entity_type, external_id),
    UNIQUE (provider, entity_type, entity_id)
  );
  -- Generische Verknüpfungen zwischen Modulen (Operation↔Fahrzeug, Aufgabe↔Mitarbeiter, Karte↔Lager …)
  CREATE TABLE entity_links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_type  TEXT NOT NULL,
    from_id    INTEGER NOT NULL,
    to_type    TEXT NOT NULL,
    to_id      INTEGER NOT NULL,
    relation   TEXT NOT NULL DEFAULT 'related',
    meta       TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    UNIQUE (from_type, from_id, to_type, to_id, relation)
  );
  CREATE INDEX idx_links_from ON entity_links(from_type, from_id);
  CREATE INDEX idx_links_to ON entity_links(to_type, to_id);
  `,
  /* v3 – Phase 2 + Partner-Zugänge + Börse */ `
  -- Zentrale, frei konfigurierbare Auswahllisten (Kategorien, Status-Beschriftungen, Übergabeorte …)
  CREATE TABLE lookups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list_key    TEXT NOT NULL,
    key         TEXT NOT NULL,
    label       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#5b8def',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    is_system   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (list_key, key)
  );
  -- Externe Zugänge (Partner): permanenter Link + Zugangscode, nur freigeschaltete Apps
  CREATE TABLE partners (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    note            TEXT NOT NULL DEFAULT '',
    link_token      TEXT NOT NULL UNIQUE,
    code_hash       TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    apps            TEXT NOT NULL DEFAULT '[]',
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    last_login_at   TEXT,
    created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE TABLE partner_sessions (
    token_hash TEXT PRIMARY KEY,
    partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_partner_sessions_partner ON partner_sessions(partner_id);
  -- Börse: Katalog, Gesuche, Geschäfte, Verlauf
  CREATE TABLE market_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    category_id     INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    unit            TEXT NOT NULL DEFAULT 'Stück',
    reference_price INTEGER,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE TABLE market_wanted (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id    INTEGER NOT NULL REFERENCES market_items(id) ON DELETE CASCADE,
    quantity   INTEGER NOT NULL,
    unit_price INTEGER NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    expires_at TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE market_deals (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    origin            TEXT NOT NULL CHECK (origin IN ('offer','wanted')),
    partner_id        INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    item_id           INTEGER NOT NULL REFERENCES market_items(id) ON DELETE RESTRICT,
    wanted_id         INTEGER REFERENCES market_wanted(id) ON DELETE SET NULL,
    quantity          INTEGER NOT NULL,
    unit_price        INTEGER NOT NULL,
    proposed_by       TEXT NOT NULL CHECK (proposed_by IN ('staff','partner')),
    turn              TEXT CHECK (turn IN ('staff','partner')),
    status            TEXT NOT NULL DEFAULT 'submitted',
    note              TEXT NOT NULL DEFAULT '',
    assignee_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    handover_place_id INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    handover_info     TEXT NOT NULL DEFAULT '',
    payout_info       TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    closed_at         TEXT
  );
  CREATE INDEX idx_deals_partner ON market_deals(partner_id);
  CREATE INDEX idx_deals_status ON market_deals(status);
  CREATE TABLE market_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id    INTEGER NOT NULL REFERENCES market_deals(id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('staff','partner','system')),
    actor_id   INTEGER,
    actor_name TEXT,
    kind       TEXT NOT NULL,
    quantity   INTEGER,
    unit_price INTEGER,
    text       TEXT,
    internal   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_deal ON market_events(deal_id);
  `,
  /* v4 – Echtzeit (Event-Log), Benachrichtigungen, MDT-Nummern für Geschäfte und Partner */ `
  -- Event-Log für Live-Sync: fortlaufende IDs ⇒ nach Verbindungsabbruch lassen sich verpasste Ereignisse nachliefern
  CREATE TABLE events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    type          TEXT NOT NULL,            -- 'change' | 'notification'
    topic         TEXT NOT NULL,
    kind          TEXT,
    entity_type   TEXT,
    entity_id     TEXT,
    staff         INTEGER NOT NULL DEFAULT 0,
    staff_perm    TEXT,                     -- Mitarbeiter-Zielgruppe (NULL = alle aktiven Mitarbeiter)
    partner_scope TEXT,                     -- NULL | 'all' | 'id:<partner>'
    user_id       INTEGER,                  -- direkter Empfänger (Benachrichtigung)
    partner_id    INTEGER,
    data          TEXT
  );
  -- Benachrichtigungen: pro Empfänger und Ereignis genau eine (UNIQUE ⇒ nie doppelt, aber jede echte Änderung hat einen eigenen Schlüssel)
  CREATE TABLE notifications (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('user','partner')),
    recipient_id   INTEGER NOT NULL,
    event_key      TEXT NOT NULL,
    title          TEXT NOT NULL,
    body           TEXT NOT NULL DEFAULT '',
    target         TEXT,
    created_at     TEXT NOT NULL,
    read_at        TEXT,
    UNIQUE (recipient_type, recipient_id, event_key)
  );
  CREATE INDEX idx_notif_recipient ON notifications(recipient_type, recipient_id, id DESC);
  ALTER TABLE market_deals ADD COLUMN deal_number TEXT;
  ALTER TABLE partners ADD COLUMN partner_number TEXT;
  CREATE UNIQUE INDEX idx_deals_number ON market_deals(deal_number) WHERE deal_number IS NOT NULL;
  CREATE UNIQUE INDEX idx_partners_number ON partners(partner_number) WHERE partner_number IS NOT NULL;
  `,
  /* v5 – Chat */ `
  CREATE TABLE chat_channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    color       TEXT NOT NULL DEFAULT '#6b7280',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    restricted  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE chat_channel_roles (
    channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, role_id)
  );
  CREATE TABLE chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    reply_to   INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    edited_at  TEXT,
    deleted_at TEXT,
    deleted_by INTEGER,
    pinned_at  TEXT,
    pinned_by  INTEGER
  );
  CREATE INDEX idx_chat_msg_channel ON chat_messages(channel_id, id);
  CREATE TABLE chat_reads (
    channel_id   INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );
  `,
  /* v6 – Fahrzeuge + Karte */ `
  CREATE TABLE vehicles (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_number   TEXT UNIQUE,
    plate            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    vin              TEXT UNIQUE COLLATE NOCASE,
    name             TEXT NOT NULL,
    category_id      INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    fuel_type        TEXT NOT NULL DEFAULT 'petrol' CHECK (fuel_type IN ('diesel','petrol','electric')),
    fuel_level       INTEGER CHECK (fuel_level IS NULL OR (fuel_level BETWEEN 0 AND 100)),
    condition_key    TEXT NOT NULL DEFAULT 'ready',
    color            TEXT NOT NULL DEFAULT '',
    mileage          INTEGER,
    seats            INTEGER,
    location_text    TEXT NOT NULL DEFAULT '',
    parking_slot     TEXT NOT NULL DEFAULT '',
    loc_x            REAL,
    loc_y            REAL,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    department_id    INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    inspection_due   TEXT,
    notes            TEXT NOT NULL DEFAULT '',
    image_ext        TEXT,
    image_version    INTEGER NOT NULL DEFAULT 0,
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX idx_vehicles_condition ON vehicles(condition_key);
  CREATE TABLE vehicle_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    user_id    INTEGER,
    kind       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_vehicle_events ON vehicle_events(vehicle_id, id);
  CREATE TABLE map_points (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    icon        TEXT NOT NULL DEFAULT 'pin',
    color       TEXT,
    x           REAL NOT NULL,
    y           REAL NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','editors')),
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  `,
  /* v7 – Privatnachrichten + Lager + Preisspannen */ `
  ALTER TABLE chat_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel';
  ALTER TABLE chat_channels ADD COLUMN dm_a INTEGER REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE chat_channels ADD COLUMN dm_b INTEGER REFERENCES users(id) ON DELETE CASCADE;
  CREATE UNIQUE INDEX idx_chat_dm ON chat_channels(dm_a, dm_b) WHERE kind = 'dm';
  ALTER TABLE market_items ADD COLUMN min_price INTEGER;
  ALTER TABLE market_items ADD COLUMN max_price INTEGER;
  ALTER TABLE market_items ADD COLUMN target_stock INTEGER;
  ALTER TABLE market_items ADD COLUMN space INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE market_deals ADD COLUMN suggested_price INTEGER;
  CREATE TABLE warehouses (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse_number TEXT UNIQUE,
    name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    type_id          INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    description      TEXT NOT NULL DEFAULT '',
    location_text    TEXT NOT NULL DEFAULT '',
    postal           TEXT,
    loc_x            REAL,
    loc_y            REAL,
    capacity         INTEGER,
    size_info        TEXT NOT NULL DEFAULT '',
    access_info      TEXT NOT NULL DEFAULT '',
    restricted       INTEGER NOT NULL DEFAULT 0,
    department_id    INTEGER REFERENCES departments(id) ON DELETE SET NULL,
    notes            TEXT NOT NULL DEFAULT '',
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE TABLE warehouse_access (
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    role_id      INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    level        TEXT NOT NULL DEFAULT 'view' CHECK (level IN ('view','manage')),
    PRIMARY KEY (warehouse_id, role_id)
  );
  CREATE TABLE warehouse_stock (
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    item_id      INTEGER NOT NULL REFERENCES market_items(id) ON DELETE RESTRICT,
    quantity     INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    PRIMARY KEY (warehouse_id, item_id)
  );
  CREATE TABLE warehouse_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse_id   INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    item_id        INTEGER REFERENCES market_items(id) ON DELETE SET NULL,
    user_id        INTEGER,
    kind           TEXT NOT NULL,
    delta          INTEGER,
    quantity_after INTEGER,
    note           TEXT NOT NULL DEFAULT '',
    deal_id        INTEGER,
    created_at     TEXT NOT NULL
  );
  CREATE INDEX idx_wh_events ON warehouse_events(warehouse_id, id);
  `,
  /* v8 – Chat für externe Partner */ `
  ALTER TABLE chat_channels ADD COLUMN dm_partner INTEGER REFERENCES partners(id) ON DELETE CASCADE;
  CREATE UNIQUE INDEX idx_chat_dm_partner ON chat_channels(dm_a, dm_partner) WHERE kind = 'dm' AND dm_partner IS NOT NULL;
  ALTER TABLE chat_messages ADD COLUMN partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL;
  CREATE TABLE chat_channel_partners (
    channel_id INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, partner_id)
  );
  CREATE TABLE chat_partner_reads (
    channel_id   INTEGER NOT NULL REFERENCES chat_channels(id) ON DELETE CASCADE,
    partner_id   INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, partner_id)
  );
  `,
  /* v9 – Verkauf an Partner (Lagerabbuchung) + Finanz-Journal */ `
  ALTER TABLE market_deals ADD COLUMN direction TEXT NOT NULL DEFAULT 'buy' CHECK (direction IN ('buy','sell'));
  ALTER TABLE market_deals ADD COLUMN warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL;
  ALTER TABLE market_deals ADD COLUMN stock_booked INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE finance_ledger (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_type   TEXT NOT NULL DEFAULT 'deal',
    direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
    amount       INTEGER NOT NULL,
    currency     TEXT NOT NULL DEFAULT '$',
    status       TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('expected','settled','cancelled')),
    deal_id      INTEGER REFERENCES market_deals(id) ON DELETE SET NULL,
    partner_id   INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    item_id      INTEGER REFERENCES market_items(id) ON DELETE SET NULL,
    quantity     INTEGER,
    unit_price   INTEGER,
    warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    settled_at   TEXT,
    cancelled_at TEXT
  );
  CREATE INDEX idx_ledger_deal ON finance_ledger(deal_id);
  CREATE INDEX idx_ledger_status ON finance_ledger(status, direction);
  `,
  /* v10 – Deckel-System (Firmenabrechnung) */ `
  CREATE TABLE tab_companies (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    company_number     TEXT UNIQUE,
    name               TEXT NOT NULL UNIQUE COLLATE NOCASE,
    contact_name       TEXT NOT NULL DEFAULT '',
    contact_info       TEXT NOT NULL DEFAULT '',
    billing_interval   TEXT NOT NULL CHECK (billing_interval IN ('weekly','monthly')),
    scope              TEXT NOT NULL DEFAULT 'all' CHECK (scope IN ('all','selected','perm')),
    scope_perm         TEXT,
    credit_limit_cents INTEGER,
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    link_token         TEXT NOT NULL UNIQUE,
    notes              TEXT NOT NULL DEFAULT '',
    created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );
  CREATE TABLE tab_company_members (
    company_id INTEGER NOT NULL REFERENCES tab_companies(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (company_id, user_id)
  );
  CREATE TABLE tab_entries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_number   TEXT UNIQUE,
    company_id     INTEGER NOT NULL REFERENCES tab_companies(id) ON DELETE RESTRICT,
    member_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    member_number  TEXT NOT NULL,
    amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
    description    TEXT NOT NULL,
    period_key     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
    corrects_id    INTEGER REFERENCES tab_entries(id) ON DELETE SET NULL,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL,
    cancelled_at   TEXT,
    cancelled_by   INTEGER,
    cancel_reason  TEXT
  );
  CREATE INDEX idx_tab_entries_period ON tab_entries(company_id, period_key);
  CREATE INDEX idx_tab_entries_member ON tab_entries(member_user_id);
  CREATE TABLE tab_statements (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_number     TEXT UNIQUE,
    company_id           INTEGER NOT NULL REFERENCES tab_companies(id) ON DELETE RESTRICT,
    period_key           TEXT NOT NULL,
    submitted_cents      INTEGER NOT NULL CHECK (submitted_cents >= 0),
    our_cents            INTEGER NOT NULL DEFAULT 0,
    approved_cents       INTEGER,
    comment              TEXT NOT NULL DEFAULT '',
    status               TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','review','confirmed','payment_pending','paid','rejected')),
    diff_note            TEXT NOT NULL DEFAULT '',
    reject_reason        TEXT NOT NULL DEFAULT '',
    pay_method           TEXT CHECK (pay_method IN ('transfer','invoice')),
    paid_at              TEXT,
    pay_reference        TEXT NOT NULL DEFAULT '',
    invoice_received     INTEGER NOT NULL DEFAULT 0,
    invoice_number       TEXT NOT NULL DEFAULT '',
    invoice_amount_cents INTEGER,
    invoice_date         TEXT,
    invoice_file_ext     TEXT,
    submitted_at         TEXT NOT NULL,
    reviewed_by          INTEGER,
    paid_by              INTEGER,
    updated_at           TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_tab_statement_period ON tab_statements(company_id, period_key) WHERE status != 'rejected';
  CREATE TABLE tab_statement_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id INTEGER NOT NULL REFERENCES tab_statements(id) ON DELETE CASCADE,
    ts           TEXT NOT NULL,
    user_id      INTEGER,
    by_company   INTEGER NOT NULL DEFAULT 0,
    text         TEXT NOT NULL
  );
  ALTER TABLE finance_ledger ADD COLUMN ref_type TEXT;
  ALTER TABLE finance_ledger ADD COLUMN ref_id INTEGER;
  ALTER TABLE finance_ledger ADD COLUMN company_id INTEGER REFERENCES tab_companies(id) ON DELETE SET NULL;
  CREATE INDEX idx_ledger_ref ON finance_ledger(ref_type, ref_id);
  `,
  /* v11 – Kreditsystem */ `
  ALTER TABLE partners ADD COLUMN credit_limit_cents INTEGER;
  CREATE TABLE credit_loans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_number    TEXT UNIQUE,
    partner_id     INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
    status         TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','negotiating','accepted','active','completed','rejected','withdrawn','cancelled','defaulted')),
    turn           TEXT CHECK (turn IN ('staff','partner')),
    proposed_by    TEXT NOT NULL DEFAULT 'partner' CHECK (proposed_by IN ('staff','partner')),
    principal_cents INTEGER NOT NULL CHECK (principal_cents > 0),
    term_count     INTEGER NOT NULL CHECK (term_count > 0),
    frequency      TEXT NOT NULL CHECK (frequency IN ('weekly','monthly')),
    interest_set   INTEGER NOT NULL DEFAULT 0,
    interest_type  TEXT NOT NULL DEFAULT 'none' CHECK (interest_type IN ('none','flat')),
    rate_bp        INTEGER NOT NULL DEFAULT 0,
    rate_period    TEXT NOT NULL DEFAULT 'week' CHECK (rate_period IN ('day','week','month')),
    pay_to         TEXT NOT NULL DEFAULT '',
    note           TEXT NOT NULL DEFAULT '',
    start_date     TEXT,
    disbursed_at   TEXT,
    closed_at      TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX idx_credit_partner ON credit_loans(partner_id);
  CREATE INDEX idx_credit_status ON credit_loans(status);
  CREATE TABLE credit_installments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id         INTEGER NOT NULL REFERENCES credit_loans(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    due_date        TEXT NOT NULL,
    principal_cents INTEGER NOT NULL,
    interest_cents  INTEGER NOT NULL,
    amount_cents    INTEGER NOT NULL,
    paid_cents      INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','cancelled')),
    paid_at         TEXT,
    reported_at     TEXT,
    note            TEXT NOT NULL DEFAULT '',
    reminded        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_credit_inst_loan ON credit_installments(loan_id, seq);
  CREATE INDEX idx_credit_inst_due ON credit_installments(status, due_date);
  CREATE TABLE credit_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id    INTEGER NOT NULL REFERENCES credit_loans(id) ON DELETE CASCADE,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('staff','partner','system')),
    actor_id   INTEGER,
    kind       TEXT NOT NULL,
    text       TEXT,
    snapshot   TEXT,
    internal   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_credit_events ON credit_events(loan_id, id);
  `,
  /* v12 – Profilbilder */ `
  ALTER TABLE users ADD COLUMN avatar_ext TEXT;
  ALTER TABLE users ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0;
  `,
  /* v13 – Superadmin, Firmensitz/Kontonummer, strukturierte Daten für externe Zugänge */ `
  ALTER TABLE users ADD COLUMN is_superadmin INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET is_superadmin = 1 WHERE id = (SELECT MIN(u.id) FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE r.is_admin = 1);
  ALTER TABLE tab_companies ADD COLUMN seat TEXT NOT NULL DEFAULT '';
  ALTER TABLE tab_companies ADD COLUMN account_number TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN partner_type TEXT NOT NULL DEFAULT 'customer' CHECK (partner_type IN ('customer','supplier'));
  ALTER TABLE partners ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN birth_date TEXT;
  ALTER TABLE partners ADD COLUMN postal_code TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN street TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN umail_local TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN account_number TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN id_doc_ext TEXT;
  ALTER TABLE partners ADD COLUMN weapon_required INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE partners ADD COLUMN weapon_doc_ext TEXT;
  `,
  /* v14 – Personalakte, Dokumente (Führerschein/Führungszeugnis), Ankäufer-Felder, Ticketsystem */ `
  ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN street TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN postal_code TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN umail_local TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN account_number TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN doc_id_ext TEXT;
  ALTER TABLE users ADD COLUMN doc_license_ext TEXT;
  ALTER TABLE users ADD COLUMN doc_weapon_ext TEXT;
  ALTER TABLE users ADD COLUMN doc_clearance_ext TEXT;
  ALTER TABLE partners ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE partners ADD COLUMN license_doc_ext TEXT;
  ALTER TABLE partners ADD COLUMN clearance_doc_ext TEXT;
  CREATE TABLE tickets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT UNIQUE,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    category      TEXT NOT NULL DEFAULT 'bug' CHECK (category IN ('bug','idea','question','other')),
    priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
    status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
    app           TEXT NOT NULL DEFAULT '',
    shot_ext      TEXT,
    assignee_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    closed_at     TEXT
  );
  CREATE INDEX idx_tickets_user ON tickets(user_id);
  CREATE INDEX idx_tickets_status ON tickets(status);
  CREATE TABLE ticket_comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    shot_ext   TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_ticket_comments ON ticket_comments(ticket_id, id);
  `,
  // 15: Tickets auch von externen Zugaengen (Partnern)
  `
  ALTER TABLE tickets ADD COLUMN partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL;
  ALTER TABLE ticket_comments ADD COLUMN partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL;
  CREATE INDEX idx_tickets_partner ON tickets(partner_id);
  `,
  // 16: Zugriffsversuche ueber den Exekutive-Link (Sperrzeit + Protokoll)
  `
  CREATE TABLE hack_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    success    INTEGER NOT NULL DEFAULT 0,
    stage      INTEGER NOT NULL DEFAULT 0,
    ip         TEXT
  );
  `,
  // 17: Schwarzes Brett (Ankuendigungen auf dem Desktop)
  `
  CREATE TABLE board_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','important','urgent','success')),
    pinned     INTEGER NOT NULL DEFAULT 0,
    author_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_board_order ON board_posts(pinned, id);
  `,
  // 18: Lager nach Slots wie im Inventar des Servers (Slots pro Stapel + maximale Menge pro Stapel)
  `
  ALTER TABLE market_items ADD COLUMN stack_size INTEGER NOT NULL DEFAULT 1;
  `,
  // 19: Changelog (Update-Eintraege auf dem Desktop)
  `
  CREATE TABLE changelog_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version     TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL,
    released_at TEXT NOT NULL,
    items       TEXT NOT NULL DEFAULT '[]',
    author_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_changelog_order ON changelog_entries(released_at, id);
  `,
  // 20: Kontaktbuch (Institutionen, Personen, Kontaktdaten, Sperren fuer Rollen)
  `
  CREATE TABLE contact_orgs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    type_id     INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    flag        TEXT,
    description TEXT NOT NULL DEFAULT '',
    address     TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '',
    restricted  INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_contact_orgs_name ON contact_orgs(name COLLATE NOCASE);
  CREATE TABLE contact_people (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id       INTEGER REFERENCES contact_orgs(id) ON DELETE SET NULL,
    first_name   TEXT NOT NULL DEFAULT '',
    last_name    TEXT NOT NULL DEFAULT '',
    relation_id  INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    position     TEXT NOT NULL DEFAULT '',
    flag         TEXT,
    address      TEXT NOT NULL DEFAULT '',
    home_address TEXT NOT NULL DEFAULT '',
    birthday     TEXT NOT NULL DEFAULT '',
    bank_name    TEXT NOT NULL DEFAULT '',
    bank_account TEXT NOT NULL DEFAULT '',
    bank_note    TEXT NOT NULL DEFAULT '',
    notes        TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '',
    restricted   INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_contact_people_org ON contact_people(org_id);
  CREATE INDEX idx_contact_people_name ON contact_people(last_name COLLATE NOCASE, first_name COLLATE NOCASE);
  CREATE TABLE contact_channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('org','person')),
    owner_id   INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    value      TEXT NOT NULL,
    sort       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_contact_channels ON contact_channels(owner_type, owner_id);
  CREATE TABLE contact_access (
    owner_type TEXT NOT NULL CHECK (owner_type IN ('org','person')),
    owner_id   INTEGER NOT NULL,
    role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (owner_type, owner_id, role_id)
  );
  `,
  // 21: Ticker (Laufband) fuer Schwarzes-Brett-Eintraege
  `
  ALTER TABLE board_posts ADD COLUMN ticker INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE board_posts ADD COLUMN ticker_audience TEXT NOT NULL DEFAULT 'all';
  ALTER TABLE board_posts ADD COLUMN ticker_until TEXT;
  `,
  // 22: Legal (Google-Dokumente wie die Gesetzessammlung, live eingebettet)
  `
  CREATE TABLE legal_docs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('document','spreadsheets','presentation')),
    doc_id     TEXT NOT NULL,
    tab        TEXT,
    url        TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 23: Lagerkosten – woechentliche Erinnerung (wann, an wen, wie teuer)
  `
  ALTER TABLE warehouses ADD COLUMN rent_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE warehouses ADD COLUMN rent_cents INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE warehouses ADD COLUMN rent_weekday INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE warehouses ADD COLUMN rent_hour INTEGER NOT NULL DEFAULT 18;
  ALTER TABLE warehouses ADD COLUMN rent_recipients TEXT NOT NULL DEFAULT '{"roles":[],"users":[]}';
  ALTER TABLE warehouses ADD COLUMN rent_last_date TEXT;
  `,
  // 24: Weitere Dateien (eigene Dokumente mit Name und Beschreibung) zu Mitgliedern und externen Zugaengen
  `
  CREATE TABLE extra_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type  TEXT NOT NULL CHECK (owner_type IN ('user','partner')),
    owner_id    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    ext         TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_extra_files_owner ON extra_files(owner_type, owner_id);
  `,
  // 25: Boerse – Sichtbarkeit der Artikel fuer externe Partner (je Artikel und je Partner) und „Sonstiges“
  `
  ALTER TABLE market_items ADD COLUMN partner_access TEXT NOT NULL DEFAULT 'all';
  ALTER TABLE market_items ADD COLUMN is_other INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE market_item_partners (
    item_id    INTEGER NOT NULL REFERENCES market_items(id) ON DELETE CASCADE,
    partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, partner_id)
  );
  ALTER TABLE partners ADD COLUMN items_mode TEXT NOT NULL DEFAULT 'all';
  ALTER TABLE partners ADD COLUMN allow_other INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE partner_items (
    partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    item_id    INTEGER NOT NULL REFERENCES market_items(id) ON DELETE CASCADE,
    PRIMARY KEY (partner_id, item_id)
  );
  ALTER TABLE market_deals ADD COLUMN other_name TEXT;
  INSERT INTO market_items (name, description, unit, is_active, is_other, partner_access, created_at, updated_at)
    VALUES ('Sonstiges', 'Platzhalter fuer Artikel, die noch nicht angelegt sind (Freitext des Partners)', 'Stück', 1, 1, 'none', datetime('now'), datetime('now'));
  `,
  // 26: Rechtsfaelle (Aktensystem der Legal-App)
  `
  CREATE TABLE legal_cases (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    case_number          TEXT NOT NULL UNIQUE,
    title                TEXT NOT NULL,
    status_id            INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    area_id              INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    measure_id           INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    priority             TEXT NOT NULL DEFAULT 'normal',
    court                TEXT NOT NULL DEFAULT '',
    summary              TEXT NOT NULL DEFAULT '',
    facts                TEXT NOT NULL DEFAULT '',
    charges              TEXT NOT NULL DEFAULT '',
    exposure_fine_cents  INTEGER NOT NULL DEFAULT 0,
    exposure_jail_days   INTEGER NOT NULL DEFAULT 0,
    exposure_damage_cents INTEGER NOT NULL DEFAULT 0,
    exposure_note        TEXT NOT NULL DEFAULT '',
    strategy             TEXT NOT NULL DEFAULT '',
    tags                 TEXT NOT NULL DEFAULT '',
    power_of_attorney    INTEGER NOT NULL DEFAULT 0,
    confidential         INTEGER NOT NULL DEFAULT 0,
    billing_mode         TEXT NOT NULL DEFAULT 'billable',
    lead_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    opened_at            TEXT NOT NULL,
    closed_at            TEXT,
    created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  );
  CREATE INDEX idx_legal_cases_updated ON legal_cases(updated_at);
  CREATE TABLE legal_case_team (
    case_id INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (case_id, user_id)
  );
  CREATE TABLE legal_case_parties (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id    INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    side       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    ref_id     INTEGER NOT NULL,
    role       TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_parties_case ON legal_case_parties(case_id);
  CREATE INDEX idx_legal_parties_ref ON legal_case_parties(kind, ref_id);
  CREATE TABLE legal_case_evidence (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    side        TEXT NOT NULL DEFAULT 'for',
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE legal_case_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'note',
    text        TEXT NOT NULL,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_legal_events_case ON legal_case_events(case_id, occurred_at);
  CREATE TABLE legal_case_appointments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id    INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'other',
    starts_at  TEXT NOT NULL,
    location   TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    done       INTEGER NOT NULL DEFAULT 0,
    reminded   INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_legal_appts ON legal_case_appointments(starts_at);
  CREATE TABLE legal_case_costs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id      INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL DEFAULT 'fee',
    description  TEXT NOT NULL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'open',
    billed_at    TEXT,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL
  );
  CREATE TABLE legal_case_docs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id     INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind        TEXT NOT NULL CHECK (kind IN ('link','file')),
    url         TEXT,
    ext         TEXT,
    size        INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE legal_case_links (
    case_id    INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    related_id INTEGER NOT NULL REFERENCES legal_cases(id) ON DELETE CASCADE,
    PRIMARY KEY (case_id, related_id)
  );
  `,
  // 27: Level-System fuer externe Partner (XP, Verlauf) und manuelle XP je Artikel
  `
  ALTER TABLE partners ADD COLUMN level_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE partners ADD COLUMN level_xp INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE partners ADD COLUMN level_since TEXT;
  ALTER TABLE market_items ADD COLUMN xp INTEGER;
  CREATE TABLE partner_xp_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    delta      INTEGER NOT NULL,
    xp_after   INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    ref_type   TEXT,
    ref_id     INTEGER,
    note       TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_xp_partner ON partner_xp_log(partner_id, id);
  CREATE UNIQUE INDEX idx_xp_ref ON partner_xp_log(partner_id, ref_type, ref_id) WHERE ref_type IS NOT NULL;
  `,
  // 28: Mitglieder handeln in der Boerse wie Partner (verdeckter Partner-Eintrag je Mitglied)
  `
  ALTER TABLE partners ADD COLUMN user_id INTEGER;
  CREATE UNIQUE INDEX idx_partners_user ON partners(user_id) WHERE user_id IS NOT NULL;
  `,
  // 29: Changelog – welches Mitglied hat welchen Eintrag (in welchem Stand) bestaetigt
  `
  CREATE TABLE changelog_ack (
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id         INTEGER NOT NULL REFERENCES changelog_entries(id) ON DELETE CASCADE,
    acked_updated_at TEXT NOT NULL,
    acked_at         TEXT NOT NULL,
    PRIMARY KEY (user_id, entry_id)
  );
  `,
  // 30: Changelog – Verlauf aller Bestaetigungen (wer hat wann welchen Stand gelesen)
  `
  CREATE TABLE changelog_ack_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_id     INTEGER,
    entry_title  TEXT NOT NULL,
    entry_version TEXT NOT NULL DEFAULT '',
    entry_updated_at TEXT NOT NULL,
    first_ack    INTEGER NOT NULL DEFAULT 1,
    acked_at     TEXT NOT NULL
  );
  CREATE INDEX idx_cl_ack_log_user ON changelog_ack_log(user_id, id);
  `,
  // 31: Schwarzes Brett – Pflicht-Bestaetigung neuer/geaenderter Eintraege (wie beim Changelog) mit Verlauf
  `
  ALTER TABLE board_posts ADD COLUMN content_at TEXT;
  CREATE TABLE board_ack (
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id          INTEGER NOT NULL REFERENCES board_posts(id) ON DELETE CASCADE,
    acked_updated_at TEXT NOT NULL,
    acked_at         TEXT NOT NULL,
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE board_ack_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id      INTEGER,
    post_title   TEXT NOT NULL,
    post_level   TEXT NOT NULL DEFAULT 'info',
    post_updated_at TEXT NOT NULL,
    first_ack    INTEGER NOT NULL DEFAULT 1,
    acked_at     TEXT NOT NULL
  );
  CREATE INDEX idx_board_ack_log_user ON board_ack_log(user_id, id);
  `,
  // 32: Lagerkosten – faellig seit / bezahlt am (Problemleiste bleibt, bis die Zahlung bestaetigt ist)
  `
  ALTER TABLE warehouses ADD COLUMN rent_due_date TEXT;
  ALTER TABLE warehouses ADD COLUMN rent_paid_date TEXT;
  `,
  // 33: Hilfe-App – ueberschriebene/eigene Kapitel, Rueckmeldungen, Tour-Status
  `
  CREATE TABLE help_articles (
    id         TEXT PRIMARY KEY,
    builtin    INTEGER NOT NULL DEFAULT 0,
    aud        TEXT,
    grp        TEXT,
    title      TEXT,
    icon       TEXT,
    summary    TEXT,
    perm       TEXT,
    sections   TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by INTEGER
  );
  CREATE TABLE help_feedback (
    article_id TEXT NOT NULL,
    who        TEXT NOT NULL,
    helpful    INTEGER NOT NULL,
    comment    TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (article_id, who)
  );
  CREATE TABLE help_state (
    who          TEXT PRIMARY KEY,
    tour_done_at TEXT
  );
  `,
  // 34: Termine & Auftraege (Kalender, Beteiligte, Erinnerungen, Auftraege mit Beauftragten)
  `
  CREATE TABLE cal_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    kind_id     INTEGER,
    description TEXT NOT NULL DEFAULT '',
    location    TEXT NOT NULL DEFAULT '',
    starts_at   TEXT NOT NULL,
    ends_at     TEXT,
    all_day     INTEGER NOT NULL DEFAULT 0,
    visibility  TEXT NOT NULL DEFAULT 'team',
    status      TEXT NOT NULL DEFAULT 'planned',
    reminders   TEXT NOT NULL DEFAULT '[]',
    created_by  INTEGER,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_cal_events_start ON cal_events(starts_at);
  CREATE TABLE cal_participants (
    event_id INTEGER NOT NULL REFERENCES cal_events(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rsvp     TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (event_id, user_id)
  );
  CREATE TABLE cal_tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority    TEXT NOT NULL DEFAULT 'normal',
    status      TEXT NOT NULL DEFAULT 'open',
    due_at      TEXT,
    event_id    INTEGER REFERENCES cal_events(id) ON DELETE SET NULL,
    created_by  INTEGER,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    done_at     TEXT
  );
  CREATE INDEX idx_cal_tasks_due ON cal_tasks(due_at);
  CREATE TABLE cal_task_assignees (
    task_id    INTEGER NOT NULL REFERENCES cal_tasks(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state      TEXT NOT NULL DEFAULT 'open',
    note       TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, user_id)
  );
  CREATE TABLE cal_reminder_log (
    kind    TEXT NOT NULL,
    ref_id  INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    off     INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (kind, ref_id, user_id, off)
  );
  `,
  // 35: Karte – frei eingezeichnete Bereiche/Zonen (Polygone in Spielkoordinaten)
  `
  CREATE TABLE map_zones (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind_id     INTEGER REFERENCES lookups(id) ON DELETE SET NULL,
    color       TEXT,
    opacity     REAL NOT NULL DEFAULT 0.25,
    points      TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'all' CHECK (visibility IN ('all','editors')),
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  `,
  // 36: Boerse – mehrere Items (Positionen) pro Geschaeft; die Spalten item_id/quantity/unit_price am Geschaeft spiegeln die erste Position
  `
  CREATE TABLE market_deal_lines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id         INTEGER NOT NULL REFERENCES market_deals(id) ON DELETE CASCADE,
    pos             INTEGER NOT NULL DEFAULT 0,
    item_id         INTEGER NOT NULL REFERENCES market_items(id),
    other_name      TEXT,
    quantity        INTEGER NOT NULL,
    unit_price      INTEGER NOT NULL,
    suggested_price INTEGER
  );
  CREATE INDEX idx_mdl_deal ON market_deal_lines(deal_id);
  CREATE INDEX idx_mdl_item ON market_deal_lines(item_id);
  INSERT INTO market_deal_lines (deal_id,pos,item_id,other_name,quantity,unit_price,suggested_price)
    SELECT id, 0, item_id, other_name, quantity, unit_price, suggested_price FROM market_deals;
  `,
  // 37: Watchlist (beobachtete Benutzer, z. B. Ex-Mitglieder) mit beauftragten Beobachtern
  `
  CREATE TABLE user_watch (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason     TEXT NOT NULL,
    added_by   INTEGER,
    added_at   TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE user_watch_observers (
    user_id     INTEGER NOT NULL REFERENCES user_watch(user_id) ON DELETE CASCADE,
    observer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, observer_id)
  );
  `,
  // 38: Partner-Bewertung (Sterne + Notiz), Aktivitaet und Abmeldungen der Mitglieder, Einarbeitungs-Checkliste
  `
  ALTER TABLE partners ADD COLUMN rating INTEGER;
  ALTER TABLE partners ADD COLUMN rating_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN last_active_at TEXT;
  UPDATE users SET last_active_at = last_login_at WHERE status = 'active' AND last_login_at IS NOT NULL;
  CREATE TABLE user_activity (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day     TEXT NOT NULL,
    PRIMARY KEY (user_id, day)
  );
  CREATE TABLE user_absences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_date  TEXT NOT NULL,
    to_date    TEXT NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_absences_user ON user_absences(user_id, to_date);
  CREATE TABLE onboarding_steps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    confirm_by  TEXT NOT NULL DEFAULT 'leader' CHECK (confirm_by IN ('leader','self')),
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE user_onboarding (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    started_at   TEXT NOT NULL,
    completed_at TEXT,
    skipped      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE onboarding_progress (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    step_id INTEGER NOT NULL REFERENCES onboarding_steps(id) ON DELETE CASCADE,
    done_by INTEGER,
    done_at TEXT NOT NULL,
    PRIMARY KEY (user_id, step_id)
  );
  `,
];
