# Anexos privados e uploads

O adaptador `imports/api/attachmentsCollection.ts` usa `ostrio:files` com storage privado. Conta e perfil canônico precisam estar ativos. Nunca exponha `UPLOADS_DIR` como diretório estático público.

## Configuração e armazenamento

- `UPLOADS_DIR`: diretório privado persistente; padrão `<cwd>/uploads/meteorUploads`.
- `MAX_UPLOAD_BYTES`: limite por arquivo, padrão 15 MiB.
- `MEDIA_SIGNING_KEY`: segredo aleatório de pelo menos 48 caracteres, obrigatório em produção e igual nas réplicas. Não aparece nas URLs.

Faça backup consistente de Mongo e arquivos. Não existe opção suportada para desativar autorização. `DISABLE_MEDIA_TOKEN=true` impede a inicialização e os antigos links `?token=` não autorizam downloads.

## Upload e quarentena

O transporte `ostrio:files` recebe metadados `{ userId: Meteor.userId(), docId: documentoId }`. O servidor compara a identidade da conexão, exige conta/perfil ativo e valida extensão, MIME e tamanho. O campo `meta.contentValidated` é reservado ao servidor; valores do cliente são descartados.

Após receber o conteúdo, o servidor verifica assinaturas de formatos binários, texto e imagens. Imagens são inspecionadas por Sharp com limite de pixels, e somente PNG, JPEG, GIF e WebP passam pelo decodificador. BMP presente na allowlist histórica não é liberado pelo validador de conteúdo. SVG e HTML não são admitidos. Office/OpenDocument recebem inspeção de assinatura do contêiner, não validação semântica completa nem antivírus. Arquivos reprovados pelo transporte direto são removidos; arquivos legados ficam indisponíveis até uma revalidação explícita.

Implemente a política do documento/tenant no caso de uso antes de associar um upload a um registro de negócio. O adaptador genérico garante ownership individual, não memberships específicas de cada módulo.

## Listagem e remoção

`files-attachments` recebe `{ 'meta.docId': documentoId }`, acrescenta o proprietário no servidor e publica somente nome, tamanho, tipo, extensão e metadados de referência permitidos. Caminhos físicos e versões internas não são publicados. A assinatura é encerrada se o perfil for desativado ou removido.

`Meteor.callAsync('RemoveFile', fileId)` exige conta/perfil ativo e ownership. Retorna `false` quando o arquivo não existe; acesso negado produz `not-authorized`.

## Downloads e validade das URLs

Uma sessão autenticada do proprietário ativo pode acessar seu arquivo validado. Para um cliente HTTP sem sessão, uma operação de negócio já autorizada pode retornar `attachmentsCollection.getFileLink(doc)` no servidor. O link contém uma capacidade HMAC vinculada ao ID, versão original, operação de download e expiração de cinco minutos. Nunca devolva links de registros arbitrários sem autorizar sua leitura.

A capacidade é bearer: pode ser compartilhada para aquele mesmo arquivo durante sua validade. Não autoriza outro arquivo ou versão. Desativar o proprietário revoga também links ainda válidos; uma sessão identificada de usuário inativo é recusada. URLs antigas ou expiradas devem ser renovadas pela API autorizada, nunca guardadas como endereço permanente do documento.

Respostas usam `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, CSP restritiva e `Content-Disposition: attachment`. Isso também vale para documentos potencialmente ativos. Um aplicativo que mantém cópia offline assume a responsabilidade de isolá-la por conta, removê-la no logout e obedecer à política de retenção; headers não apagam cópias já baixadas.

Arquivos legados sem validação continuam bloqueados mesmo com uma URL recém-assinada. Veja [migração segura de mídia](media-migration.md) para dry-run, aprovação de lotes explícitos e quarentena sem ignorar a validação.

## CSV gerado pelo backend

`serverSaveCSVFile(file, fileName, ownerAccountId)` é exclusivamente interno. Exige uma conta proprietária ativa, cria nome confinado ao storage e retorna link com a mesma validade curta. Não exponha parâmetros arbitrários diretamente por DDP/HTTP.

## Example/Flutter: demonstração experimental

O núcleo é online. A integração de sincronização do Example não representa um perfil offline-first de produção qualificado. Os caminhos de sync ficam bloqueados por padrão e exigem `EXPERIMENTAL_EXAMPLE_SYNC=true`; habilitar a variável não equivale a aprovar segurança, testes em dispositivos ou isolamento multi-tenant.

O código experimental inclui pull com cursores compostos, tombstones, leitura autorizada e upsert com revisão/CAS e `mutationId`. Contratos antigos que enviam apenas `baseVersion` ou tratam links como permanentes precisam migrar. As rotas legadas `/img` e `/audio` não fornecem mais acesso pelo token global. Use anexos privados validados; não dependa de mídia base64 legada.

O upload em partes informa `assetId`, `exampleId`, `name`, `mimeType`, `kind`, `size`, `checksum`, `offset`, `data` base64 e `isLast`. Cada bloco tem até 192 KiB. Metadados não podem mudar durante o upload; reenvio deve corresponder aos bytes já escritos. Há exclusão mútua entre processos, validação de tamanho/SHA-256/conteúdo antes da promoção, limite de três uploads incompletos por usuário e 100 por staging store, e expiração após uma hora de inatividade. A limpeza ocorre na próxima atividade de upload.

O staging local exige roteamento aderente à mesma instância ou store privado compartilhado. Não é um protocolo distribuído de object storage. Se um processo cair segurando o lock, a recuperação é fail-closed e exige a manutenção documentada em [media-migration.md](media-migration.md), não a remoção automática do lock enquanto houver escritores.

## Limites de qualificação

Ainda são necessários scanner de malware quando aplicável, quota persistente por usuário/tenant, políticas específicas de documentos, testes de dispositivos offline e qualificação do armazenamento distribuído. Os testes de mídia incluem HTTP real para expiração, acesso cruzado, cache privado e revogação; só resultados efetivamente executados no ambiente de release constituem evidência de qualificação.
