/* Proforma web page: shows the proforma of the link (?t=…), with photos that
   open in full size. Texts in English, Portuguese or Spanish. */
(function () {
  "use strict";

  var L = {
    en: { title: "Proforma invoice", no: "No.", date: "Date", valid: "Valid until", currency: "Currency", billTo: "Bill to", taxId: "Tax ID",
      phone: "Phone", email: "E-mail", web: "Website", code: "Code", ref: "Your ref.", qty: "Qty", unit: "Unit price", total: "Total",
      terms: "Terms & notes", hint: "Click a photo to see it in full size.", print: "Print / PDF", excel: "Download Excel", loading: "Loading…",
      missingTitle: "Proforma not found", missingText: "This link is not valid anymore. Please ask us for a new one.", close: "Close",
      changeQty: "Change quantity", remove: "Remove", undo: "Undo", save: "Send", cancel: "Cancel", newQty: "New quantity",
      reqQty: "Requested quantity", reqRemove: "Removal requested", newTotal: "Total with your changes", origTotal: "Current total",
      ccNote: "You requested changes to {n} item(s). They will be reviewed by us and only apply after we confirm them.",
      ccHint: "You can ask to change quantities or remove items below; we will review your request.", ccError: "Could not send. Please try again." },
    pt: { title: "Fatura proforma", no: "Nº", date: "Data", valid: "Válida até", currency: "Moeda", billTo: "Cliente", taxId: "Tax ID",
      phone: "Telefone", email: "E-mail", web: "Site", code: "Código", ref: "Sua ref.", qty: "Qtd.", unit: "Preço unit.", total: "Total",
      terms: "Condições e observações", hint: "Clique em uma foto para vê-la em tamanho real.", print: "Imprimir / PDF", excel: "Baixar Excel", loading: "Carregando…",
      missingTitle: "Proforma não encontrada", missingText: "Este link não é mais válido. Peça um novo link para nós.", close: "Fechar",
      changeQty: "Alterar quantidade", remove: "Remover", undo: "Desfazer", save: "Enviar", cancel: "Cancelar", newQty: "Nova quantidade",
      reqQty: "Quantidade solicitada", reqRemove: "Remoção solicitada", newTotal: "Total com suas alterações", origTotal: "Total atual",
      ccNote: "Você solicitou alterações em {n} item(ns). Elas serão analisadas por nós e só valem depois de confirmadas.",
      ccHint: "Você pode pedir para alterar quantidades ou remover itens abaixo; analisaremos o seu pedido.", ccError: "Não foi possível enviar. Tente novamente." },
    es: { title: "Factura proforma", no: "Nº", date: "Fecha", valid: "Válida hasta", currency: "Moneda", billTo: "Cliente", taxId: "Tax ID",
      phone: "Teléfono", email: "Correo", web: "Sitio web", code: "Código", ref: "Su ref.", qty: "Cant.", unit: "Precio unit.", total: "Total",
      terms: "Condiciones y observaciones", hint: "Haga clic en una foto para verla en tamaño real.", print: "Imprimir / PDF", excel: "Descargar Excel", loading: "Cargando…",
      missingTitle: "Proforma no encontrada", missingText: "Este enlace ya no es válido. Pídanos uno nuevo.", close: "Cerrar",
      changeQty: "Cambiar cantidad", remove: "Quitar", undo: "Deshacer", save: "Enviar", cancel: "Cancelar", newQty: "Nueva cantidad",
      reqQty: "Cantidad solicitada", reqRemove: "Eliminación solicitada", newTotal: "Total con sus cambios", origTotal: "Total actual",
      ccNote: "Usted solicitó cambios en {n} ítem(s). Los revisaremos y solo valen después de confirmarlos.",
      ccHint: "Puede pedir cambiar cantidades o quitar ítems abajo; revisaremos su pedido.", ccError: "No se pudo enviar. Inténtelo de nuevo." },
    zh: { title: "形式发票", no: "编号", date: "日期", valid: "有效期至", currency: "币种", billTo: "客户", taxId: "税号",
      phone: "电话", email: "邮箱", web: "网站", code: "编码", ref: "客户编号", qty: "数量", unit: "单价", total: "合计",
      terms: "条款与备注", hint: "点击图片可查看大图。", print: "打印 / PDF", excel: "下载 Excel", loading: "加载中…",
      missingTitle: "未找到", missingText: "此链接已失效，请联系我们获取新链接。", close: "关闭",
      changeQty: "修改数量", remove: "删除", undo: "撤销", save: "提交", cancel: "取消", newQty: "新数量",
      reqQty: "申请数量", reqRemove: "已申请删除", newTotal: "按您的修改后的合计", origTotal: "当前合计",
      ccNote: "您已申请修改 {n} 个产品。我们会审核，确认后才生效。",
      ccHint: "您可以在下方申请修改数量或删除产品；我们会审核您的申请。", ccError: "提交失败，请重试。" }
  };
  // Purchase order (a supplier's link): other title and labels.
  var PO = {
    en: { title: "Purchase order", supplier: "Supplier", buyer: "Buyer", unit: "Unit cost" },
    pt: { title: "Pedido de compra", supplier: "Fornecedor", buyer: "Comprador", unit: "Preço de compra" },
    es: { title: "Orden de compra", supplier: "Proveedor", buyer: "Comprador", unit: "Precio de compra" },
    zh: { title: "采购订单", supplier: "供应商", buyer: "采购方", unit: "采购单价" }
  };
  var LOCALE = { en: "en-US", pt: "pt-BR", es: "es-ES", zh: "zh-CN" };
  var CUR = { CNY: { label: "RMB", symbol: "¥" }, USD: { label: "USD", symbol: "US$" }, EUR: { label: "EUR", symbol: "€" }, BRL: { label: "BRL", symbol: "R$" } };

  var $ = function (id) { return document.getElementById(id); };
  var data = null;
  var lang = "en";
  var zoomAt = -1;

  function tx(key, vars) {
    var out = t(key) || "";
    Object.keys(vars || {}).forEach(function (k) { out = out.replace("{" + k + "}", vars[k]); });
    return out;
  }
  var editingQty = null; // item id whose quantity form is open

  function t(key) {
    var po = data && data.kind === "po" && (PO[lang] || PO.en);
    if (po && po[key]) return po[key];
    return (L[lang] || L.en)[key];
  }
  function pick(obj) { obj = obj || {}; return obj[lang] || obj.en || obj.pt || obj.es || obj.zh || ""; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function num(n, digits) {
    return Number(n || 0).toLocaleString(LOCALE[lang], { minimumFractionDigits: digits, maximumFractionDigits: digits == null ? 3 : digits });
  }
  function money(n) { var c = CUR[data.currency] || CUR.CNY; return n == null ? "—" : c.symbol + " " + num(n, 2); }
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
    // Purchase order: the supplier in place of the client.
    if (data.kind === "po" && data.supplier) {
      var sp = data.supplier;
      var spl = [sp.contact, sp.city, sp.phone && t("phone") + ": " + sp.phone, sp.wechat && "WeChat: " + sp.wechat, sp.email && t("email") + ": " + sp.email].filter(Boolean);
      cl = null;
      $("pv-client").hidden = false;
      $("pv-client").innerHTML = "<span>" + esc(t("supplier")) + "</span><b>" + esc(sp.name) + "</b>" + (spl.length ? "<p>" + esc(spl.join("\n")) + "</p>" : "");
    } else $("pv-client").hidden = !cl;
    if (cl) {
      var lines = [cl.address, cl.country, cl.phone && t("phone") + ": " + cl.phone, cl.taxId && t("taxId") + ": " + cl.taxId].filter(Boolean);
      $("pv-client").innerHTML = "<span>" + esc(t("billTo")) + "</span><b>" + esc(cl.name) + "</b>" + (lines.length ? "<p>" + esc(lines.join("\n")) + "</p>" : "");
    }

    var editable = data.editable && data.kind !== "po";
    var changes = data.changes || {};
    $("pv-items").innerHTML = data.items.map(function (it, i) {
      var opts = it.options.map(function (o) { return "<b>" + esc(pick(o.name)) + ":</b> " + esc(pick(o.value)); }).join(" · ");
      var codes = (it.code ? '<span class="pv-code">' + esc(t("code")) + " " + esc(it.code) + "</span>" : "") +
        (it.ref ? "<span>" + esc(t("ref")) + " " + esc(it.ref) + "</span>" : "");
      var ch = editable && it.id ? changes[it.id] : null;
      var cls = ch ? (ch.removed ? " pv-item--removed" : " pv-item--changed") : "";
      return '<li class="pv-item' + cls + '" data-item="' + esc(it.id || "") + '">' +
        '<span class="pv-item__n">' + it.n + "</span>" +
        (it.image
          ? '<button type="button" class="pv-item__photo" data-zoom="' + i + '" aria-label="' + esc(caption(it)) + '"><img src="' + esc(it.image) + '" alt="" loading="lazy" /></button>'
          : '<span class="pv-item__photo pv-item__photo--none"></span>') +
        '<div class="pv-item__info">' + (codes ? '<div class="pv-codes">' + codes + "</div>" : "") +
          "<h3>" + esc(pick(it.name)) + "</h3>" +
          (pick(it.description) ? '<p class="pv-item__desc">' + esc(pick(it.description)) + "</p>" : "") +
          (opts ? '<p class="pv-item__opts">' + opts + "</p>" : "") + "</div>" +
        '<div class="pv-item__price">' + esc(num(it.qty)) + " × " + esc(money(it.price)) + "<b>" + esc(money(it.amount)) + "</b></div>" +
        (editable && it.id ? changeBox(it, ch) : "") +
        "</li>";
    }).join("");
    // Totals: the current one and, when there are requests, the one with them
    var count = Object.keys(changes).length;
    var proposed = data.items.reduce(function (sum, it) {
      var c = changes[it.id];
      if (c && c.removed) return sum;
      return sum + (it.price || 0) * (c && c.qty ? c.qty : it.qty);
    }, 0);
    $("pv-total").textContent = money(data.total);
    $("pv-total-new").hidden = !(editable && count);
    $("pv-total-new").innerHTML = "<span>" + esc(t("newTotal")) + "</span><b>" + esc(money(Math.round(proposed * 100) / 100)) + "</b>";
    $("pv-cc-note").hidden = !editable;
    $("pv-cc-note").className = "pv-cc-note" + (count ? " has-changes" : "");
    $("pv-cc-note").textContent = count ? tx("ccNote", { n: count }) : t("ccHint");
    $("pv-terms").hidden = !data.terms;
    $("pv-terms-text").textContent = data.terms;
    if (zoomAt > -1) showZoom(zoomAt);
  }

  /* ---------- Client's change requests (reviewed by us before they apply) ---------- */
  function changeBox(it, ch) {
    if (editingQty === it.id) {
      return '<form class="pv-cc pv-cc--form" data-qty-form="' + esc(it.id) + '"><label><span>' + esc(t("newQty")) + '</span>' +
        '<input type="number" min="1" step="any" inputmode="decimal" name="qty" value="' + esc(ch && ch.qty ? ch.qty : it.qty) + '" /></label>' +
        '<button type="submit" class="pv-cc__btn pv-cc__btn--main">' + esc(t("save")) + "</button>" +
        '<button type="button" class="pv-cc__btn" data-cc="cancel">' + esc(t("cancel")) + "</button></form>";
    }
    if (ch && ch.removed) {
      return '<div class="pv-cc"><span class="pv-cc__tag pv-cc__tag--removed">' + esc(t("reqRemove")) + "</span>" +
        '<button type="button" class="pv-cc__btn" data-cc="undo">' + esc(t("undo")) + "</button></div>";
    }
    if (ch && ch.qty) {
      return '<div class="pv-cc"><span class="pv-cc__tag">' + esc(t("reqQty")) + ": " + esc(num(it.qty)) + " → <b>" + esc(num(ch.qty)) + "</b> · " +
        esc(money(Math.round((it.price || 0) * ch.qty * 100) / 100)) + "</span>" +
        '<button type="button" class="pv-cc__btn" data-cc="qty">' + esc(t("changeQty")) + "</button>" +
        '<button type="button" class="pv-cc__btn" data-cc="undo">' + esc(t("undo")) + "</button></div>";
    }
    return '<div class="pv-cc"><button type="button" class="pv-cc__btn" data-cc="qty">' + esc(t("changeQty")) + "</button>" +
      '<button type="button" class="pv-cc__btn pv-cc__btn--danger" data-cc="remove">' + esc(t("remove")) + "</button></div>";
  }

  function sendChange(body) {
    var token = new URLSearchParams(location.search).get("t") || "";
    return fetch("/api/proforma-view?t=" + encodeURIComponent(token), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store"
    }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    }).then(function (d) { data.changes = d.changes || {}; editingQty = null; render(); })
      .catch(function () { alert(t("ccError")); });
  }

  $("pv-items").addEventListener("click", function (e) {
    var b = e.target.closest("[data-cc]");
    if (!b) return;
    var id = b.closest("[data-item]").getAttribute("data-item");
    var action = b.getAttribute("data-cc");
    if (action === "qty") { editingQty = id; render(); var f = document.querySelector('[data-qty-form="' + id + '"] input'); if (f) { f.focus(); f.select(); } return; }
    if (action === "cancel") { editingQty = null; render(); return; }
    b.disabled = true;
    sendChange(action === "remove" ? { itemId: id, removed: true } : { itemId: id, undo: true });
  });
  $("pv-items").addEventListener("submit", function (e) {
    var f = e.target.closest("[data-qty-form]");
    if (!f) return;
    e.preventDefault();
    var qty = String(f.elements.qty.value || "").replace(",", ".");
    if (!(Number(qty) > 0)) { f.elements.qty.focus(); return; }
    sendChange({ itemId: f.getAttribute("data-qty-form"), qty: qty });
  });

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
      $("pv-xlsx").hidden = d.kind === "po"; // the Excel file is the client's proforma
      render();
    });
})();
