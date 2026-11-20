# Integração Micheng ↔ Soulglobal — contrato (versão 1)

Este documento descreve como os dois sistemas trocam **eventos** (uma ação num sistema dispara uma ação no outro) e **documentos**. O lado da Micheng já está pronto (`api/_lib/integration.js`, `api/integration*.js`). O lado da Soulglobal (`sg-imports`) deve implementar o que está descrito aqui.

Princípios:

- Cada sistema continua com o próprio banco e o próprio armazenamento de arquivos. Nenhum lê o banco do outro.
- Toda mensagem é **assinada** com uma chave compartilhada (HMAC-SHA256).
- A entrega é **"pelo menos uma vez"**: o mesmo evento pode chegar mais de uma vez, e quem recebe ignora um `id` que já tratou.
- Quem envia guarda o evento junto com a mudança que o gerou (outbox) e tenta de novo até receber confirmação.
- Dados internos da Micheng (fornecedores, custos, margens, valores declarados, histórico interno) **nunca** saem da Micheng.

## 1. Configuração

### Na Micheng (Vercel → Settings → Environment Variables)

| Variável | Para quê |
| --- | --- |
| `SOULGLOBAL_EVENTS_URL` | Endereço da Soulglobal que recebe os eventos da Micheng, ex.: `https://<soulglobal>/api/webhooks/micheng`. |
| `INTEGRATION_SECRET` | Chave compartilhada (mínimo 32 caracteres, a mesma nos dois sistemas). Para trocar sem perder eventos, use temporariamente `nova,antiga`: a Micheng assina com a primeira e aceita as duas. |
| `PUBLIC_BASE_URL` | Endereço público da Micheng (ex.: `https://micheng.vercel.app`), usado nos links dos documentos. Sem ela, usa `VERCEL_PROJECT_PRODUCTION_URL`. |
| `SOULGLOBAL_FILE_HOSTS` | Opcional. Hosts de onde a Micheng aceita baixar documentos da Soulglobal, separados por vírgula (aceita `*.dominio.com`). Padrão: o host de `SOULGLOBAL_EVENTS_URL` e `*.supabase.co`. |
| `CRON_SECRET` | Recomendado. A Vercel envia essa chave ao rodar o cron de reenvio (`/api/integration-cron`, a cada minuto), e só ela consegue acioná-lo. |

Sem `SOULGLOBAL_EVENTS_URL` e `INTEGRATION_SECRET`, a integração fica **desligada**: nada é enfileirado e o endereço de entrada responde 503.

### Na Soulglobal

- `MICHENG_EVENTS_URL` = `https://<micheng>/api/integration-inbound`
- `MICHENG_INTEGRATION_SECRET` = a mesma chave de `INTEGRATION_SECRET`

## 2. Envio de um evento (igual nos dois sentidos)

`POST` para o endereço do outro sistema, com corpo JSON e os cabeçalhos:

| Cabeçalho | Valor |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Integration-Id` | o `id` do evento |
| `X-Integration-Timestamp` | hora do envio, em segundos Unix |
| `X-Integration-Signature` | `v1=` + hex de `HMAC-SHA256(segredo, timestamp + "." + corpo)` |

A assinatura é calculada sobre o **corpo exato** enviado (bytes), não sobre o JSON reformatado. O recebedor recusa um timestamp com mais de **5 minutos** de diferença.

Exemplo de verificação (Node/Next.js, lado Soulglobal):

```ts
import crypto from "node:crypto";

