# cnpj-discovery

Da ideia ao lead qualificado, com dados abertos da Receita Federal. Quatro abas, na
ordem em que o trabalho acontece:

1. **Projeto** — o que você vende e o perfil de cliente ideal (ICP)
2. **Descoberta** — o modelo sugere CNAEs; você escolhe; sai a lista de empresas
3. **Enriquecimento** — descoberta de site e crawl, um botão por empresa
4. **Pontuação** — o modelo pontua, escreve o gancho e o conselho

**Custo: R$ 0.** Os dados da Receita são públicos e os modelos padrão do OpenRouter são
gratuitos. A única etapa que gastaria dinheiro — Google Places — vem desligada.

```bash
pnpm install
cp .env.example .env      # preencha OPEN_ROUTER_API_KEY
pnpm data:sync            # baixa e converte a base (~14 min, 2,9 GB de download)
pnpm db:migrate
pnpm dev                  # http://localhost:3200
```

---

## Como a base funciona

Não existe API gratuita que busque empresas por CNAE. Todas as que existem
(CNPJá, CNPJ.ws, NextAPI) cobram pela *busca*; as gratuitas consultam **um** CNPJ
por vez, o que não serve para descobrir nada. Então a base é local:

```
ZIPs mensais da Receita  →  filtro no meio do stream  →  Parquet  →  DuckDB
```

O filtro acontece **enquanto** o arquivo é lido, não depois: uma linha que não passa
nunca toca o disco. Só `situacao = '02'` (ativa) já corta 60% do arquivo, e das 34
colunas do layout guardamos 13.

O resultado é uma "API" com filtros e ordenação de verdade, rodando no processo:

```ts
listCompanies({
  filters: { cnae: ["8520100"], uf: ["SP"], hasPhone: true },
  order: "founded-desc",   // ORDER BY data_inicio_atividade DESC
  limit: 50,
})
```

Medido numa carga real (período 2026-08, parte 0):

| | |
|---|---|
| linhas lidas | 30.008.725 |
| **estabelecimentos ativos guardados** | **11.993.902** (40,0%) |
| com telefone | 97,3% |
| Parquet em disco | **944 MB** |
| tempo total | 14 min |
| consulta típica | 12–50 ms |

Para comparação, o projeto anterior gastava **2,96 GB de Postgres para 2,1 milhões**
de empresas de seis CNAEs. Aqui é o país inteiro em menos espaço, sem Docker e sem
servidor de banco.

### As partes 0-9 não são iguais — e a parte 0 é a que importa

A Receita publica `Estabelecimentos0.zip` … `Estabelecimentos9.zip`. É tentador
tratá-las como um sorteio uniforme e testar com uma parte pequena. **Não são.**
A parte 0 tem 2 GB contra ~330 MB das outras, e é onde estão as empresas recentes:

| | parte 1 | parte 0 |
|---|---|---|
| abertas em 2025 | 27 | 1.986.212 |
| abertas em 2026 | 14 | 1.683.032 |
| última abertura com volume | **maio de 2021** | mês corrente |

Uma lista "mais novas primeiro" construída sobre as partes 1-9 devolve empresas de
2021 e parece funcionar. Por isso `pnpm data:sync` baixa a parte 0 por padrão.

### A fonte é a Receita, não um espelho

`https://arquivos.receitafederal.gov.br/public.php/dav/files/YggdBLfdninEJX9/` — um
compartilhamento público Nextcloud que fala WebDAV. O espelho em CDN que outras
ferramentas usam serve os mesmos bytes, mas atrasa um mês.

---

## O que o código garante

**Um telefone de 8 dígitos não é um fixo.** A Receita guarda os telefones no formato
anterior à migração do nono dígito, e a `libphonenumber` corretamente rejeita um
celular brasileiro de 8 dígitos. Sem o reparo em
[`phone.ts`](packages/core/src/domain/phone.ts), a taxa medida de celulares é 2,5%;
com ele, 70%. É a diferença entre uma base contatável e uma inútil.

