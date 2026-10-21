# Jornada de solicitações com itens, aprovação e histórico

A rota autenticada `/requests` conecta `imports/modules/requests` ao contrato público de `imports/modules/requestitems`. É um exemplo utilizável de integração entre módulos do núcleo novo; não usa ProductBase nem o protocolo offline legado.

O solicitante cria um rascunho, adiciona itens com quantidade e preço em centavos, envia e acompanha a decisão. Um aprovador separado consulta a fila e aprova ou rejeita. A interface mostra total, estado, versão e histórico, preserva a intenção de criação para repetição incerta, informa conflitos e descarta estado privado quando a conta muda. Métodos e permissões são verificados no servidor independentemente dos botões.

## Provisionamento de negócio

O adaptador de produção consulta contas Meteor e perfis ativos ligados por `accountId` imutável em cada chamada. A coleção privada `ai_request_assignments` contém `{ _id: <accountId do solicitante>, reviewerId: <accountId do aprovador>, active: true }`. Só um administrador de servidor deve provisioná-la através do processo confiável de administração da aplicação. Não existe publicação, mutação pública de atribuição ou aprovador padrão. IDs, perfis editáveis e papéis enviados pelo cliente não concedem acesso. Este trabalho não provisiona usuários nem altera dados de produção.

Solicitante e aprovador precisam ser contas diferentes e ativas. Desativar a atribuição ou uma conta revoga a revisão na próxima invocação. O solicitante mantém leitura de seu próprio histórico; enviar um rascunho exige que sua atribuição atual ainda corresponda ao aprovador armazenado. Trocar o aprovador não transfere registros existentes automaticamente: defina uma migração revisada ou conclua/reconcilie essas solicitações antes da troca.

## Contratos e consistência

| Método             | DTO obrigatório                                      |
| ------------------ | ---------------------------------------------------- |
| `requests.create`  | `{mutationId,title}`                                 |
| `requests.list`    | `{limit}` de 1 a 100                                 |
| `requests.get`     | `{id}`                                               |
| `requests.addItem` | `{id,version,item:{description,quantity,unitPrice}}` |
| `requests.submit`  | `{id,version}`                                       |
| `requests.decide`  | `{id,version,decision:"approved" ou "rejected"}`     |

Todos exigem exatamente um DTO e rejeitam campos extras. O servidor escolhe o aprovador pela atribuição confiável. Resultados projetam somente ID, título, itens, total, estado, versão, histórico e capacidades de UI. IDs de proprietário e aprovador ficam privados. As consultas e os writes são limitados ao proprietário ou aprovador designado, e o serviço repete a autorização após ler o repositório. Sem publicação ou coleção cliente.

O total é calculado no servidor com inteiros seguros. Há no máximo 30 itens, quantidade 1–1000 e preço unitário 0–100.000.000 centavos; a lista é limitada a 100 registros e o histórico a 200 eventos. Cada inclusão de item, envio ou decisão persiste itens, estado, incremento de versão e evento de histórico no mesmo update Mongo condicionado pela versão anterior. Concorrentes têm no máximo um vencedor; o perdedor recebe `conflict` e precisa recarregar. Não há update parcial de histórico, nem transação multicollection implícita. Conteúdo enviado fica congelado, inclusive após aprovação/rejeição.

A criação usa `_id` derivado de proprietário e mutation ID, com rejeição de replay de título diferente. O histórico pertence ao agregado e registra versão, papel do ator e horário de servidor; não é um ledger criptográfico ou prova contra administradores do banco. A autorização de atribuição é reconsultada por invocação, mas não faz parte da transação do documento: uma revogação concorrente após a consulta não desfaz uma operação já em andamento. Taxas são limitadas por processo.

## Qualificação reproduzível

```sh
npm ci
npm run doctor
npm run typecheck
npm run test:toolkit
npm run verify
npm run templates:runtime
npm run test:recipe-ui
npm run test:request-journey
```

`test:request-journey` cria uma cópia temporária da aplicação, Mongo exclusivo em loopback, quatro contas sintéticas nos domínios reservados `example.test` e `journey.example.test`, perfis, atribuição e senha aleatória. Apenas essa cópia importa o provisionamento de fixtures; nenhuma flag ou endpoint de teste é adicionado ao app entregue. O runner usa o Mongo fornecido pelo Meteor fixado e o Cypress do lockfile, verifica o bundle emitido, exige todos os cenários previstos sem skips e encerra os processos ao terminar. Não aceita URL de app ou banco externo. Exige Meteor, Mongo e binário Cypress disponíveis; ausência de infraestrutura falha o gate.

São dois cenários da jornada, incluindo persistência após reload, separação de decisão, usuário sem acesso e conflito visível na UI. O runner executa adicionalmente os dez cenários existentes de autenticação/perfil/CRUD com o administrador sintético. A evidência fica em `.ai-artifacts/request-journey.json`, com hashes de fontes e contagens. Os testes `tests/requests.server.ts` verificam também concorrência real de edição e decisão, persistência atômica e revogação via DDP/Mongo. Os testes de Node complementam essas fronteiras; não substituem a execução real.
