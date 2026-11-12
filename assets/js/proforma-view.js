/* Proforma web page: shows the proforma of the link (?t=…), with photos that
   open in full size. Texts in English, Portuguese or Spanish. */
(function () {
  "use strict";

  var L = {
    en: { title: "Proforma invoice", no: "No.", date: "Date", valid: "Valid until", currency: "Currency", billTo: "Bill to", taxId: "Tax ID",
      phone: "Phone", email: "E-mail", web: "Website", code: "Code", ref: "Your ref.", qty: "Qty", unit: "Unit price", total: "Total",
      terms: "Terms & notes", hint: "Click a photo to see it in full size.", print: "Print / PDF", excel: "Download Excel", loading: "Loading…",
      missingTitle: "Proforma not found", missingText: "This link is not valid anymore. Please ask us for a new one.", close: "Close" },
    pt: { title: "Fatura proforma", no: "Nº", date: "Data", valid: "Válida até", currency: "Moeda", billTo: "Cliente", taxId: "Tax ID",
      phone: "Telefone", email: "E-mail", web: "Site", code: "Código", ref: "Sua ref.", qty: "Qtd.", unit: "Preço unit.", total: "Total",
      terms: "Condições e observações", hint: "Clique em uma foto para vê-la em tamanho real.", print: "Imprimir / PDF", excel: "Baixar Excel", loading: "Carregando…",
      missingTitle: "Proforma não encontrada", missingText: "Este link não é mais válido. Peça um novo link para nós.", close: "Fechar" },
    es: { title: "Factura proforma", no: "Nº", date: "Fecha", valid: "Válida hasta", currency: "Moneda", billTo: "Cliente", taxId: "Tax ID",
      phone: "Teléfono", email: "Correo", web: "Sitio web", code: "Código", ref: "Su ref.", qty: "Cant.", unit: "Precio unit.", total: "Total",
      terms: "Condiciones y observaciones", hint: "Haga clic en una foto para verla en tamaño real.", print: "Imprimir / PDF", excel: "Descargar Excel", loading: "Cargando…",
      missingTitle: "Proforma no encontrada", missingText: "Este enlace ya no es válido. Pídanos uno nuevo.", close: "Cerrar" }
  };
  var LOCALE = { en: "en-US", pt: "pt-BR", es: "es-ES" };
  var CUR = { CNY: { label: "RMB", symbol: "¥" }, USD: { label: "USD", symbol: "US$" }, EUR: { label: "EUR", symbol: "€" }, BRL: { label: "BRL", symbol: "R$" } };

  var $ = function (id) { return document.getElementById(id); };
  var data = null;
  var lang = "en";
  var zoomAt = -1;

  function t(key) { return (L[lang] || L.en)[key]; }
  function pick(obj) { obj = obj || {}; return obj[lang] || obj.en || obj.pt || obj.es || obj.zh || ""; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(n, digits) {
    return Number(n || 0).toLocaleString(LOCALE[lang], { minimumFractionDigits: digits, maximumFractionDigits: digits == null ? 3 : digits });
  }
  function money(n) { var c = CUR[data.currency] || CUR.CNY; return c.symbol + " " + num(n, 2); }
  function date(iso) { return iso ? new Date(iso + "T00:00:00").toLocaleDateString(LOCALE[lang]) : ""; }
  function caption(it) {
    var opts = it.options.map(function (o) { return pick(o.value); }).filter(Boolean).join(" · ");
    return [it.code, pick(it.name), opts].filter(Boolean).join(" — ");
  }

  function render() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-t]").forEach(function (el) { el.textContent = t(el.getAttribute("data-t")); });
    document.querySelectorAll(".pv-lang button").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-lang") === lang); });
    $("pv-zoom-close").setAttribute("aria-label", t("close"));
    if (!data) return;
    document.title = data.number + " | " + t("title");

    var c = data.company;
    var contact = [c.phone && t("phone") + ": " + c.phone, c.email && t("email") + ": " + c.email, c.website && t("web") + ": " + c.website].filter(Boolean);
    $("pv-company").innerHTML = "<b>" + esc(c.name || "Shenzhen Micheng International Trading Co., Ltd.") + "</b>" +
      (c.address ? "<p>" + esc(c.address) + "</p>" : "") + (contact.length ? "<p>" + esc(contact.join("\n")) + "</p>" : "");

    var meta = [[t("no"), data.number], [t("date"), date(data.date)]];
    if (data.validUntil) meta.push([t("valid"), date(data.validUntil)]);
    meta.push([t("currency"), (CUR[data.currency] || CUR.CNY).label]);
    if (data.incoterm) meta.push(["Incoterm", data.incoterm]);
    $("pv-meta").innerHTML = meta.map(function (m) { return "<dt>" + esc(m[0]) + "</dt><dd>" + esc(m[1]) + "</dd>"; }).join("");

    var cl = data.client;
    $("pv-client").hidden = !cl;
    if (cl) {
      var lines = [cl.address, cl.country, cl.phone && t("phone") + ": " + cl.phone, cl.taxId && t("taxId") + ": " + cl.taxId].filter(Boolean);
      $("pv-client").innerHTML = "<span>" + esc(t("billTo")) + "</span><b>" + esc(cl.name) + "</b>" + (lines.length ? "<p>" + esc(lines.join("\n")) + "</p>" : "");
    }

    $("pv-items").innerHTML = data.items.map(function (it, i) {
      var opts = it.options.map(function (o) { return "<b>" + esc(pick(o.name)) + ":</b> " + esc(pick(o.value)); }).join(" · ");
      var codes = (it.code ? '<span class="pv-code">' + esc(t("code")) + " " + esc(it.code) + "</span>" : "") +
        (it.ref ? "<span>" + esc(t("ref")) + " " + esc(it.ref) + "</span>" : "");
      return '<li class="pv-item">' +
        '<span class="pv-item__n">' + it.n + "</span>" +
        (it.image
          ? '<button type="button" class="pv-item__photo" data-zoom="' + i + '" aria-label="' + esc(caption(it)) + '"><img src="' + esc(it.image) + '" alt="" loading="lazy" /></button>'
          : '<span class="pv-item__photo pv-item__photo--none"></span>') +
        '<div class="pv-item__info">' + (codes ? '<div class="pv-codes">' + codes + "</div>" : "") +
          "<h3>" + esc(pick(it.name)) + "</h3>" +
          (pick(it.description) ? '<p class="pv-item__desc">' + esc(pick(it.description)) + "</p>" : "") +
          (opts ? '<p class="pv-item__opts">' + opts + "</p>" : "") + "</div>" +
        '<div class="pv-item__price">' + esc(num(it.qty)) + " × " + esc(money(it.price)) + "<b>" + esc(money(it.amount)) + "</b></div>" +
        "</li>";
    }).join("");
    $("pv-total").textContent = money(data.total);
    $("pv-terms").hidden = !data.terms;
    $("pv-terms-text").textContent = data.terms;
    if (zoomAt > -1) showZoom(zoomAt);
  }

  /* ---------- Full-size photo, with previous / next ---------- */
  var withPhoto = function () { return data.items.map(function (it, i) { return it.image ? i : -1; }).filter(function (i) { return i > -1; }); };

  function showZoom(i) {
    var it = data.items[i];
    zoomAt = i;
    $("pv-zoom-img").src = it.image;
    $("pv-zoom-cap").textContent = it.n + ". " + caption(it);
    var list = withPhoto();
    $("pv-zoom-prev").hidden = $("pv-zoom-next").hidden = list.length < 2;
    var z = $("pv-zoom");
    if (!z.open) { if (typeof z.showModal === "function") z.showModal(); else z.setAttribute("open", ""); }
  }
  function step(dir) {
    var list = withPhoto();
    var k = list.indexOf(zoomAt);
    showZoom(list[(k + dir + list.length) % list.length]);
  }
  function closeZoom() { zoomAt = -1; var z = $("pv-zoom"); if (z.open) z.close(); }

  $("pv-items").addEventListener("click", function (e) {
    var b = e.target.closest("[data-zoom]");
    if (b) showZoom(Number(b.getAttribute("data-zoom")));
  });
  $("pv-zoom-close").addEventListener("click", closeZoom);
  $("pv-zoom-prev").addEventListener("click", function () { step(-1); });
  $("pv-zoom-next").addEventListener("click", function () { step(1); });
  $("pv-zoom").addEventListener("click", function (e) { if (e.target === this || e.target.tagName === "FIGURE") closeZoom(); });
  $("pv-zoom").addEventListener("close", function () { zoomAt = -1; });
  document.addEventListener("keydown", function (e) {
    if (zoomAt < 0) return;
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
  // Swipe left / right on phones.
  var touchX = null;
  $("pv-zoom").addEventListener("touchstart", function (e) { touchX = e.touches[0].clientX; }, { passive: true });
  $("pv-zoom").addEventListener("touchend", function (e) {
    if (touchX == null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
  });

  document.querySelectorAll(".pv-lang button").forEach(function (b) {
    b.addEventListener("click", function () { lang = b.getAttribute("data-lang"); render(); });
  });
  $("pv-print").addEventListener("click", function () { window.print(); });

  // The same Excel file the admin exports (without bank details, which the page does not show either).
  $("pv-xlsx").addEventListener("click", function () {
    var btn = this;
    var PD = window.ProformaDoc;
    var docLang = PD.DOC[lang] ? lang : "en"; // the file uses the page's language
    var d = {
      lang: docLang,
      L: PD.DOC[docLang],
      settings: { companyName: data.company.name, address: data.company.address, phone: data.company.phone, email: data.company.email, website: data.company.website },
      cur: CUR[data.currency] || CUR.CNY,
      items: data.items.map(function (it) {
        return {
          n: it.n, code: it.code || "", ref: it.ref || "", name: pick(it.name), description: pick(it.description),
          options: it.options.map(function (o) { return pick(o.name) + ": " + pick(o.value); }),
          qty: it.qty, price: it.price || 0, amount: it.amount
        };
      }),
      total: data.total,
      p: { number: data.number, date: data.date, validUntil: data.validUntil, client: data.client, terms: data.terms, incoterm: data.incoterm || "" },
      link: location.href
    };
    btn.disabled = true;
    PD.buildXlsx(d).catch(function () { alert("Excel: download failed. Please try again."); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Load ---------- */
  var params = new URLSearchParams(location.search);
  var wanted = params.get("lang");
  lang = L[wanted] ? wanted : "en";
  render();
  fetch("/api/proforma-view?t=" + encodeURIComponent(params.get("t") || ""), { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; })
    .then(function (d) {
      $("pv-loading").hidden = true;
      if (!d) { $("pv-missing").hidden = false; return; }
      data = d;
      if (!L[wanted]) lang = L[d.language] ? d.language : "en";
      $("pv-doc").hidden = false;
      $("pv-xlsx").hidden = false;
      render();
    });
})();
