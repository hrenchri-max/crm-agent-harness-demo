-- Agent run storage for Postgres on Supabase.
-- agent_events is the source of truth. agent_runs (status, memo) and agent_actions are projections
-- the worker updates in the same transaction as the events it appends.

create table agent_runs (
  id          uuid primary key default gen_random_uuid(),
  rep_id      uuid not null references auth.users (id),
  request     text not null,
  status      text not null default 'created'
              check (status in ('created', 'running', 'awaiting_approval', 'executing', 'completed', 'failed', 'cancelled')),
  memo        jsonb not null default '{}'::jsonb,   -- goal, facts, decisions, pending
  last_seq    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table agent_events (
  run_id   uuid not null references agent_runs (id),
  seq      integer not null,
  rep_id   uuid not null,          -- copied from the run so the RLS policy reads one table
  type     text not null,          -- run_created, model_response, tool_called, permission_denied, ...
  actor    text not null,          -- agent | harness | policy | system | the deciding rep
  payload  jsonb not null,
  at       timestamptz not null default now(),
  primary key (run_id, seq)        -- two writers racing for the same seq: one insert fails
);

create table agent_actions (
  id               text not null,  -- the tool_use id that proposed the write
  run_id           uuid not null references agent_runs (id),
  rep_id           uuid not null,
  tool             text not null,
  risk             text not null check (risk in ('low', 'medium', 'high')),
  input            jsonb not null,
  final_input      jsonb,
  status           text not null check (status in ('pending_approval', 'approved', 'rejected', 'executed', 'failed')),
  idempotency_key  text not null unique,   -- the executor's at-most-once guarantee
  attempts         integer not null default 0,
  decided_by       text,
  decided_at       timestamptz,
  reject_reason    text,
  result           jsonb,
  primary key (run_id, id)
);

create index agent_runs_rep_idx on agent_runs (rep_id, updated_at desc);
create index agent_actions_pending_idx on agent_actions (rep_id) where status = 'pending_approval';

-- Append-only: an event is never edited. Deletes are reserved for the retention job (table owner).
create function agent_events_reject_update() returns trigger language plpgsql as $$
begin
  raise exception 'agent_events is append-only';
end $$;
create trigger agent_events_append_only before update on agent_events
  for each row execute function agent_events_reject_update();

alter table agent_runs enable row level security;
alter table agent_events enable row level security;
alter table agent_actions enable row level security;

-- Reps read their own runs, events and proposals (this also scopes Supabase Realtime).
create policy runs_read_own on agent_runs for select to authenticated using (rep_id = (select auth.uid()));
create policy events_read_own on agent_events for select to authenticated using (rep_id = (select auth.uid()));
create policy actions_read_own on agent_actions for select to authenticated using (rep_id = (select auth.uid()));

-- The queue worker gets its own narrow role instead of the service-role key.
create role agent_worker nologin;
grant select, insert on agent_events to agent_worker;
grant select, insert, update on agent_runs, agent_actions to agent_worker;
create policy worker_runs on agent_runs for all to agent_worker using (true) with check (true);
create policy worker_events on agent_events for all to agent_worker using (true) with check (true);
create policy worker_actions on agent_actions for all to agent_worker using (true) with check (true);

-- The rep's decision at the approval gate, called with the rep's own JWT. The API validates an
-- edited input against the tool schema first, then enqueues the next step once nothing is pending.
create function decide_agent_action(p_run_id uuid, p_action_id text, p_decision text, p_input jsonb default null, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_rep uuid;
  v_seq integer;
begin
  if p_decision not in ('approve', 'edit', 'reject') then raise exception 'unknown decision %', p_decision; end if;
  if p_decision = 'reject' and coalesce(btrim(p_reason), '') = '' then raise exception 'a rejection needs a reason'; end if;

  select rep_id into v_rep from agent_actions
   where run_id = p_run_id and id = p_action_id and rep_id = auth.uid() and status = 'pending_approval'
   for update;
  if not found then raise exception 'no pending action % for this rep', p_action_id; end if;

  update agent_runs set last_seq = last_seq + 1, updated_at = now()
   where id = p_run_id and status = 'awaiting_approval'
   returning last_seq into v_seq;
  if not found then raise exception 'run % is not awaiting approval', p_run_id; end if;

  insert into agent_events (run_id, seq, rep_id, type, actor, payload)
  values (p_run_id, v_seq, v_rep, 'approval_decided', auth.uid()::text,
          jsonb_build_object('actionId', p_action_id, 'by', auth.uid(),
            'decision', jsonb_strip_nulls(jsonb_build_object('type', p_decision, 'input', p_input, 'reason', p_reason))));

  update agent_actions
     set status = case when p_decision = 'reject' then 'rejected' else 'approved' end,
         final_input = case when p_decision = 'edit' then input || coalesce(p_input, '{}'::jsonb) else input end,
         decided_by = auth.uid()::text, decided_at = now(), reject_reason = p_reason
   where run_id = p_run_id and id = p_action_id;
end $$;
revoke all on function decide_agent_action(uuid, text, text, jsonb, text) from public;
grant execute on function decide_agent_action(uuid, text, text, jsonb, text) to authenticated;

-- The CRM tables follow the same rule. Agent tools query them with the rep's JWT, so a policy like
-- this, not the prompt, is what stops the agent from reading another rep's deal:
--   create policy deals_owner on deals for all to authenticated
--     using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
