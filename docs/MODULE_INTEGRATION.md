# Integração determinística de módulos

`module:integrate` prepara e aplica o registro de servidor, rota autenticada, menu e importação de testes para módulos `owner-crud` v1 e receitas v2. Não concede permissões de negócio nem qualifica o módulo por geração.

1. Gere com `module:new` ou `recipe:new`. Leia o manifesto e os métodos internos utilizados.
2. Implemente `imports/modules/<nome>/custom/server/ports.ts`. Para receitas, exporte `ports: Omit<RecipePorts,'repository'>`; para owner CRUD, exporte `context: ContextBuilder`. A identidade deve vir da invocação e consultar contas/perfis ativos. Não use um resolvedor permissivo de fixture em aplicações.
3. Implemente `custom/server/acceptance.test.ts` com critérios independentes de produto, negações, concorrência e persistência. Para master/detail, forneça também `custom/ui/Page.tsx`, que seleciona um pai autorizado e envolve a página gerada; a validação de pai no servidor permanece obrigatória.
4. Crie um documento JSON como `{ "schemaVersion": 1, "module": "ownednotes", "label": "Minhas notas" }`.
5. Prepare o plano e revise seu diff completo:

```sh
node tools/cli.mjs module:integrate --plan integration.json > integration-plan.json
node tools/cli.mjs module:integrate --apply integration-plan.json
```

A rota será `/modules/<nome>`. O registro reside em `imports/integration/registry.json`; os consumidores estáticos são `imports/modules/index.ts`, `imports/server/registerApi.ts` e `tests/server.ts`. Só o servidor importa o registro e os testes de servidor. O toolkit valida a entrada exata, os manifests, os arquivos gerados, as declarações estáticas de rotas, os ports e a presença de testes. Portas/regras e critérios de aceitação precisam de revisão e execução: existência de um arquivo não demonstra autorização ou comportamento correto.

O plano contém hashes dos módulos completos, customizações e roteamento inspecionado; planos desatualizados ou adulterados são rejeitados. O segundo apply do mesmo plano é rejeitado como desatualizado; gerar outro plano com a mesma especificação produz `unchanged`. Customizações em arquivos gerados falham; altere wrappers e metadados. Nomes duplicados no registry, colisões de rota, links simbólicos e templates alterados são rejeitados. Rotas computadas exigem revisão explícita.

A aplicação prepara uma árvore inteira antes da substituição do diretório `imports/integration`. Uma falha comum de rename restaura a árvore anterior. Execute em checkout isolado, com outros escritores e a aplicação parados: o lock coordena somente ferramentas cooperativas e há um intervalo entre os renames. Não há promessa de transação de filesystem ou recuperação automática de queda de energia. Em interrupção, preserve `imports/.integration.lock`, o stage/backup indicados no journal e compare seus hashes antes de qualquer recuperação manual; não apague o lock indiscriminadamente.

O resultado continua `qualified:false`. Execute `doctor`, `typecheck`, `test:toolkit`, `verify` e uma jornada real pelo navegador com o resolvedor de identidade do produto. O comando `templates:runtime` exercita a integração de um módulo gerado em Meteor/Mongo/DDP descartáveis, incluindo o namespace público e testes conectados automaticamente. Não demonstra sozinho os requisitos de um módulo de negócio novo.
