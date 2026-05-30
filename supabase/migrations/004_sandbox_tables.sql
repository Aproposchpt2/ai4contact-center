-- Sandbox tables for FlowDesk Pro Conversational Agent Sandbox
-- Tracks call sessions and quality scorecard submissions per profile/model combo.

-- Call session log — one row per sandbox call
create table if not exists sandbox_call_sessions (
  id              bigserial primary key,
  call_sid        text        not null,
  profile_key     text        not null,
  profile_label   text,
  model           text        not null default 'gpt-4o-mini',
  temperature     numeric(4,2),
  status          text        not null default 'active',  -- active | completed | abandoned
  history         jsonb,
  turn_count      integer     default 0,
  lead_data       jsonb,
  ai_metadata     jsonb,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  updated_at      timestamptz default now(),

  constraint sandbox_call_sessions_call_sid_unique unique (call_sid)
);

create index if not exists idx_sandbox_sessions_call_sid     on sandbox_call_sessions (call_sid);
create index if not exists idx_sandbox_sessions_profile_key  on sandbox_call_sessions (profile_key);
create index if not exists idx_sandbox_sessions_model        on sandbox_call_sessions (model);
create index if not exists idx_sandbox_sessions_started_at   on sandbox_call_sessions (started_at desc);

-- Scorecard log — one row per human quality review
create table if not exists sandbox_scorecard_logs (
  id              bigserial primary key,
  call_sid        text        not null,
  profile_key     text        not null,
  profile_label   text,
  model           text,
  temperature     numeric(4,2),
  tester_name     text,
  scenario        text,
  scores          jsonb       not null,  -- { greeting_quality:8, naturalness:7, ... }
  aggregate_score numeric(4,1),
  corporate_ready boolean     default false,
  notes           text,
  turn_count      integer,
  ai_metadata     jsonb,
  submitted_at    timestamptz not null default now()
);

create index if not exists idx_scorecard_call_sid        on sandbox_scorecard_logs (call_sid);
create index if not exists idx_scorecard_profile_key     on sandbox_scorecard_logs (profile_key);
create index if not exists idx_scorecard_model           on sandbox_scorecard_logs (model);
create index if not exists idx_scorecard_corporate_ready on sandbox_scorecard_logs (corporate_ready);
create index if not exists idx_scorecard_submitted_at    on sandbox_scorecard_logs (submitted_at desc);

-- RLS: service role only (no public reads)
alter table sandbox_call_sessions  enable row level security;
alter table sandbox_scorecard_logs enable row level security;