**O modelo inventa CNAE.** Não é um talvez. Pedindo "escolas de ensino médio", o
compilador respondeu `8599` e escreveu "(ensino médio)" ao lado. `8599` é
*"Formação de condutores; Cursos de pilotagem; …"* — ensino médio é `8520100`. Toda
sugestão é resolvida contra a tabela oficial antes de aparecer, e a tela mostra três
situações diferentes:

| | |
|---|---|
| `existe` | o código existe e tem empresas |
| `sem empresas` | o código existe, mas nada casa com os outros filtros |
| `código inventado` | não existe. O modelo criou. |

Um prefixo válido de 4 dígitos (`85`, `8599`) é resolvido pelas subclasses abaixo
dele — acusar um prefixo legítimo de ser inventado é o erro oposto, e igualmente ruim.

**Uma chamada que falha grava `NULL`, nunca um número.** Um 5 inventado fica para
sempre acima dos 4 verdadeiros e nada na tela indicaria que foi chute. Erro vai para
a coluna `error`, notas ficam vazias, e a linha aparece na aba "Falharam".

**"Não procurei" é diferente de "procurei e não achei".** Quando a página não foi
lida, os sinais ficam `null`, não `false`. Quando foi lida inteira e nenhum termo do
produto apareceu, o prompt diz isso na cara em vez de esperar que o modelo conclua.

**O que o seu ICP não virou.** A Receita não tem quadro de pessoal, faturamento nem
stack. Um critério desses não vira filtro — e o painel diz isso, critério por critério:

```
 filtro    escolas particulares de ensino médio    cnaePrefixes 8599
 filtro    localizadas em SP                       uf: SP
 filtro    não-MEI                                 excludeMei
 não deu   mais de 50 funcionários                 a base não traz número de funcionários
```

**O crawl respeita robots.txt** e espera 1s entre requisições ao mesmo host — os dois
faltavam na versão anterior, o que era defensável quando era uma home por empresa e
deixa de ser num crawl que segue links.

**Dado do Google fica separado.** Os termos do Places permitem guardar o `place_id` e
nada mais. Por isso ele tem tabela própria (`places_lookups`), onde não existe coluna
para nome, telefone ou avaliação.

---

## Estrutura

```
apps/web/           Next.js 16 (App Router) + tRPC 11
packages/core/      domínio puro — sem I/O, sem process.env, sem console
  domain/           phone, probes, spec, prompt, icp
  usecases/         compileSpec, suggestCnaes, crawl, scoreCompanies
  adapters/         openrouter
packages/data/      DuckDB sobre Parquet + o sync da Receita
packages/db/        SQLite (Drizzle) — só o que o app produz
packages/jobs/      trabalho longo no processo, progresso na tabela jobs
scripts/sync-rf.ts  baixa → filtra → Parquet. Roda no terminal, nunca no app.
```

Dois bancos, separados pelo padrão de escrita: **DuckDB sobre Parquet** para a base da
Receita (só leitura, colunar, sem servidor) e **SQLite** para o que o app produz
(projetos, ICP, empresas escolhidas, crawls, notas). Uma empresa só entra no SQLite
quando você a escolhe — é o único momento em que algo da Receita é gravado.

O `sync` roda no terminal de propósito: são 14 minutos, e um `next dev` reiniciando
mataria o processo no meio. Crawl e pontuação rodam no processo, em pedaços
retomáveis, com progresso na tabela `jobs` — e um índice único parcial garante um
trabalho por vez, no banco e não no JavaScript.

## Comandos

| | |
|---|---|
| `pnpm dev` | painel em http://localhost:3200 |
| `pnpm data:sync` | baixa e converte a base (`--parts 0,1,…`, `--dry-run`, `--period`) |
| `pnpm db:migrate` | aplica o schema SQLite |
| `pnpm test` | testes |
| `pnpm typecheck` | tsc em todos os pacotes |

Depois do `data:sync`, `data/downloads/` pode ser apagado — são 2,9 GB de ZIPs que só
servem para reconverter sem baixar de novo.

⚠️ **Não exponha essa porta na rede.** O painel não tem autenticação e foi feito para
`localhost`.
