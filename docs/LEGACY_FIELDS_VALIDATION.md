# Entrega: contratos de campos legados

Data: 2026-10-21. Base do checkout: `589cd88f806a0f02f2cffd9092690939679f5526`; alterações desta entrega ainda no diretório de trabalho. Este registro cobre o boilerplate; não altera o Synergia Code ou o harness externo.

## Resultado implementado

- `allowedValues` aplicado no servidor sobre a entrada original, antes da normalização legada. Categorias, prioridades, grupos, lembrete, antecedência, status e papéis existentes têm domínios explícitos; os controles de autorização continuam ativos.
- Example usa contratos explícitos de exposição por lista/detalhe/formulário e schema reduzido compartilhado. `legacy:check` inspeciona os consumidores reais e denuncia perda de propagação, nova chave sem decisão de exposição e `options` sem domínio. Mídia omitida da projeção deixa de reaparecer como URL ou indicador calculado.
- Testes próprios do Example para valores válidos e inválidos, rejeição sem alteração do Mongo, identidade forjada, assinaturas DDP novas e recarga no navegador. Testes compartilhados de Aniversário/Perfil ficam em `tests/`, preservando os limites entre módulos.
- Manifests legados vinculam schema, validador, publicações, controllers e fontes/comandos de teste. O contexto entrega os hashes dessas referências.
- Corrigidos dois defeitos revelados pelos testes: publicação transformada sinalizava `ready` antes de terminar os documentos iniciais; notificação passava argumentos incompatíveis ao callback de fechamento. O Select mantém o valor persistido e usa o rótulo apenas para apresentação.

A reversão solicitada foi respeitada: nenhum campo `tipo`, opção de sabor, filtro ou alteração de layout dos experimentos anteriores foi reaplicado. As melhorias do Example usam seus campos originais. A alteração preexistente de `.meteor/versions` foi preservada; os testes Meteor trabalham em cópias descartáveis.

## Evidência executada

| Verificação | Resultado |
| --- | --- |
| `npm run doctor` | Passou com Node 24.21.0 e Meteor 3.5.2 |
| `npm run typecheck` | Passou, sem erros |
| `npm run test:toolkit` | 143/143, zero falhas e skips; Mongo local temporário também executou os casos do driver real |
| `npm run verify` | Passou; preserva todas as etapas anteriores, incluindo core, mutações, templates, limites de arquitetura, documentação e segurança |
| `npm run test:example:contracts` | 3/3, zero skips, executados também dentro de `verify` |
| `npm run test:security` | 48/48 em Mongo/DDP reais, incluindo os 3 casos específicos do Example |
| `npm run test:example:browser` | 2/2 no Cypress 15.21.1 / Electron 138, zero falhas, pendências e skips |

Fontes: [contratos do Example](../imports/modules/example/tests/fields.node.test.ts), [casos compartilhados](../tests/legacy-fields.node.test.ts), [Mongo/DDP do Example](../imports/modules/example/tests/server/fields.test.ts), [Cypress](../.cypress/example/fields.cy.js), [regressões do inspetor](../tools/test/legacy-fields.test.mjs).

Recibos funcionais locais com hashes das fontes e logs completos:

- Servidor completo: `.ai-artifacts/legacy-runs/2026-10-21T16-39-20-740Z-6a0fa8b5/result.json`.
- Navegador: `.ai-artifacts/legacy-runs/2026-10-21T16-38-55-424Z-32274715/result.json`.
- Sequência dos quatro gates: `.ai-artifacts/legacy-final-checks.json`. Os logs dessa sequência estão nos caminhos registrados no recibo, sob `/tmp/boilerplate-final-*.log`.

As tentativas anteriores que falharam não são aceitação. Os defeitos e expectativas incorretas de teste foram corrigidos e os cenários reexecutados. Uma execução anterior de `verify`, mesmo com 48 testes de servidor passando, foi invalidada porque as fontes mudaram durante a execução; a execução final acima foi feita com fontes estáveis. Os recibos funcionais de cada tentativa posterior à introdução desse registro permanecem separados por execução.

## Migração e limites residuais

Não houve criação de campo obrigatório nem preenchimento automático de registros. Dados históricos fora dos domínios permanecem armazenados e passam a impedir gravações validadas até correção explícita. Um projeto derivado deve revisar esses dados antes de incorporar a restrição. A projeção de lista deixa de incluir mídia que não foi solicitada; consumidores que dependiam dessa exposição acidental precisam declarar os campos conscientemente.

A inspeção automática de propagação está configurada no Example. Aniversário e Perfil têm referências enriquecidas e validação de domínio, mas a exposição específica continua `needs-review`; o comando retorna erro para evitar aceitação por código de saída zero. A inspeção AST aceita um vocabulário limitado e não prova semântica arbitrária.

Os recibos locais não são um verificador independente. O sincronismo offline experimental, transações em replica set, campanha Qwen, build de produção e o conjunto completo de `verify:release` não foram qualificados nesta entrega. O gate existente de navegador de release foi mantido e recebeu a suíte adicional do Example.

Consulte [o guia de campos legados](LEGACY_FIELDS.md) para os comandos, regras de exposição e política de migração.