export function verify(raw: string, ts: string | null, sig: string | null, secret: string) {
  if (!ts || !sig || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = "v1=" + crypto.createHmac("sha256", secret).update(ts + "." + raw).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// No route handler: const raw = await req.text(); (antes de qualquer JSON.parse)
```

### Envelope

```json
{
  "id": "6f1c…",
  "type": "proforma.closed",
  "version": 1,
  "source": "micheng",
  "seq": 42,
  "subject": "proforma:9b2e…",
  "occurredAt": "2026-11-20T10:15:00.000Z",
  "data": { }
}
```

- `id`: único por evento (UUID). Chave de idempotência.
- `seq`: número crescente do emissor. Eventos com o mesmo `subject` são entregues **em ordem**: enquanto um espera nova tentativa, os seguintes do mesmo assunto também esperam.
- `occurredAt`: quando a ação aconteceu. Use para descartar uma atualização mais antiga que chegue depois de uma mais nova.

### Respostas esperadas

| Resposta | Significado |
| --- | --- |
| `2xx` | Tratado, já tratado antes (duplicado) ou tipo desconhecido (ignorado). O emissor marca como entregue. |
| `401` | Assinatura inválida ou expirada. |
| `422` | Evento inválido (ex.: pedido inexistente): não adianta reenviar. |
| `409`, `5xx`, sem resposta | Erro temporário: reenviar depois. |

A Micheng, ao **receber**, responde 422 para eventos que não adianta reenviar. Ao **enviar**, ela reenvia qualquer resposta que não seja 2xx; por isso a Soulglobal deve responder 2xx para um evento que decidiu descartar.

**Reenvio da Micheng:** depois de 1, 2, 5, 10, 30, 60, 120, 240 minutos e então a cada 6 horas, até 20 tentativas (cerca de 3 dias). Depois disso o evento fica como "Falhou" e pode ser reenviado pelo painel (Parâmetros → Integração com a Soulglobal). Tempo limite de cada envio: 10 segundos, então a Soulglobal deve responder rápido e, se o processamento for demorado, **registrar o evento e processar depois** (ex.: na tabela `webhook_events` + Inngest, como já é feito com ZapSign, ShipsGo e Asaas).

## 3. Eventos que a Micheng envia

Todos os eventos de pedido trazem em `data.order` o **estado completo** do pedido naquele momento (não só a diferença), então o recebedor pode simplesmente substituir o que tem pelo mais recente (`occurredAt`/`seq`).

| Tipo | Quando |
| --- | --- |
| `ping` | Teste de conexão pelo painel. Responder 200. |
| `proforma.closed` | A proforma foi fechada (virou pedido). |
| `proforma.reopened` | Um pedido fechado foi reaberto (deixa de ser firme até ser fechado de novo). |
| `proforma.amended` | Itens de um pedido fechado foram alterados. `data.changes` lista as mudanças; `data.byClient: true` quando vieram de pedido do cliente. |
| `proforma.invoice_saved` | A invoice comercial foi salva. `data.order.invoice` traz os dados; `data.first` indica a primeira vez. |
| `proforma.deleted` | Um pedido que já foi fechado foi excluído. `data.order` tem só `id`, `number` e `status: "deleted"`. |
| `document.shared` | Um documento foi compartilhado (ver seção 5). |

Rascunhos não geram eventos.

### `data.order`

```json
{
  "id": "9b2e…", "number": "BR-2026-016", "status": "closed",
  "date": "2026-11-20", "validUntil": null, "currency": "USD", "incoterm": "FOB", "language": "en", "terms": "",
  "closedAt": "…", "updatedAt": "…",
  "clientId": "c1…",
  "client": { "name": "…", "address": "…", "country": "Brasil", "phone": "…", "taxId": "…" },
  "items": [{
    "id": "…", "productId": "…", "sku": "MC-0012-BLK",
    "name": { "pt": "Mesa", "en": "Table", "es": "Mesa", "zh": "桌" },
    "description": { "pt": "…" }, "category": "general", "image": "https://…",
    "options": [{ "attributeId": "…", "optionId": "…", "attribute": { "pt": "Cor" }, "option": { "pt": "Preto" } }],
    "clientRef": "REF-CLIENTE", "qty": 10, "unitPrice": 5, "amount": 50
  }],
  "total": 50,
  "invoice": null,
  "soulglobal": { "id": "sg-123", "reference": "IMP-77" }
}
```

`invoice` (quando salva): `number, date, incoterm, transport, portLoading, portDischarge, originCountry, acquisitionCountry, provenanceCountry, paymentTerms, buyer, packagesQty, packagesKind, marks, grossWeight, netWeight, volumeM3, freight, insurance, otherCosts, otherCostsLabel, notes, units` (unidade por item), `savedAt`.

Valores em `currency` do pedido (CNY, USD, EUR ou BRL). A conversão para BRL (PTAX) fica com a Soulglobal.

## 4. Eventos que a Micheng recebe

Endereço: `POST https://<micheng>/api/integration-inbound`.

| Tipo | `data` | Efeito na Micheng |
| --- | --- | --- |
| `ping` | — | Responde `{ "result": "pong" }`. |
| `order.updated` | `{ "order": { "michengId" ou "number", "soulglobalId", "reference", "status", "step", "url" } }` | Liga o pedido da Micheng ao da Soulglobal e guarda status/etapa. Um evento mais antigo que o último recebido é ignorado (`"stale"`). Pedido inexistente → 422. |
| `document.shared` | `{ "document": { "id", "type", "name", "contentType", "sha256"?, "url", "note"? }, "order": { "michengId" ou "number" }? }` | Baixa o arquivo (https, host permitido, sem redirecionamento, até 20 MB), confere o `sha256` se enviado e guarda criptografado. Mesmo `document.id` de novo = nova versão (substitui). |
| `document.reviewed` | `{ "documentId": "<id da Micheng>", "status": "PENDING" \| "APPROVED" \| "REJECTED", "reason"? }` | Mostra no painel a revisão de um documento que a Micheng enviou. |

Qualquer outro tipo é aceito com 200 e marcado como "ignorado", para que versões novas da Soulglobal não travem a fila.

Sugestão de quando a Soulglobal envia `order.updated`: ao criar o pedido/embarque a partir de um `proforma.closed` e a cada mudança de etapa (`shipments.currentStep`) ou status.

## 5. Documentos

Os arquivos não vão dentro do evento. O evento leva um **link de download assinado e temporário**:

- **Micheng → Soulglobal:** `data.document.url` = `https://<micheng>/api/integration-file?id=…&exp=…&sig=…`, válido por 48 horas, gerado no momento de cada envio (um reenvio tardio leva um link novo). A resposta traz o cabeçalho `X-Content-SHA256`, e o evento traz `data.document.sha256` para conferência. A Soulglobal deve baixar o arquivo e guardar uma cópia no Supabase Storage (ex.: `shipment_documents`), sem depender do link depois.
- **Soulglobal → Micheng:** `data.document.url` pode ser uma *signed URL* do Supabase Storage.

`data.document` enviado pela Micheng:

```json
{
  "id": "…", "direction": "out", "type": "COMMERCIAL_INVOICE", "name": "Invoice BR-2026-016 - Cliente.pdf",
  "contentType": "application/pdf", "size": 183422, "sha256": "…",
  "proformaId": "…", "proformaNumber": "BR-2026-016",
  "key": "invoice:<proformaId>", "version": 2, "replaces": "<id da versão anterior>",
  "note": null, "at": "…", "by": "admin", "url": "https://…"
}
```

Tipos: `PROFORMA_INVOICE, COMMERCIAL_INVOICE, PACKING_LIST, BILL_OF_LADING, ORIGIN_CERTIFICATE, PURCHASE_ORDER, SWIFT, INSPECTION_REPORT, PHOTO, OTHER`. Correspondência sugerida com `document_type` da Soulglobal: `COMMERCIAL_INVOICE → COMMERCIAL_INVOICE`, `PACKING_LIST → PACKING_LIST`, `BILL_OF_LADING → BILL_OF_LADING`, `ORIGIN_CERTIFICATE → ORIGIN_CERTIFICATE`, `SWIFT → SWIFT`, os demais `→ OTHER`.

Arquivos aceitos: PDF, JPEG, PNG, WebP, Excel `.xlsx`, Word `.docx` e ZIP (conferidos pelo conteúdo, não só pela extensão). Envio pelo painel: até 3 MB.

A invoice comercial é enviada automaticamente quando é gerada no painel (com a integração ligada); cada nova geração substitui a versão anterior (`key` igual, `version` maior, `replaces`).

## 6. O que a Soulglobal precisa implementar (próxima etapa)

1. Rota `POST /api/webhooks/micheng`: lê o corpo bruto, verifica a assinatura, grava em `webhook_events` (`provider: 'MICHENG'`, `externalId = id`, único) e responde 200; um job Inngest processa.
2. Processamento: `proforma.*` cria/atualiza o pedido (cotação/embarque) da organização ligada à Micheng; `document.shared` baixa e grava em `shipment_documents`.
3. Envio para a Micheng (`order.updated`, `document.shared`, `document.reviewed`) por uma função Inngest com novas tentativas, assinando como na seção 2.
4. Variáveis `MICHENG_EVENTS_URL` e `MICHENG_INTEGRATION_SECRET`.

## 7. Teste rápido

Com as variáveis definidas nos dois lados, use **Parâmetros → Integração com a Soulglobal → Testar conexão** no painel da Micheng: o evento `ping` deve aparecer como "Entregue".
