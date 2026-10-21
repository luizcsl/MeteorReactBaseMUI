# Campos e valores permitidos em módulos legados

O Example continua sendo uma demonstração legada. Novos módulos usam `imports/core` e Tasks. As mudanças abaixo tratam os campos existentes; nenhum campo `tipo`, opção de sabor ou filtro dos experimentos anteriores foi incluído.

## Contrato no servidor

`IDefField.allowedValues` declara um domínio estático de strings, números ou booleanos. Para arrays, cada elemento precisa pertencer ao domínio. `options` continua sendo metadado de apresentação e pode ter rótulos diferentes dos valores persistidos.

`ServerApiBase._checkDataBySchema` chama [assertAllowedValues](../imports/legacy/allowedValues.ts) sobre a entrada original, antes de coerção ou remoção de valores. Campos obrigatórios visíveis rejeitam ausência, `undefined`, `null` e string vazia. Campos opcionais permitem limpar o valor. Campos condicionais ausentes e invisíveis continuam permitidos, mas um valor informado precisa ser válido. Arrays esparsos, aninhados indevidamente ou com propriedades extras são rejeitados. Incluir um campo restrito em `fieldsNamesIgnoreCheck` falha com `ignored-constraint`; essa lista não desliga o contrato de domínio.

O Example restringe categoria, prioridade, grupos e prioridade de rádio. Aniversário restringe lembrete e antecedência; perfil restringe status e papéis já existentes. Isso não concede permissões: as políticas de acesso e as proteções contra alteração de papéis continuam obrigatórias.

## Propagação e exposição

[exampleExposure.ts](../imports/modules/example/api/exampleExposure.ts) declara separadamente campos incluídos e omitidos em lista, detalhe e formulário. Publicações e schema reduzido consomem essas listas explícitas. Nunca publique todas as chaves do schema para facilitar uma evolução. A publicação compartilhada também respeita a omissão de campos de mídia, sem acrescentar URLs ou indicadores de mídia excluída.

Execute:

```sh
npm run legacy:check -- --module example
```

A inspeção AST confere o schema, domínios, projeções efetivas das publicações, assinaturas usadas pelos controllers, schema reduzido e nomes presentes no formulário. Um campo novo exige uma decisão explícita de inclusão ou omissão em cada consumidor. Expressões dinâmicas fora do vocabulário inspecionável exigem revisão; o código não é executado pelo diagnóstico. Módulos com exposição não configurada retornam `needs-review` e código de saída não zero. O resultado continua com `qualified: false`: checagem de fonte não demonstra comportamento funcional.

Os manifests de Example, Aniversário e Perfil agora referenciam validadores, publicações, controllers e fontes/comandos de teste. `agent:context` inclui essas referências com SHA-256. Aniversário e Perfil têm `exposure: null` e retornam `needs-review`; suas projeções específicas não receberam aceitação automática. O teste compartilhado de Aniversário cobre seu domínio, sem alegar aceitação funcional daquele módulo.

## Testes vinculados às fontes

| Comando | Fonte | Evidência esperada |
| --- | --- | --- |
| `npm run test:example:contracts` | [fields.node.test.ts](../imports/modules/example/tests/fields.node.test.ts) | Valores válidos, inválidos, ausência, arrays, campos condicionais e validação compartilhada |
| `npm run test:example:server` | [fields.test.ts](../imports/modules/example/tests/server/fields.test.ts) | Mongo e DDP reais: criação/alteração, novas assinaturas de lista/detalhe, rejeição sem gravação e negação de identidade |
| `npm run test:example:browser` | [fields.cy.js](../.cypress/example/fields.cy.js) | Formulário real, edição, recarga de detalhe/lista e rejeição de chamada DDP inválida |

Os executores exigem a fonte exata e rejeitam seleção arbitrária. A suíte de contrato não usa Meteor e também executa [os casos compartilhados de Aniversário e Perfil](../tests/legacy-fields.node.test.ts). As suítes funcionais copiam a aplicação, iniciam Mongo descartável em loopback e usam portas livres. A suíte de navegador cria credenciais sintéticas temporárias. Não recebem URL de banco nem credenciais do ambiente em uso. Processos e diretórios temporários são removidos ao terminar.

`test:security` usa o mesmo isolamento, mantendo o entrypoint completo `tests/server.ts`, agora também com os testes do Example. `verify` preserva todas as etapas anteriores e acrescenta a inspeção legada e os contratos específicos. `verify:release` preserva os gates anteriores e acrescenta o navegador do Example.

Resultados funcionais registram hashes das fontes, fonte selecionada, comando, contagens e artefatos em `.ai-artifacts/legacy-runs/<execução>/`. Cada execução mantém seu resultado e logs; `.ai-artifacts/example-<modo>.json` aponta para o resultado mais recente. Uma alteração nas fontes durante a execução invalida a evidência. Esses recibos locais não substituem o verificador protegido do harness.

## Migração e limites

Não há campo obrigatório novo nem alteração automática de dados. Registros históricos com valores fora dos domínios continuam no banco, mas uma gravação validada desses documentos passa a ser rejeitada. Antes de incorporar em um projeto derivado, revise os valores históricos e planeje uma correção explícita; não converta valores desconhecidos silenciosamente. Para futuros campos obrigatórios, registre a política de preenchimento e valide registros antigos antes da aceitação.

O sincronismo offline experimental do Example permanece fora da qualificação. As suítes focadas não qualificam transações em replica set, produção, migração de dados ou geração com Qwen. Não foram feitas alterações no Synergia Code ou no harness externo.

Evidência desta entrega: [relatório de validação](LEGACY_FIELDS_VALIDATION.md).
