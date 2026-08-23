# cnpj-discovery

Da ideia ao lead qualificado, com dados abertos da Receita Federal.

Duas abas, seguindo o modelo de dados e não o fluxo de processamento:

- **Projetos** — o que você vende, o perfil de cliente ideal (ICP), a rubrica
  compilada e os CNAEs alvo. Um CNAE só existe dentro de um projeto
  (`cnae_picks` é chaveado por `project_id`), então mora aqui.
- **Empresas** — todas as empresas do projeto, com tudo que se sabe sobre cada
  uma. Enriquecer, pontuar e marcar são **verbos aplicados a uma seleção**:
  marque as linhas e rode a rotina em cima delas.

Dividir por etapa dava quatro telas mostrando as mesmas linhas em estados
diferentes, e obrigava a navegar para trocar de verbo.

**Custo: R$ 0.** Os dados da Receita são públicos e os modelos padrão são gratuitos
nos dois provedores. A única etapa que gastaria dinheiro — Google Places — vem
desligada.

**Gemini ou OpenRouter**, o que estiver no `.env`. Com os dois, o Gemini ganha: o
nível gratuito do OpenRouter dá 50 requisições por dia, que o processamento
contínuo gasta em menos de uma hora, enquanto o do Gemini dá algumas centenas por
modelo. `LLM_PROVIDER=openrouter` força o outro.

O `.env` fica na **raiz do repositório**, não em `apps/web`. O Next lê `.env` a
partir da própria pasta do app, então `next.config.ts` carrega o da raiz
explicitamente — e os scripts usam `--env-file-if-exists`. Em ambos os casos uma
variável já presente no shell continua ganhando do arquivo.

```bash
pnpm install
cp .env.example .env      # preencha GEMINI_API_KEY (ou OPEN_ROUTER_API_KEY)
pnpm data:sync            # baixa e converte a base (~14 min, 2,9 GB de download)
pnpm db:migrate
pnpm dev                  # http://localhost:3200
```

---

## Como a base funciona

