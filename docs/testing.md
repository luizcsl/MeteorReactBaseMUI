# Testes e qualidade

Os gates principais são TypeScript, testes Meteor, build de produção e auditoria de dependências. O workflow atual está
em [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## TypeScript

```bash
npm run typecheck
```

O comando executa `tsc --noEmit` e não aceita baseline de erros. Declarações para pacotes legados ficam em
`imports/typings`; não esconda erros da aplicação em declarações globais amplas.

## Testes Meteor

Execução única:

```bash
npm test -- --port 3102
```

Full-app:

```bash
meteor test --full-app --once --driver-package meteortesting:mocha --port 3104
```

O módulo de testes é [`tests/main.ts`](../tests/main.ts). Mantenha pelo menos um teste descoberto e trate zero testes
como falha de configuração, não como sucesso.

Priorize testes de servidor para métodos, publicações, rate limits, anexos, bootstrap e transações. Para autorização,
cubra também cenários negativos.

## Cypress

O Cypress 15 usa [`cypress.config.ts`](../cypress.config.ts) e o fluxo canônico em `.cypress/ai-ready/tasks.cy.js`. As features antigas em `.cypress/integration` são referência de migração, não testes executados:

```bash
CYPRESS_BASE_URL=http://localhost:3000 npm run cypress:headless
npm run cypress:gui
```

Inicie a aplicação antes do E2E. O binário do Cypress requer bibliotecas gráficas do sistema; em CI, prefira uma imagem
oficial compatível se o runner base não as possuir.

Resultados, screenshots e vídeos são artefatos de execução e não devem ser versionados.

## Build e auditoria

```bash
meteor build /tmp/meteor-react-base-build --directory
npm audit --omit=dev --audit-level=high
```

Uma vulnerabilidade moderada sem correção automática ainda exige avaliação e prazo; o gate de `high` não equivale a
ausência de risco.

## Antes de enviar uma mudança

- [ ] `npm ci` funciona em ambiente limpo;
- [ ] typecheck sem erros;
- [ ] testes executam quantidade maior que zero;
- [ ] mudança de backend possui teste negativo;
- [ ] build de produção conclui;
- [ ] não há segredo, resultado ou artefato gerado no diff;
- [ ] documentação e `.env.example` acompanham novos contratos.

## Perfil de desenvolvimento com IA

`npm run verify` executa tipos, contratos puros, toolkit, limites arquiteturais, geração isolada, documentação e testes reais de servidor. `npm run templates:runtime` cria um módulo temporário, registra seus métodos e exercita Mongo/DDP sem alterar o registro da aplicação original. O banco deve ser descartável: o runner aceita `TEST_MONGO_URL` apenas em loopback e com nome de banco de teste. Nunca aponte testes para produção.

Os testes de servidor entram por `tests/server.ts`; o módulo client permanece separado. `TEST_SERVER_ONLY=1` impede esperar um navegador que não foi iniciado. E2E é uma qualificação adicional, não substituída por testes unitários. Consulte [evidências e limites](AI_READY_VALIDATION.md).
