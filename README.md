# Micheng — site institucional

Site (HTML + CSS + JavaScript, sem build, com funções serverless da Vercel para a área restrita) da **Shenzhen Micheng International Trading**, em 4 idiomas: português, inglês, espanhol e chinês.

## Como rodar localmente

```bash
npm install
ADMIN_PASSWORD=uma-senha npm run dev
# site:  http://localhost:3000
# admin: http://localhost:3000/admin  (usuário: admin)
```

Sem as variáveis da Vercel, os produtos e fotos ficam na pasta `.data/` (ignorada pelo git).

## Área restrita (cadastro de produtos)

- Endereço: `/admin` (há também um link "Área restrita" no rodapé).
- O painel está em português, inglês, espanhol e chinês (seletor de idioma no topo; a escolha é compartilhada com o site).
- O administrador cadastra **nome, descrição e foto**, em qualquer idioma. O idioma do cadastro é identificado automaticamente (a partir do nome e da descrição juntos; chinês é reconhecido pelos caracteres) e o produto é traduzido para português, inglês, espanhol e chinês. O painel mostra o idioma identificado, e as traduções podem ser corrigidas ao editar o produto.
- Cada produto pertence a uma das 4 categorias da página inicial: Materiais de Construção, Louças e Metais, Fitness e Recovery e Produtos Gerais. Na página de produtos há um filtro por categoria.
- **Características** do produto, cada uma com suas opções (ex.: Revestimento → PVC, Silicone). São traduzidas automaticamente para os 4 idiomas (a característica inteira de uma vez, para dar contexto ao tradutor) e aparecem no detalhe do produto no site. Cada característica e cada opção têm um código fixo (`id`), pensado para as futuras proformas registrarem a opção escolhida mesmo que o texto seja editado depois.
- Aba **Fornecedores** (somente administradores): cadastro de fornecedores (empresa, contato, telefone/WhatsApp, WeChat, e-mail, cidade/endereço, site e observações). No cadastro do produto, é possível vincular **vários fornecedores** a um mesmo item. Fornecedores e vínculos nunca aparecem no site nem na API pública (`/api/products` só os inclui para quem está logado), e são guardados **criptografados** (AES-256-GCM).
- No cadastro do produto, cada fornecedor vinculado tem o seu **preço de compra**.
- Aba **Proformas** (somente administradores): escolhe-se o cliente e os itens (produto, fornecedor, opções de cada característica, quantidade). O custo vem do preço de compra do fornecedor; o preço de venda é digitado. Cada item mostra **margem** ((venda − custo) ÷ venda) e **lucro**, e há totais da proforma. Ao **fechar** a proforma, os preços de venda ficam guardados para aquele cliente (por produto + opções) e a próxima proforma dele já vem com esses preços. Proformas fechadas podem ser reabertas. Numeração automática por ano (PF-2026-001…). Exporta **PDF** e **Excel** em inglês, português ou espanhol, **sem** fornecedor, custo, margem ou lucro.
- Moeda padrão: **RMB** (configurável em Parâmetros); cada proforma pode usar RMB, USD, EUR ou BRL, e o custo é informado na mesma moeda.
- Aba **Clientes** (somente administradores): nome, endereço, telefone e Tax ID.
- Aba **Parâmetros** (somente administradores): dados da Shenzhen Micheng usados nas proformas — nome, endereço, telefone, e-mail, site e conta bancária (beneficiário, banco, número da conta, SWIFT/BIC, endereço do banco e outras informações).
- Fornecedores, clientes e parâmetros ficam no mesmo arquivo criptografado e só são acessíveis com login.
- Dica: nomes de uma palavra que existem em vários idiomas (ex.: "Mesa") são ambíguos; uma descrição curta resolve.
- Os produtos aparecem na página **/products** (`products.html`), no idioma escolhido pelo visitante. Na página inicial, cada cartão de categoria leva a essa página já filtrada (ex.: `/products?category=fitness`). Ids das categorias: `building`, `sanitary`, `fitness`, `general`.
- "Solicitar cotação" num produto leva ao formulário de contato da página inicial, já preenchido com o produto e a categoria.
- As fotos são ajustadas no navegador antes do envio: ficam **quadradas** (até 1600 × 1600 px). Uma foto retangular é centralizada e o espaço que sobra é preenchido com a cor de fundo da própria foto, quando o fundo é liso (ex.: fundo branco de estúdio), ou com uma versão desfocada da foto, quando é uma foto de ambiente.

### Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Para quê |
| --- | --- |
| `ADMIN_USER` | Usuário do login (padrão `admin`). |
| `ADMIN_PASSWORD` | Senha do login. Para trocar: altere aqui e faça um novo deploy. |
| `ADMIN_USERS` | Administradores adicionais, em JSON: `{"usuario": "scrypt:<sal>:<hash>"}`. Para gerar o hash de uma senha: `node -e "import('./api/_lib/auth.js').then(a=>console.log(a.hashPassword('SENHA')))"`. |
| `SESSION_SECRET` | Chave que assina a sessão de login (texto aleatório longo). |
| `PRIVATE_DATA_KEY` | Chave que criptografa os dados de fornecedores. **Não altere nem apague**: sem ela, os fornecedores salvos não podem mais ser lidos. |
| `BLOB_READ_WRITE_TOKEN` | Criada automaticamente ao ligar o Vercel Blob (onde ficam as fotos). |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Criadas automaticamente ao ligar o banco Upstash Redis (onde ficam produtos, fornecedores, clientes, proformas e parâmetros). |
| `DEEPL_API_KEY` | Opcional: usa o DeepL para traduzir (melhor qualidade, 500 mil caracteres/mês grátis). |
| `MYMEMORY_EMAIL` | Opcional: sem DeepL, a tradução usa o MyMemory gratuito (cerca de 5 mil caracteres/dia); um e-mail aqui aumenta o limite para 50 mil/dia. |

Se a tradução automática falhar (limite diário, por exemplo), o produto é salvo mesmo assim com o texto original e marcado como "Tradução automática pendente" no painel; basta editá-lo depois e marcar "Traduzir tudo de novo".

## Idiomas

- Os textos ficam em `assets/js/i18n.js` (chaves `en`, `pt`, `es`, `zh`).
- O idioma é escolhido pelos botões do cabeçalho, pelo parâmetro `?lang=pt|en|es|zh` na URL ou, na primeira visita, pelo idioma do navegador. A escolha fica salva no navegador.

## O que trocar antes de publicar

- **E-mail e telefone**: `index.html` (seção `#contact`) e `CONTACT_EMAIL` em `assets/js/main.js`. Hoje estão com valores provisórios (`contact@micheng.com`, `+86 000 0000 0000`).
- **Números** (50+ clientes, 1.000+ categorias, 30+ países): seção `#about` do `index.html`.
- O formulário abre o app de e-mail do visitante (`mailto:`). Para receber direto no servidor, troque por um serviço como Formspree ou Netlify Forms.

## Publicação

Publicado na Vercel (`vercel deploy --prod`). A área restrita depende das funções em `api/` do Upstash Redis e do Vercel Blob, por isso o site precisa ficar na Vercel.

Fotos: [Unsplash](https://unsplash.com) (licença Unsplash).

## Segurança e desempenho

- `vercel.json` define os cabeçalhos de segurança (CSP, `X-Frame-Options`, `nosniff`) e o cache de imagens e bibliotecas.
- As bibliotecas de PDF e Excel ficam em `assets/vendor/` (jsPDF 2.5.1, jsPDF-AutoTable 3.8.2, ExcelJS 4.4.0), sem depender de sites externos.
- O painel carrega tudo de uma vez por `/api/bootstrap` e recarrega ao trocar de aba.
- Trocar a senha de um administrador encerra as sessões abertas dele.