Não existe API gratuita que busque empresas por CNAE. Todas as que existem
(CNPJá, CNPJ.ws, NextAPI) cobram pela _busca_; as gratuitas consultam **um** CNPJ
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
  order: "founded-desc", // ORDER BY data_inicio_atividade DESC
  limit: 50,
});
```

Medido numa carga real (período 2026-08, parte 0):

|                                       |                        |
| ------------------------------------- | ---------------------- |
| linhas lidas                          | 30.008.725             |
| **estabelecimentos ativos guardados** | **11.993.902** (40,0%) |
| com telefone                          | 97,3%                  |
| Parquet em disco                      | **944 MB**             |
| tempo total                           | 14 min                 |
| consulta típica                       | 12–50 ms               |

Para comparação, o projeto anterior gastava **2,96 GB de Postgres para 2,1 milhões**
de empresas de seis CNAEs. Aqui é o país inteiro em menos espaço, sem Docker e sem
servidor de banco.

### As partes 0-9 não são iguais — e a parte 0 é a que importa

A Receita publica `Estabelecimentos0.zip` … `Estabelecimentos9.zip`. É tentador
tratá-las como um sorteio uniforme e testar com uma parte pequena. **Não são.**
A parte 0 tem 2 GB contra ~330 MB das outras, e é onde estão as empresas recentes:

|                            | parte 1          | parte 0      |
| -------------------------- | ---------------- | ------------ |
| abertas em 2025            | 27               | 1.986.212    |
| abertas em 2026            | 14               | 1.683.032    |
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
_"Formação de condutores; Cursos de pilotagem; …"_ — ensino médio é `8520100`. Toda
sugestão é resolvida contra a tabela oficial antes de aparecer, e a tela mostra três
situações diferentes:

|                    |                                                      |
| ------------------ | ---------------------------------------------------- |
| `existe`           | o código existe e tem empresas                       |
| `sem empresas`     | o código existe, mas nada casa com os outros filtros |
| `código inventado` | não existe. O modelo criou.                          |

Um prefixo válido de 4 dígitos (`85`, `8599`) é resolvido pelas subclasses abaixo
dele — acusar um prefixo legítimo de ser inventado é o erro oposto, e igualmente ruim.

**Uma chamada que falha grava `NULL`, nunca um número.** Um 5 inventado fica para
sempre acima dos 4 verdadeiros e nada na tela indicaria que foi chute. Erro vai para
a coluna `error`, notas ficam vazias, e a linha aparece na aba "Falharam".

**"Não procurei" é diferente de "procurei e não achei".** Quando a página não foi
lida, os sinais ficam `null`, não `false`. Quando foi lida inteira e nenhum termo do
produto apareceu, o prompt diz isso na cara em vez de esperar que o modelo conclua.

**Um nome confirmado é a pessoa, não o negócio.** A razão social de um MEI é o nome
civil do dono, então achar "Maria Raquel Ribeiro Marques" na web confirma que existe
_uma_ pessoa com esse nome — não que seja _esta_. Quem fecha essa distância é a
descrição: um Instagram cuja bio diz "preparatório para concursos" se confirma
sozinho. No LinkedIn a distância é maior, porque o endereço e o texto do perfil são
gerados a partir do nome e não confirmam nada — e sobrenome comum no Brasil é a
regra. Por isso um perfil só conta como evidência se o cargo disser o que a pessoa
faz, dois perfis com o mesmo nome na mesma busca não contam nenhum, e a decisão de
"isso é o negócio dele ou o emprego dele em outro lugar" é do modelo, com a regra
escrita no prompt.

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

**Erro de rede tem nome.** O `fetch` do Node relata tudo como "fetch failed" e esconde
o motivo em `cause`. Aqui isso decide coisas opostas: "domínio não existe" significa
que o palpite pelo e-mail estava errado; "conexão recusada" significa que estava certo
e o site caiu.

**Dado do Google fica separado.** Os termos do Places permitem guardar o `place_id` e
nada mais. Por isso ele tem tabela própria (`places_lookups`), onde não existe coluna
para nome, telefone ou avaliação — e a máscara de campos pede só `id` e `websiteUri`,
porque um campo que nunca foi buscado não tem como ser guardado por engano.

É a única etapa que gasta dinheiro, então: desligada sem chave, teto mensal da cota
gratuita conferido **antes** da requisição, e sem escape para "pode cobrar". Quando a
cota acaba no meio de um lote, o que já foi consultado fica salvo e o botão diz onde
parou — cota esgotada é um resultado, não uma falha.

**Nem toda heurística pega tudo, e tudo bem.** O e-mail `francisco@senoecosseno.com.br`
passou pelo filtro de contabilidade (o nome é um trocadilho com seno e cosseno). O
crawl leu a página, o título era "Seno e Cosseno — Soluções Contábeis", e o modelo
reprovou por ramo. Nenhuma regex ia pegar isso; ler a página pegou.

---

## Estrutura

```
apps/web/           Next.js 16 (App Router) + tRPC 11
packages/core/      domínio puro — sem I/O, sem process.env, sem console
  domain/           phone, probes, spec, prompt, icp
  usecases/         compileSpec, suggestCnaes, crawl, scoreCompanies
  adapters/         openrouter, gemini
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

|                   |                                                                    |
| ----------------- | ------------------------------------------------------------------ |
| `pnpm dev`        | painel em http://localhost:3200                                    |
| `pnpm data:sync`  | baixa e converte a base (`--parts 0,1,…`, `--dry-run`, `--period`) |
| `pnpm db:migrate` | aplica o schema SQLite                                             |
| `pnpm test`       | testes                                                             |
| `pnpm typecheck`  | tsc em todos os pacotes                                            |

Depois do `data:sync`, `data/downloads/` pode ser apagado — são 2,9 GB de ZIPs que só
servem para reconverter sem baixar de novo.

⚠️ **Não exponha essa porta na rede.** O painel não tem autenticação e foi feito para
`localhost`.
