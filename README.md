# Michent — site institucional

Site estático (HTML + CSS + JavaScript, sem build) da **Shenzhen Michent International Trading**, em 4 idiomas: português, inglês, espanhol e chinês.

## Como ver localmente

Abra o `index.html` no navegador ou rode um servidor simples:

```bash
python3 -m http.server 8000
# http://localhost:8000
```

## Idiomas

- Os textos ficam em `assets/js/i18n.js` (chaves `en`, `pt`, `es`, `zh`).
- O idioma é escolhido pelos botões do cabeçalho, pelo parâmetro `?lang=pt|en|es|zh` na URL ou, na primeira visita, pelo idioma do navegador. A escolha fica salva no navegador.

## O que trocar antes de publicar

- **E-mail e telefone**: `index.html` (seção `#contact`) e `CONTACT_EMAIL` em `assets/js/main.js`. Hoje estão com valores provisórios (`contact@michent.com`, `+86 000 0000 0000`).
- **Números** (50+ clientes, 1.000+ categorias, 30+ países): seção `#about` do `index.html`.
- O formulário abre o app de e-mail do visitante (`mailto:`). Para receber direto no servidor, troque por um serviço como Formspree ou Netlify Forms.

## Publicação

Por ser estático, pode ser publicado direto em Vercel, Netlify, GitHub Pages ou qualquer hospedagem — basta apontar para a raiz do repositório.

Fotos: [Unsplash](https://unsplash.com) (licença Unsplash).
