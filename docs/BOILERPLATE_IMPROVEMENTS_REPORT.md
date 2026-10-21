# Relatório das melhorias do boilerplate — 21/10/2026

Escopo: as seis prioridades do anexo aplicáveis a este repositório. Synergia Code, adaptador externo e harness não foram alterados. Base Git: `af3ab70162373ec8a837c4add4672a10d440f564`. As alterações permanecem no working tree; não houve commit, merge, push, deploy ou atualização de dados de produção.

## Entregas

- Reprodução: dependências restauradas por `npm ci`, Node fixado em `.nvmrc`, npm identificado por `packageManager`, CI/browser seguindo o mesmo Node. `doctor` detecta versões instaladas divergentes do lockfile e release efetiva do Meteor incorreta. `qualify` registra comandos, commit base, hashes de fontes e saídas e recusa evidência desatualizada.
- Integração: `module:integrate --plan/--apply` conecta servidor, rota autenticada, menu e testes em uma árvore gerada, com ports explícitos, diff completo, hashes, lock, rejeição de colisões/drift e rollback de falha de rename. Owner, receitas e master/detail com página de seleção de pai são cobertos. `qualified:false` é preservado.
- Domínio: datas civis válidas, dinheiro em inteiros de unidades mínimas, referências com autorização do alvo e regras declarativas entre campos, com validação compartilhada, serialização e UI. Preset adicional `domain.json` e testes de contratos, servidor real e navegador.
- Jornada: módulos Requests e Request Items, criação idempotente, itens, envio, decisão por aprovador separado, histórico no mesmo CAS, revogação e feedback de conflito na interface.
- Qualificação: runner descartável de Mongo/Meteor/Cypress, testes reais de DDP/Mongo, fluxo entre contas e persistência após reload, além da suíte existente de navegador. O módulo gerado de teste passa pela nova operação de integração antes da qualificação de runtime.
- Coexistência: manifests explícitos identificam módulos legacy/core/domain-only; contexto AST inclui orientação de arquitetura e hashes dos manifests. O padrão canônico segue Tasks; o Example permanece legado.

## Evidência observável

Qualificação final local aprovada em 21/10/2026 às 11:30, horário de São Paulo, com Node 24.21.0 e npm 11.11.0. O recibo em `.ai-artifacts/qualification.json` registra os nove comandos abaixo com exit code 0, 585 entradas de fontes/configurações e nenhuma divergência na conferência posterior dos hashes. Hash agregado: `e204c4daa0fba440a66b367a21bb18907c5b32f59eedc6354b4cf0283367c555`.

| Gate/resultado                             | Evidência observada                                                                                                                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`                                   | Node, Meteor 3.5.2 e dependências diretas coerentes com o lockfile                                                                                                                  |
| `typecheck`                                | TypeScript estrito aprovado                                                                                                                                                         |
| `test:toolkit`                             | 124 passaram; zero falhas; um caso geral de Mongo não executado nessa suíte, coberto pelo gate real abaixo                                                                          |
| `verify`                                   | Passou integralmente: 43 casos de núcleo/contratos, 25/25 mutantes detectados por testes, toolkit, fronteiras, templates, documentação e 45 testes reais de servidor/DDP/Mongo/HTTP |
| `test:migrations`                          | 24 passaram com Mongo real e zero skips                                                                                                                                             |
| `test:transactions`                        | 49 passaram, incluindo os quatro casos de transação em replica set real                                                                                                             |
| `templates:runtime`                        | 6 passaram com o módulo gerado conectado pela nova operação, namespace público e DDP/Mongo reais                                                                                    |
| `test:recipe-ui`                           | 21 cenários Cypress passaram; zero falhas, pendentes ou skips                                                                                                                       |
| `test:request-journey`                     | 2 cenários completos da jornada e os 10 cenários existentes de autenticação/perfil/tarefas passaram; zero falhas, pendentes ou skips                                                |
| Build de produção, executado separadamente | `meteor build <diretório temporário> --directory`: exit code 0                                                                                                                      |

Os 33 cenários Cypress executaram no Electron 138 com Cypress 15.21.1, versão instalada pelo lockfile. A instalação inicial foi restaurada com `npm ci --ignore-scripts`; o binário exato do Cypress foi instalado separadamente em cache temporário. O shell inicial estava em Node 20 e o runtime Meteor tinha acesso restrito ao próprio cache; os resultados finais acima usam Node 24 e subprocessos/runtime efetivamente disponíveis.

A rodada de integração do navegador inicialmente rejeitou o domínio do e-mail da fixture administrativa por não corresponder ao padrão sintético obrigatório. Foi corrigida somente a fixture para `journey-admin@example.test`; a restrição e os testes existentes foram preservados. O recibo final é da execução posterior aprovada. O build removeu temporariamente as três seleções de pacotes do test driver; o próprio comando de testes Meteor restaurou a seleção original, sem diff residual em `.meteor/versions`.

A evidência local mantém `qualified:false` intencionalmente: `verify:release` não foi executado como comando completo nesta sessão, e os workflows hospedados, auditorias/SBOM e qualificação operacional do harness não foram executados. O gate `test:browser` original permanece no release; seus dez cenários também foram executados pelo runner adicional contra a aplicação descartável. Não se atribui qualificação remota ou de release ao working tree. Os logs dos gates estão em `.ai-artifacts/qualification-*.log`; o recibo da jornada está em `.ai-artifacts/request-journey.json`.

## Migração e limites

Não há backfill automático. Novas coleções privadas: `ai_requests` e `ai_request_assignments`; a atribuição de aprovador precisa de provisionamento administrativo confiável. O preset de aprovação agora usa `approvalrequests` para evitar colisão com o módulo Requests. Projetos derivados que já possuam um módulo `requests` precisam revisar nomes, rotas e contratos antes de integrar.

A extensão do renderer e dos metadados do template altera hashes de gerações futuras. Árvores geradas antigas podem exigir regeneração comparada em checkout isolado e migração revisada de customizações; nunca atualizar hashes para ocultar drift. Campos obrigatórios, escala/moeda, tipos e referências requerem migração de dados revisada quando houver registros existentes.

Referências genéricas verificam acesso antes da gravação, sem transação de ciclo de vida entre coleções. A jornada usa itens embutidos, limitados a 30; lista de até 100 registros e histórico de até 200 eventos. O histórico é atômico com a alteração, mas não é ledger criptográfico. Revogação é verificada por invocação, sem desfazer operação já iniciada. A troca do aprovador não transfere registros anteriores. Rate limiting permanece por processo.

O apply de integração usa renames e um lock cooperativo: requer checkout isolado sem escritores e não promete atomicidade contra queda de energia. Preserve journal, stage e backup em interrupções. O recibo local não promove qualificação de release; os gates existentes de release, workflows, supply chain e harness externo continuam obrigatórios. Esta entrega não mede produtividade ou custo com modelos pequenos.

A revisão automática recusou uma tentativa intermediária de remover a chamada direta de `test:browser` do release, interpretando-a como enfraquecimento de gate. A alteração foi descartada: o gate original foi preservado e o runner novo adiciona uma validação separada.
