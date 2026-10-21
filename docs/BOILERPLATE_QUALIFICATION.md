# Reprodução e qualificação do boilerplate

Use Node de [.nvmrc](../.nvmrc), npm indicado por `packageManager` e Meteor de [.meteor/release](../.meteor/release). Instale com `npm ci`, preservando o lockfile. O `doctor` verifica a versão efetiva do Node, a release efetiva do Meteor, coerência das dependências declaradas com o lockfile e a versão instalada de cada dependência direta. Não corrige dependências automaticamente, não imprime segredos e não se conecta a bancos.

```sh
nvm use
npm ci
npm run doctor
npm run typecheck
npm run test:toolkit
npm run verify
```

`npm run qualify` reúne esses gates e migrações Mongo, transações, módulo gerado integrado e navegadores em uma sequência reproduzível. Mantém logs e um recibo `.ai-artifacts/qualification.json` com commit base, hashes de fontes, Node, comandos, saídas e resultado. Mudança de fontes durante a execução invalida o recibo. O relatório humano desta entrega, as evidências geradas e caches ficam explicitamente fora do snapshot para evitar referências circulares. O comando nunca declara a release qualificada: `qualified:false` permanece até os gates de release e hospedados serem comprovados no commit de entrega. Uma falha interrompe a sequência e fica registrada; indisponibilidade de Meteor/Mongo/Cypress não vira sucesso ou skip.

O gate geral de toolkit contém um caso de Mongo explicitamente condicionado à infraestrutura. Ele não conta como passe quando não executado; `test:migrations` é o gate obrigatório independente, com Mongo real e zero skips. Fixtures de processo/harness não demonstram isolamento operacional. Os gates `verify:release`, `test:browser`, workflows de browser/CI e qualificação externa do harness permanecem existentes e obrigatórios conforme seu escopo.

O runner da [jornada de solicitações](REQUEST_JOURNEY.md) cria serviços, perfis e dados descartáveis e executa os cenários de produto e os cenários existentes do navegador. O `test:browser` existente continua disponível para uma aplicação isolada já iniciada com credenciais sintéticas. Nenhum resultado local substitui o status dos workflows no mesmo commit.

Consulte o [relatório desta entrega](BOILERPLATE_IMPROVEMENTS_REPORT.md) para resultados efetivamente observados e riscos residuais. A base qualificada deve ser identificada pelo commit integrado e seu recibo, não por um rótulo genérico de branch ou um teste antigo.
