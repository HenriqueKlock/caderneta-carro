# Caderneta do Carro

Abastecimentos, consumo e manutenção do carro num app que funciona sem internet.

- **PWA** instalável no celular, com service worker: abre do zero mesmo sem rede.
- **IndexedDB (Dexie.js)** como base principal: tudo grava primeiro no aparelho.
- **Supabase** como cópia na nuvem (sincronização na fase 2), com Row Level Security: cada pessoa só enxerga as próprias linhas.
- **GitHub Pages** hospeda os arquivos estáticos; deploy automático a cada push na `main`.

## Privacidade

Este repositório é público, e os dados não estão nele. Ficam fora do repositório:

- abastecimentos, manutenções e PDFs de ordens de serviço;
- chaves privadas (`service_role` do Supabase, API do Claude), que ficam só nos segredos do Supabase;
- arquivos de backup (`*.backup.json` está no `.gitignore`).

A chave pública do Supabase pode aparecer no código: ela só acessa o que as regras de RLS liberam para o usuário logado.

## Desenvolvimento

```bash
npm install
npm run dev      # servidor local
npm run check    # TypeScript
npm test         # cálculos de consumo (dados fictícios)
npm run build    # gera dist/ com o service worker
```

## Fases

| Fase | Entrega | Status |
| --- | --- | --- |
| 0 | Repositório, deploy no Pages, projeto Supabase | validada |
| 1 | App offline: abastecimentos, carros, backup | validada |
| 2 | Sincronização com Supabase e login por código no e-mail | em validação |
| 3 | Manutenção com leitura de OS em PDF | — |
| 4 | Pesquisa de plano do fabricante e APK | — |

## Licença

MIT
