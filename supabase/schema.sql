-- ============================================================
-- DayCount (Schengen 90/180) – Datenbank-Schema für Supabase
-- Einmal komplett im Supabase "SQL Editor" ausführen.
-- ============================================================

-- Profile: jede Person, für die Aufenthalte gezählt werden.
-- is_self = das eigene Profil eines Accounts; sonst eine mitverwaltete Person ohne Account.
create table if not exists public.profiles (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_email text not null default lower(coalesce(auth.jwt() ->> 'email', '')),
  name        text not null check (char_length(trim(name)) between 1 and 40),
  is_self     boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists profiles_one_self on public.profiles(owner_id) where is_self;

-- Freigaben: wer außer dem Besitzer ein Profil sehen und bearbeiten darf
create table if not exists public.profile_members (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  email      text not null,
  added_at   timestamptz not null default now(),
  primary key (profile_id, user_id)
);

-- Einladungen an E-Mails, die noch keinen Account haben
create table if not exists public.invites (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  email      text not null,
  invited_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, email)
);

-- Aufenthalte. end_date = null bedeutet: Person ist gerade noch im Schengen-Raum.
create table if not exists public.stays (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  country     text not null check (country ~ '^[A-Z]{2}$'),
  start_date  date not null check (start_date between '2000-01-01' and '2100-12-31'),
  end_date    date check (end_date is null or (end_date >= start_date and end_date <= '2100-12-31')),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists stays_profile on public.stays(profile_id);
-- höchstens ein offener Aufenthalt pro Person
create unique index if not exists stays_one_open on public.stays(profile_id) where end_date is null;

-- ------------------------------------------------------------
-- Zugriffsprüfung
-- ------------------------------------------------------------
create or replace function public.can_access(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = p and owner_id = auth.uid())
      or exists (select 1 from profile_members where profile_id = p and user_id = auth.uid());
$$;

create or replace function public.is_owner(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = p and owner_id = auth.uid());
$$;

-- Ausdrückliche Freigaben für die Daten-API (nötig, wenn "Neue Tabellen automatisch anzeigen" aus ist).
-- Nur angemeldete Nutzer dürfen überhaupt zugreifen – und auch dann nur auf das, was die Regeln unten erlauben.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.profile_members, public.invites, public.stays to authenticated;
revoke all on public.profiles, public.profile_members, public.invites, public.stays from anon;

alter table public.profiles        enable row level security;
alter table public.profile_members enable row level security;
alter table public.invites         enable row level security;
alter table public.stays           enable row level security;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
drop policy if exists profiles_delete on public.profiles;
-- owner_id = auth.uid() direkt an der Zeile prüfen: beim Anlegen (INSERT … RETURNING) ist die neue Zeile
-- für die Unterabfrage in can_access() noch nicht sichtbar – sonst schlägt das Anlegen fehl.
create policy profiles_select on public.profiles for select using (owner_id = auth.uid() or public.can_access(id));
create policy profiles_insert on public.profiles for insert with check (owner_id = auth.uid());
create policy profiles_update on public.profiles for update using (owner_id = auth.uid() or public.can_access(id)) with check (owner_id = auth.uid() or public.can_access(id));
create policy profiles_delete on public.profiles for delete using (owner_id = auth.uid() and not is_self);

drop policy if exists members_select on public.profile_members;
drop policy if exists members_delete on public.profile_members;
create policy members_select on public.profile_members for select using (public.can_access(profile_id));
-- Besitzer kann Zugriff entziehen, Mitglied kann selbst austreten
create policy members_delete on public.profile_members for delete using (public.is_owner(profile_id) or user_id = auth.uid());

drop policy if exists invites_select on public.invites;
drop policy if exists invites_delete on public.invites;
create policy invites_select on public.invites for select using (public.is_owner(profile_id));
create policy invites_delete on public.invites for delete using (public.is_owner(profile_id));

drop policy if exists stays_all on public.stays;
create policy stays_all on public.stays for all using (public.can_access(profile_id)) with check (public.can_access(profile_id));

-- Felder, die der Client nicht selbst setzen oder verändern darf
create or replace function public.protect_profile() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.owner_id := auth.uid();
    new.owner_email := lower(coalesce(auth.jwt() ->> 'email', ''));
    new.created_at := now();
  else
    new.owner_id := old.owner_id; new.owner_email := old.owner_email;
    new.is_self := old.is_self;   new.created_at := old.created_at;
  end if;
  new.name := trim(new.name);
  return new;
end $$;
drop trigger if exists protect_profile on public.profiles;
create trigger protect_profile before insert or update on public.profiles for each row execute function public.protect_profile();

create or replace function public.protect_stay() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid(); new.created_at := now();
  else new.created_by := old.created_by; new.created_at := old.created_at; end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists protect_stay on public.stays;
create trigger protect_stay before insert or update on public.stays for each row execute function public.protect_stay();

-- ------------------------------------------------------------
-- Profil freigeben: per E-Mail. Hat die Person schon einen Account,
-- bekommt sie sofort Zugriff, sonst wird eine Einladung hinterlegt.
-- ------------------------------------------------------------
create or replace function public.share_profile(p_profile uuid, p_email text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
  v_user  uuid;
begin
  if not public.is_owner(p_profile) then raise exception 'not allowed' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email'; end if;
  if v_email = lower(coalesce(auth.jwt() ->> 'email', '')) then return 'self'; end if;
  select id into v_user from auth.users where lower(email) = v_email and email_confirmed_at is not null;
  if v_user is not null then
    insert into profile_members(profile_id, user_id, email) values (p_profile, v_user, v_email) on conflict do nothing;
    return 'added';
  end if;
  insert into invites(profile_id, email) values (p_profile, v_email) on conflict do nothing;
  return 'invited';
end $$;

-- Beim Anmelden: Einladungen an die eigene (bestätigte) E-Mail einlösen
create or replace function public.claim_invites()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_count integer;
begin
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null then return 0; end if;
  insert into profile_members(profile_id, user_id, email)
    select profile_id, auth.uid(), v_email from invites where email = v_email
    on conflict do nothing;
  get diagnostics v_count = row_count;
  delete from invites where email = v_email;
  return v_count;
end $$;

grant execute on function public.can_access(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;
revoke all on function public.share_profile(uuid, text) from public, anon;
revoke all on function public.claim_invites() from public, anon;
grant execute on function public.share_profile(uuid, text) to authenticated;
grant execute on function public.claim_invites() to authenticated;

-- Live-Updates für andere Geräte
do $$ begin
  alter publication supabase_realtime add table public.stays, public.profiles, public.profile_members;
exception when duplicate_object then null; end $$;
