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
- Dica: nomes de uma palavra que existem em vários idiomas (ex.: "Mesa") são ambíguos; uma descrição curta resolve.
- Os produtos aparecem no site na seção **Nossos Produtos**, no idioma escolhido pelo visitante.
- As fotos são reduzidas no navegador (até 1600 px) antes do envio.

### Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Para quê |
| --- | --- |
| `ADMIN_USER` | Usuário do login (padrão `admin`). |
| `ADMIN_PASSWORD` | Senha do login. Para trocar: altere aqui e faça um novo deploy. |
| `SESSION_SECRET` | Chave que assina a sessão de login (texto aleatório longo). |
| `BLOB_READ_WRITE_TOKEN` | Criada automaticamente ao ligar o Vercel Blob (onde ficam produtos e fotos). |
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

Publicado na Vercel (`vercel deploy --prod`). A área restrita depende das funções em `api/` e do Vercel Blob, por isso o site precisa ficar na Vercel.

Fotos: [Unsplash](https://unsplash.com) (licença Unsplash).
