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

Casa e trabalho (aba Postos) ficam na tabela `user_places`, com a mesma regra: só o dono lê. Guardamos rua, bairro e o ponto no mapa, sem o número; a localização do GPS é usada na hora e não é gravada.

## Postos

A aba Postos usa só dados públicos, gerados toda semana pelo workflow `dados.yml` (`pipeline/postos.py`):

- **Cadastro de revendedores da ANP**: todos os postos autorizados, com endereço e bandeira.
- **Levantamento de Preços da ANP (LPC)**: preços por posto das últimas 6 semanas (a pesquisa é uma amostra, nem todo posto tem preço toda semana). O preço que você pagou num posto vale como dado mais recente.
- **Fiscalização da ANP**: autos de infração, interdições e notificações dos últimos 5 anos, base da nota de confiabilidade.
- **Coordenadas**: endereço → ponto pelo Nominatim (OpenStreetMap), 1 consulta por segundo, com cache na branch `dados`.
- **Notas do Google** (opcional): a função `postos-google` usa a Places API quando o segredo `GOOGLE_MAPS_API_KEY` está configurado no Supabase.
- **Caminho casa → trabalho**: calculado uma vez pelo OSRM (servidor público) e guardado na conta.

O arquivo resultante (`dados/postos-SC.json`) é publicado junto com o app.

## Desenvolvimento

```bash
npm install
npm run dev      # servidor local
npm run check    # TypeScript
npm test         # cálculos de consumo e de postos (dados fictícios)
python -m unittest pipeline/test_postos.py   # gerador de dados dos postos
npm run build    # gera dist/ com o service worker
```

## Fases

| Fase | Entrega | Status |
| --- | --- | --- |
| 0 | Repositório, deploy no Pages, projeto Supabase | validada |
| 1 | App offline: abastecimentos, carros, backup | validada |
| 2 | Sincronização com Supabase e login por link no e-mail | validada (falta teste em 2 aparelhos) |
| 3 | Manutenção com plano do fabricante e leitura de OS (PDF ou foto) | em validação |
| — | Redesign, indicadores e gráficos | validada |
| — | Postos: preços, confiabilidade, casa e trabalho | em validação |
| 4 | Pesquisa de plano do fabricante e APK | — |

## Backlog

1. Registrar o dia em que calibrou os pneus.
2. Leitura de OS pela API do Claude (falta o segredo `ANTHROPIC_API_KEY`).
3. Foto do manual para confirmar o plano de manutenção do Creta.
4. Notas do Google nos postos (falta o segredo `GOOGLE_MAPS_API_KEY`).
5. Fase 4: pesquisa do plano do fabricante e APK.
6. Casa e trabalho: o texto da busca de um passa para o outro (bug); trocar o botão Buscar por sugestões enquanto digita (Places Autocomplete do Google, com espera curta entre teclas e token de sessão para não gastar cota).

## Licença

MIT
