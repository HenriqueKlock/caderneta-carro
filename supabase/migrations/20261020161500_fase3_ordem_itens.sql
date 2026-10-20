-- Ordem dos itens dentro da OS, para reabrir a manutenção como foi lançada
alter table public.service_items add column if not exists position int not null default 0 check (position >= 0);
