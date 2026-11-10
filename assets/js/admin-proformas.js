/* Proformas tab: list, editor (with cost, margin and profit, which stay
   internal) and export to PDF / Excel (which show only sale prices). */
(function () {
  "use strict";

  var A = window.Admin;
  var $ = function (sel) { return document.querySelector(sel); };
  var T = function (k, v) { return A.T(k, v); };
  var esc = function (s) { return A.escapeHtml(s); };

  var proformas = [];
  var editing = null; // saved proforma being edited (null = new, not saved yet)
  var rows = []; // items being edited
  var clientPrices = {}; // remembered sale prices of the selected client
  var form = $("#pf-form");

  /* ---------- Helpers ---------- */
  function round(n, d) { var k = Math.pow(10, d || 2); return Math.round(n * k) / k; }
  function toNum(v) { var n = parseFloat(String(v).replace(",", ".")); return isFinite(n) ? n : null; }
  function productById(id) { return A.products().filter(function (p) { return p.id === id; })[0]; }
  function supplierById(id) { return A.suppliers().filter(function (s) { return s.id === id; })[0]; }
  function pname(p, lang) {
    if (!p) return "";
    var n = p.name || {};
    return n[lang || A.lang()] || n.en || n.pt || (p.source && p.source.name) || "";
  }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + (iso.length === 10 ? "T00:00:00" : ""));
    return d.toLocaleDateString(A.locale());
  }
  function today(offsetDays) {
    var d = new Date(Date.now() + (offsetDays || 0) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  function currency() { return form.elements.currency.value || A.defaultCurrency(); }
  function isClosed() { return Boolean(editing && editing.status === "closed"); }

  // Same key as the server (api/proformas.js priceKey).
  function priceKey(productId, optionIds) {
    var ids = optionIds.filter(Boolean).sort();
    return productId + (ids.length ? "|" + ids.join(",") : "");
  }

  // "1001" or "1001-2" for the row's product and chosen options.
  function skuOf(row) {
    var p = productById(row.productId);
    if (!p || !p.sku) return row.sku || "";
    var current = {};
    (p.attributes || []).forEach(function (a) { a.options.forEach(function (o) { current[o.id] = true; }); });
    var ids = Object.keys(row.options).map(function (k) { return row.options[k]; }).filter(function (id) { return id && current[id]; });
    var n = p.variantSkus && p.variantSkus[priceKey("", ids).replace(/^\|/, "")];
    return n ? p.sku + "-" + n : String(p.sku);
  }

  // Photo of the row's configuration: the variant photo when it has one.
  function rowImage(row, product) {
    if (!product) return row.snapshot && row.snapshot.image;
    var current = {};
    (product.attributes || []).forEach(function (a) { a.options.forEach(function (o) { current[o.id] = true; }); });
    var key = Object.keys(row.options).map(function (k) { return row.options[k]; })
      .filter(function (id) { return id && current[id]; }).sort().join(",");
    return (product.variantImages && product.variantImages[key]) || product.image;
  }

  function setStatus(msg, kind) {
    var el = $("#pf-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }

  function margin(price, cost) {
    if (!price || cost == null) return null;
    return (price - cost) / price;
  }
  function pct(v) { return v == null ? "—" : (v * 100).toLocaleString(A.locale(), { maximumFractionDigits: 1 }) + "%"; }

  /* ---------- List ---------- */
  function load() {
    if ($("#app-view").hidden) return; // not logged in yet
    A.api("/api/proformas").then(function (data) {
      proformas = data.proformas || [];
      renderList();
    }).catch(function (e) { setStatus(e.message, "error"); });
  }

  function renderList() {
    var q = $("#pf-search").value.trim().toLowerCase();
    $("#pf-count").textContent = proformas.length;
    $("#tab-count-proformas").textContent = proformas.length;
    $("#pf-empty").hidden = proformas.length > 0;
    $("#pf-table").hidden = proformas.length === 0;
    var shown = proformas.filter(function (p) {
      return !q || (p.number + " " + (p.client ? p.client.name : "")).toLowerCase().indexOf(q) > -1;
    });
    $("#pf-rows").innerHTML = shown.map(function (p) {
      var hasProfit = p.totals.profit != null;
      var m = hasProfit ? margin(p.totals.saleWithCost != null ? p.totals.saleWithCost : p.totals.sale, p.totals.cost) : null;
      return '<tr data-id="' + esc(p.id) + '">' +
        "<td><b>" + esc(p.number) + "</b></td>" +
        "<td>" + esc(p.client ? p.client.name : "—") + "</td>" +
        "<td>" + esc(fmtDate(p.date)) + "</td>" +
        '<td><span class="badge badge--' + p.status + '">' + esc(T(p.status === "closed" ? "pf.closed" : "pf.draft")) + "</span></td>" +
        '<td class="num">' + esc(A.money(p.totals.sale, p.currency)) + "</td>" +
        '<td class="num internal">' + (hasProfit ? esc(A.money(p.totals.profit, p.currency)) + " <small>" + esc(pct(m)) + "</small>" : "—") + "</td>" +
        '<td class="num"><button type="button" class="btn btn--outline btn--sm" data-open="' + esc(p.id) + '">' + esc(T("pf.open")) + "</button></td></tr>";
    }).join("");
  }

  $("#pf-search").addEventListener("input", renderList);
  $("#pf-rows").addEventListener("click", function (e) {
    var tr = e.target.closest("tr[data-id]");
    if (!tr) return;
    var p = proformas.filter(function (x) { return x.id === tr.dataset.id; })[0];
    if (p) openEditor(p);
  });

  /* ---------- Editor ---------- */
  function showEditor(on) {
    $("#pf-list-panel").hidden = on;
    $("#pf-editor").hidden = !on;
    window.scrollTo(0, 0);
  }

  function fillClientSelect() {
    var sel = form.elements.clientId;
    var value = sel.value || (editing && editing.clientId) || "";
    var clients = A.clients();
    var opts = '<option value="">' + esc(T(clients.length ? "pf.selectClient" : "pf.noClients")) + "</option>";
    opts += clients.map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("");
    // A client deleted after the proforma was saved still shows its saved name.
    if (editing && editing.clientId && editing.client && !clients.some(function (c) { return c.id === editing.clientId; })) {
      opts += '<option value="' + esc(editing.clientId) + '">' + esc(editing.client.name) + "</option>";
    }
    sel.innerHTML = opts;
    sel.value = value;
  }

  function loadClientPrices(clientId) {
    clientPrices = {};
    if (!clientId) return Promise.resolve();
    return A.api("/api/proformas?prices=" + encodeURIComponent(clientId)).then(function (data) {
      clientPrices = data.prices || {};
    }).catch(function () { clientPrices = {}; });
  }

  function openEditor(p) {
    editing = p || null;
    setStatus("");
    form.reset();
    fillClientSelect();
    form.elements.clientId.value = p ? p.clientId || "" : "";
    form.elements.date.value = p ? p.date : today();
    form.elements.validUntil.value = p ? p.validUntil || "" : today(30);
    form.elements.currency.value = p ? p.currency : A.defaultCurrency();
    form.elements.language.value = p ? p.language : (["en", "pt", "es"].indexOf(A.lang()) > -1 ? A.lang() : "en");
    form.elements.terms.value = p ? p.terms || "" : "";
    rows = p ? p.items.map(function (i) {
      var opts = {};
      i.options.forEach(function (o) { opts[o.attrId] = o.optionId; });
      return { id: i.id, productId: i.productId, sku: i.sku, snapshot: i.product, supplierId: i.supplierId || "", options: opts,
        qty: i.qty, cost: i.cost, price: i.price, priceAuto: false, editing: false };
    }) : [];
    loadClientPrices(form.elements.clientId.value).then(function () {
      renderHeader();
      renderItems();
    });
    renderHeader();
    renderItems();
    showEditor(true);
  }

  function renderHeader() {
    var closed = isClosed();
    $("#pf-title").textContent = editing ? editing.number : T("pf.newTitle");
    var badge = $("#pf-badge");
    badge.hidden = !editing;
    if (editing) {
      badge.className = "badge badge--" + editing.status;
      badge.textContent = T(closed ? "pf.closed" : "pf.draft");
    }
    $("#pf-save").hidden = closed;
    $("#pf-close").hidden = closed;
    $("#pf-reopen").hidden = !closed;
    $("#pf-delete").hidden = !editing;
    $("#pf-add-item").hidden = closed;
    form.querySelectorAll(".pf-fields input, .pf-fields select, textarea").forEach(function (el) { el.disabled = closed; });
  }

  // Price remembered for this client, product and options (falls back to the product alone).
  function rememberedPrice(row) {
    var ids = Object.keys(row.options).map(function (k) { return row.options[k]; });
    var memo = clientPrices[priceKey(row.productId, ids)] || clientPrices[row.productId];
    return memo && memo.currency === currency() ? memo : null;
  }

  function supplierOptions(product, row) {
    var links = (product && product.supplierLinks) || [];
    var html = '<option value="">' + esc(T("pf.noSupplier")) + "</option>";
    html += links.map(function (l) {
      var s = supplierById(l.supplierId);
      if (!s) return "";
      var c = linkCost(product, l, row);
      return '<option value="' + esc(s.id) + '"' + (row.supplierId === s.id ? " selected" : "") + ">" + esc(s.company) +
        (c != null ? " — " + esc(A.money(c, A.defaultCurrency())) : "") + "</option>";
    }).join("");
    if (row.supplierId && !links.some(function (l) { return l.supplierId === row.supplierId; })) {
      var s = supplierById(row.supplierId);
      html += '<option value="' + esc(row.supplierId) + '" selected>' + esc(s ? s.company : "?") + "</option>";
    }
    return html;
  }

  // Rows repeating an earlier row (same product and same options): { rowIndex: firstRowIndex }.
  function duplicateRows() {
    var first = {}, dups = {};
    rows.forEach(function (row, i) {
      if (!row.productId) return;
      var product = productById(row.productId);
      var chosen = Object.keys(row.options).map(function (k) { return row.options[k]; }).filter(Boolean);
      var needed = product ? (product.attributes || []).length : chosen.length;
      if (chosen.length < needed) return; // options still being chosen
      var key = priceKey(row.productId, chosen);
      if (key in first) dups[i] = first[key];
      else first[key] = i;
    });
    return dups;
  }

  function duplicateMessage(dups) {
    var i = Object.keys(dups)[0];
    return i == null ? "" : T("pf.problem.duplicate", { n: Number(i) + 1, of: dups[i] + 1 });
  }

  var ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';
  var ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

  // What is missing for a row to be confirmed with "OK" ("" = nothing).
  function rowProblem(row, i, dups) {
    var product = productById(row.productId);
    if (!row.productId) return T("pf.problem.product", { n: i + 1 });
    var needed = product ? (product.attributes || []).length : Object.keys(row.options).length;
    var chosen = Object.keys(row.options).filter(function (k) { return row.options[k]; }).length;
    if (chosen < needed) return T("pf.problem.options", { n: i + 1 });
    if (!(row.qty > 0)) return T("pf.problem.qty", { n: i + 1 });
    if (row.price == null) return T("pf.problem.price", { n: i + 1 });
    if (i in dups) return T("pf.problem.duplicate", { n: i + 1, of: dups[i] + 1 });
    return "";
  }

  function optionSummary(row, product) {
    if (product) {
      return (product.attributes || []).map(function (a) {
        var o = a.options.filter(function (x) { return x.id === row.options[a.id]; })[0];
        return o ? ((a.name && a.name[A.lang()]) || a.source) + ": " + ((o.label && o.label[A.lang()]) || o.source) : "";
      }).filter(Boolean);
    }
    return []; // product deleted: options are shown from the saved copy on the PDF
  }

  // Confirmed item: one compact, locked line with pencil (edit) and bin (delete).
  function compactRow(row, i, product, image, closed, dups) {
    var cur = currency();
    var supplier = row.supplierId ? supplierById(row.supplierId) : null;
    var opts = optionSummary(row, product);
    var name = product ? pname(product) : pname(row.snapshot);
    return '<div class="pf-row' + (i in dups ? " is-dup" : "") + (closed ? "" : " is-sortable") + '" data-row="' + i + '"' +
      (closed ? "" : ' title="' + esc(T("pf.dragHint")) + '"') + ">" +
      '<span class="pf-row__n">' + (closed ? "" : '<svg class="pf-grip" viewBox="0 0 10 16" aria-hidden="true"><circle cx="3" cy="3" r="1.4"/><circle cx="7" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="7" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="7" cy="13" r="1.4"/></svg>') + "<b>" + (i + 1) + "</b></span>" +
      '<div class="pf-row__img">' + (image ? '<img src="' + esc(image) + '" alt="" />' : "") + "</div>" +
      '<div class="pf-row__info"><b>' + (skuOf(row) ? '<span class="sku">' + esc(skuOf(row)) + "</span> " : "") + esc(name) + "</b>" +
        (opts.length ? "<small>" + esc(opts.join(" · ")) + "</small>" : "") +
        '<small class="internal">' + esc(T("pf.supplier")) + ": " + esc(supplier ? supplier.company : "—") +
          (row.cost != null ? " · " + esc(T("pf.cost")) + " " + esc(A.money(row.cost, cur)) : "") + "</small>" +
      "</div>" +
      '<div class="pf-row__qty"><b>' + esc(String(row.qty)) + "</b> × " + esc(A.money(row.price, cur)) + "</div>" +
      '<div class="pf-row__total"><b data-out="total"></b></div>' +
      '<div class="pf-row__margin internal"><b data-out="margin"></b><small data-out="profit"></small></div>' +
      (closed ? "" : '<div class="pf-row__actions">' +
        '<button type="button" class="icon-btn" data-edit="' + i + '" aria-label="' + esc(T("pf.editItem")) + '" title="' + esc(T("pf.editItem")) + '">' + ICON_EDIT + "</button>" +
        '<button type="button" class="icon-btn icon-btn--danger" data-remove="' + i + '" aria-label="' + esc(T("pf.removeItem")) + '" title="' + esc(T("pf.removeItem")) + '">' + ICON_TRASH + "</button></div>") +
      (i in dups ? '<p class="pf-dup" role="alert">' + esc(T("pf.problem.duplicate", { n: i + 1, of: dups[i] + 1 })) + "</p>" : "") +
      "</div>";
  }

  function renderItems() {
    var closed = isClosed();
    var dups = duplicateRows();
    var products = A.products();
    var dis = closed ? " disabled" : "";
    $("#pf-items").innerHTML = rows.map(function (row, i) {
      var product = productById(row.productId);
      var image = rowImage(row, product);
      if (closed || !row.editing) return compactRow(row, i, product, image, closed, dups);
      var productOpts = '<option value="">' + esc(T("pf.selectProduct")) + "</option>" + products.map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === row.productId ? " selected" : "") + ">" + esc((p.sku ? p.sku + " · " : "") + pname(p)) + "</option>";
      }).join("");
      if (row.productId && !product) {
        productOpts += '<option value="' + esc(row.productId) + '" selected>' + esc(pname(row.snapshot)) + "</option>";
      }
      var attrs = (product && product.attributes) || [];
      var attrHtml = attrs.map(function (a) {
        var chosen = row.options[a.id] || "";
        return '<label class="pf-opt"><span>' + esc((a.name && a.name[A.lang()]) || a.source) + "</span>" +
          '<select data-attr="' + esc(a.id) + '"' + dis + (chosen ? "" : ' class="is-empty"') + '><option value="">' + esc(T("pf.chooseOption")) + "</option>" +
          a.options.map(function (o) {
            return '<option value="' + esc(o.id) + '"' + (o.id === chosen ? " selected" : "") + ">" + esc((o.label && o.label[A.lang()]) || o.source) + "</option>";
          }).join("") + "</select></label>";
      }).join("");
      var memo = row.productId ? rememberedPrice(row) : null;
      return '<div class="pf-item' + (i in dups ? " is-dup" : "") + '" data-row="' + i + '">' +
        '<div class="pf-item__img">' + (image ? '<img src="' + esc(image) + '" alt="" />' : "") + "</div>" +
        '<div class="pf-item__main">' +
          '<div class="pf-item__line">' +
            '<label class="pf-item__product"><span>' + esc(T("pf.product")) + " " + (i + 1) + (skuOf(row) ? ' · <span class="sku">' + esc(skuOf(row)) + "</span>" : "") + "</span><select data-f=\"productId\"" + dis + ">" + productOpts + "</select></label>" +
            '<label class="pf-item__supplier internal"><span>' + esc(T("pf.supplier")) + '</span><select data-f="supplierId"' + dis + ">" + supplierOptions(product, row) + "</select></label>" +
          "</div>" +
          (attrHtml ? '<div class="pf-item__opts">' + attrHtml + "</div>" : "") +
          '<div class="pf-item__nums">' +
            '<label><span>' + esc(T("pf.qty")) + '</span><input type="number" min="0" step="1" inputmode="decimal" data-f="qty" value="' + esc(row.qty == null ? "" : row.qty) + '"' + dis + " /></label>" +
            '<label class="internal"><span>' + esc(T("pf.cost")) + '</span><input type="number" min="0" step="0.01" inputmode="decimal" data-f="cost" value="' + esc(row.cost == null ? "" : row.cost) + '"' + dis + " /></label>" +
            '<label><span>' + esc(T("pf.price")) + '</span><input type="number" min="0" step="0.01" inputmode="decimal" data-f="price" value="' + esc(row.price == null ? "" : row.price) + '"' + dis + " /></label>" +
            '<div class="pf-calc"><span>' + esc(T("pf.lineTotal")) + '</span><b data-out="total"></b></div>' +
            '<div class="pf-calc internal"><span>' + esc(T("pf.margin")) + '</span><b data-out="margin"></b></div>' +
            '<div class="pf-calc internal"><span>' + esc(T("pf.lineProfit")) + '</span><b data-out="profit"></b></div>' +
          "</div>" +
          (memo ? '<p class="pf-memo">' + esc(T("pf.lastPrice", { price: A.money(memo.price, memo.currency), number: memo.number })) + "</p>" : "") +
          (i in dups ? '<p class="pf-dup" role="alert">' + esc(T("pf.problem.duplicate", { n: i + 1, of: dups[i] + 1 })) + "</p>" : "") +
          '<div class="pf-item__foot">' +
            (row.error && !(i in dups) ? '<p class="pf-dup" role="alert">' + esc(row.error) + "</p>" : "<span></span>") +
            '<button type="button" class="btn btn--primary btn--sm pf-ok" data-ok="' + i + '">' + esc(T("pf.ok")) + "</button>" +
          "</div>" +
        "</div>" +
        '<button type="button" class="icon-btn icon-btn--danger pf-item__remove" data-remove="' + i + '" aria-label="' + esc(T("pf.removeItem")) + '" title="' + esc(T("pf.removeItem")) + '">' + ICON_TRASH + "</button>" +
        "</div>";
    }).join("");
    recalc();
  }

  function recalc() {
    var cur = currency();
    var sale = 0, cost = 0, saleWithCost = 0, noCost = 0;
    $("#pf-items").querySelectorAll("[data-row]").forEach(function (el) {
      var row = rows[Number(el.dataset.row)];
      var qty = row.qty || 0;
      var lineSale = (row.price || 0) * qty;
      var lineCost = row.cost == null ? null : row.cost * qty;
      sale += lineSale;
      if (lineCost == null) noCost += 1;
      else { cost += lineCost; saleWithCost += lineSale; }
      el.querySelector('[data-out="total"]').textContent = A.money(lineSale, cur);
      var m = margin(row.price, row.cost);
      var mEl = el.querySelector('[data-out="margin"]');
      mEl.textContent = pct(m);
      mEl.className = m == null ? "" : m < 0 ? "is-neg" : m < 0.1 ? "is-low" : "is-ok";
      el.querySelector('[data-out="profit"]').textContent = lineCost == null || row.price == null ? "—" : A.money(lineSale - lineCost, cur);
    });
    // Profit and margin only over items with a known cost.
    var known = rows.length > noCost;
    var profit = saleWithCost - cost;
    var m = known ? margin(saleWithCost, cost) : null;
    $("#pf-totals").innerHTML =
      "<div><span>" + esc(T("pf.totSale")) + "</span><b>" + esc(A.money(sale, cur)) + "</b></div>" +
      '<div class="internal"><span>' + esc(T("pf.totCost")) + "</span><b>" + esc(A.money(cost, cur)) + "</b></div>" +
      '<div class="internal pf-totals__profit"><span>' + esc(T("pf.totProfit")) + "</span><b class=\"" + (profit < 0 ? "is-neg" : "is-ok") + '">' + (known ? esc(A.money(profit, cur)) : "—") + "</b></div>" +
      '<div class="internal"><span>' + esc(T("pf.totMargin")) + "</span><b>" + esc(pct(m)) + "</b></div>" +
      (noCost ? '<p class="pf-nocost internal">' + esc(T("pf.noCost", { n: noCost })) + "</p>" : "");
  }

  function newRow() {
    return { productId: "", supplierId: "", options: {}, qty: 1, cost: null, price: null, priceAuto: true, editing: true };
  }

  // When the product, supplier or options change, fill cost and price automatically.
  // Purchase price of a link for the row's configuration: the variant price
  // when the supplier has one for it, otherwise the supplier's default price.
  function linkCost(product, link, row) {
    if (!link) return null;
    var current = {};
    ((product && product.attributes) || []).forEach(function (a) { a.options.forEach(function (o) { current[o.id] = true; }); });
    var ids = Object.keys(row.options).map(function (k) { return row.options[k]; }).filter(function (id) { return id && current[id]; });
    var key = ids.slice().sort().join(",");
    var v = link.variantCosts && link.variantCosts[key];
    return v != null ? v : link.cost;
  }

  function applyDefaults(row, changed) {
    var product = productById(row.productId);
    var links = (product && product.supplierLinks) || [];
    if (changed === "productId") {
      row.options = {};
      row.supplierId = links.length ? links[0].supplierId : "";
      row.costAuto = true;
      row.priceAuto = true;
      row.price = null;
    }
    if (changed === "supplierId") row.costAuto = true;
    // Product, supplier or options changed: take the price of that configuration
    // (unless the cost was typed by hand).
    if (row.costAuto !== false) {
      var link = links.filter(function (l) { return l.supplierId === row.supplierId; })[0];
      row.cost = linkCost(product, link, row);
    }
    if (row.priceAuto) {
      var memo = rememberedPrice(row);
      if (memo) row.price = memo.price;
    }
  }

  $("#pf-items").addEventListener("change", function (e) {
    var el = e.target.closest(".pf-item");
    if (!el) return;
    var row = rows[Number(el.dataset.row)];
    var f = e.target.getAttribute("data-f");
    var attr = e.target.getAttribute("data-attr");
    row.error = null;
    if (f === "productId" || f === "supplierId") {
      row[f] = e.target.value;
      applyDefaults(row, f);
      renderItems();
    } else if (attr) {
      row.options[attr] = e.target.value;
      applyDefaults(row, "option");
      renderItems();
    }
  });

  $("#pf-items").addEventListener("input", function (e) {
    var el = e.target.closest(".pf-item");
    var f = e.target.getAttribute("data-f");
    if (!el || ["qty", "cost", "price"].indexOf(f) < 0) return;
    var row = rows[Number(el.dataset.row)];
    row[f] = toNum(e.target.value);
    if (f === "price") row.priceAuto = false; // typed by hand: keep it
    if (f === "cost") row.costAuto = false;
    recalc();
  });

  $("#pf-items").addEventListener("click", function (e) {
    var ok = e.target.closest("[data-ok]");
    var edit = e.target.closest("[data-edit]");
    var remove = e.target.closest("[data-remove]");
    if (ok) {
      var i = Number(ok.dataset.ok);
      var problem = rowProblem(rows[i], i, duplicateRows());
      rows[i].error = problem || null;
      if (!problem) rows[i].editing = false;
      renderItems();
    } else if (edit) {
      rows[Number(edit.dataset.edit)].editing = true;
      renderItems();
    } else if (remove) {
      rows.splice(Number(remove.dataset.remove), 1);
      renderItems();
    }
  });

  /* ---------- Reorder: press and hold an item, then drag it ---------- */
  var drag = null;

  function beginDrag(el, y) {
    var rect = el.getBoundingClientRect();
    var placeholder = document.createElement("div");
    placeholder.className = "pf-placeholder";
    placeholder.style.height = rect.height + "px";
    el.parentNode.insertBefore(placeholder, el.nextSibling);
    el.classList.add("is-dragging");
    el.style.width = rect.width + "px";
    el.style.left = rect.left + "px";
    el.style.top = rect.top + "px";
    drag = { el: el, from: Number(el.dataset.row), startY: y, top: rect.top, placeholder: placeholder, lastY: y };
    document.body.classList.add("is-sorting");
    if (navigator.vibrate) navigator.vibrate(15);
  }

  function moveDrag(y) {
    drag.lastY = y;
    drag.el.style.top = drag.top + (y - drag.startY) + "px";
    var list = $("#pf-items");
    var others = Array.prototype.filter.call(list.children, function (c) { return c !== drag.el && c !== drag.placeholder; });
    var before = null;
    for (var k = 0; k < others.length; k++) {
      var r = others[k].getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = others[k]; break; }
    }
    if (before) list.insertBefore(drag.placeholder, before);
    else list.appendChild(drag.placeholder);
    // Scroll the page when dragging near the top or bottom edge.
    if (y < 140) window.scrollBy(0, -12);
    else if (y > window.innerHeight - 60) window.scrollBy(0, 12);
  }

  function endDrag() {
    var list = $("#pf-items");
    var to = Array.prototype.filter.call(list.children, function (c) { return c !== drag.el; }).indexOf(drag.placeholder);
    var moved = rows.splice(drag.from, 1)[0];
    rows.splice(to, 0, moved);
    drag = null;
    document.body.classList.remove("is-sorting");
    renderItems();
  }

  $("#pf-items").addEventListener("pointerdown", function (e) {
    var el = e.target.closest(".pf-row.is-sortable");
    if (!el || drag || e.button > 0 || e.target.closest("button, a, input, select")) return;
    var start = { x: e.clientX, y: e.clientY };
    var touch = e.pointerType !== "mouse";
    // Touch: hold still briefly (so a quick swipe still scrolls). Mouse: hold or start moving.
    var timer = setTimeout(function () { beginDrag(el, start.y); }, touch ? 280 : 180);
    function onMove(ev) {
      if (drag) { ev.preventDefault(); moveDrag(ev.clientY); return; }
      var dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
      if (!touch && dist > 5) { clearTimeout(timer); beginDrag(el, start.y); moveDrag(ev.clientY); }
      else if (touch && dist > 8) stop(); // it was a scroll, not a long press
    }
    function onUp() { stop(); }
    function stop() {
      clearTimeout(timer);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (drag) endDrag();
    }
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
  // While dragging on a touch screen, the finger moves the item, not the page.
  document.addEventListener("touchmove", function (e) { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener("contextmenu", function (e) { if (drag || e.target.closest(".pf-row.is-sortable")) e.preventDefault(); });

  $("#pf-add-item").addEventListener("click", function () {
    rows.push(newRow());
    renderItems();
    var last = $("#pf-items").querySelector("[data-row]:last-child select");
    if (last) last.focus();
  });

  form.elements.clientId.addEventListener("change", function () {
    loadClientPrices(form.elements.clientId.value).then(function () {
      rows.forEach(function (row) { if (row.priceAuto) { var m = rememberedPrice(row); row.price = m ? m.price : row.price; } });
      renderItems();
    });
  });
  form.elements.currency.addEventListener("change", function () { renderItems(); });

  /* ---------- Save / close / reopen / delete ---------- */
  function body() {
    return {
      clientId: form.elements.clientId.value,
      date: form.elements.date.value,
      validUntil: form.elements.validUntil.value,
      currency: form.elements.currency.value,
      language: form.elements.language.value,
      terms: form.elements.terms.value,
      items: rows.filter(function (r) { return r.productId; }).map(function (r) {
        return { id: r.id, productId: r.productId, supplierId: r.supplierId, options: r.options, qty: r.qty, cost: r.cost, price: r.price };
      })
    };
  }

  function accept(p) {
    editing = p;
    var idx = proformas.findIndex(function (x) { return x.id === p.id; });
    if (idx > -1) proformas[idx] = p; else proformas.unshift(p);
    // Keep typed values but take the ids the server gave to new items.
    var saved = rows.filter(function (r) { return r.productId; });
    saved.forEach(function (r, i) { if (p.items[i]) r.id = p.items[i].id; });
    rows = saved;
    renderList();
    renderHeader();
    renderItems();
  }

  function save() {
    if (isClosed()) return Promise.resolve(editing);
    var dupMsg = duplicateMessage(duplicateRows());
    if (dupMsg) return Promise.reject(new Error(dupMsg));
    // Complete rows still open for editing are confirmed automatically on save.
    var dups = duplicateRows();
    rows.forEach(function (r, i) { if (r.editing && r.productId && !rowProblem(r, i, dups)) r.editing = false; });
    return A.api(editing ? "/api/proformas?id=" + encodeURIComponent(editing.id) : "/api/proformas",
      { method: editing ? "PUT" : "POST", body: body() }).then(function (data) {
      accept(data.proforma);
      return data.proforma;
    });
  }

  function busy(btn, on) { btn.disabled = on; }

  $("#pf-save").addEventListener("click", function () {
    var btn = $("#pf-save");
    busy(btn, true);
    save().then(function () { setStatus(T("pf.saved"), "ok"); }, function (e) { setStatus(e.message, "error"); })
      .then(function () { busy(btn, false); });
  });

  function problemText(code) {
    var parts = code.split(":");
    return T("pf.problem." + parts[0], { n: parts[1], of: parts[2] });
  }

  $("#pf-close").addEventListener("click", function () {
    var btn = $("#pf-close");
    if (!confirm(T("pf.confirmClose"))) return;
    busy(btn, true);
    save().then(function (p) {
      return fetch("/api/proformas?id=" + encodeURIComponent(p.id) + "&action=close", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "same-origin"
      }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); });
    }).then(function (r) {
      if (!r.ok) {
        var list = (r.data.problems || []).map(problemText);
        setStatus(list.length ? list.join(" ") : r.data.error, "error");
        return;
      }
      accept(r.data.proforma);
      setStatus(T("pf.closedOk"), "ok");
    }, function (e) { setStatus(e.message, "error"); }).then(function () { busy(btn, false); });
  });

  $("#pf-reopen").addEventListener("click", function () {
    A.api("/api/proformas?id=" + encodeURIComponent(editing.id) + "&action=reopen", { method: "POST", body: {} })
      .then(function (data) { accept(data.proforma); setStatus(T("pf.reopened"), "ok"); }, function (e) { setStatus(e.message, "error"); });
  });

  $("#pf-delete").addEventListener("click", function () {
    if (!editing || !confirm(T("pf.confirmDelete", { number: editing.number }))) return;
    A.api("/api/proformas?id=" + encodeURIComponent(editing.id), { method: "DELETE" }).then(function () {
      proformas = proformas.filter(function (x) { return x.id !== editing.id; });
      editing = null;
      renderList();
      showEditor(false);
    }, function (e) { setStatus(e.message, "error"); });
  });

  $("#pf-new").addEventListener("click", function () {
    openEditor(null);
    rows.push(newRow());
    renderItems();
  });
  $("#pf-back").addEventListener("click", function () { showEditor(false); renderList(); });

  /* ---------- Export (PDF / Excel): sale prices only ---------- */
  var DOC = {
    en: { title: "PROFORMA INVOICE", no: "No.", date: "Date", valid: "Valid until", billTo: "Bill to", taxId: "Tax ID", phone: "Phone",
      email: "E-mail", web: "Website", item: "#", code: "Code", description: "Description", qty: "Qty", unit: "Unit price", amount: "Amount",
      total: "TOTAL", bank: "Bank details", beneficiary: "Beneficiary", bankName: "Bank", account: "Account No.", swift: "SWIFT / BIC",
      bankAddress: "Bank address", terms: "Terms & notes", page: "Page", currency: "Currency" },
    pt: { title: "FATURA PROFORMA", no: "Nº", date: "Data", valid: "Válida até", billTo: "Cliente", taxId: "Tax ID", phone: "Telefone",
      email: "E-mail", web: "Site", item: "#", code: "Código", description: "Descrição", qty: "Qtd.", unit: "Preço unit.", amount: "Valor",
      total: "TOTAL", bank: "Dados bancários", beneficiary: "Beneficiário", bankName: "Banco", account: "Conta", swift: "SWIFT / BIC",
      bankAddress: "Endereço do banco", terms: "Condições e observações", page: "Página", currency: "Moeda" },
    es: { title: "FACTURA PROFORMA", no: "Nº", date: "Fecha", valid: "Válida hasta", billTo: "Cliente", taxId: "Tax ID", phone: "Teléfono",
      email: "Correo", web: "Sitio web", item: "#", code: "Código", description: "Descripción", qty: "Cant.", unit: "Precio unit.", amount: "Importe",
      total: "TOTAL", bank: "Datos bancarios", beneficiary: "Beneficiario", bankName: "Banco", account: "Cuenta", swift: "SWIFT / BIC",
      bankAddress: "Dirección del banco", terms: "Condiciones y observaciones", page: "Página", currency: "Moneda" }
  };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  // Draws an image (URL) into a small PNG/JPEG data URL; null if it cannot be read.
  function imageData(url, size, type) {
    return new Promise(function (resolve) {
      if (!url) return resolve(null);
      var img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = function () {
        try {
          var k = size / Math.max(img.naturalWidth || size, img.naturalHeight || size);
          var c = document.createElement("canvas");
          c.width = Math.max(1, Math.round((img.naturalWidth || size) * k));
          c.height = Math.max(1, Math.round((img.naturalHeight || size) * k));
          var ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve({ data: c.toDataURL(type || "image/jpeg", 0.85), w: c.width, h: c.height });
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }

  // Everything the documents show — nothing internal (cost, margin, supplier).
  function docData(p) {
    var lang = p.language || "en";
    var settings = A.settings();
    var cur = A.CURRENCIES[p.currency] || A.CURRENCIES.CNY;
    var products = A.products();
    var items = p.items.map(function (i, n) {
      var name = (i.product && i.product.name && (i.product.name[lang] || i.product.name.en)) || "";
      var opts = i.options.map(function (o) {
        return ((o.attrName && (o.attrName[lang] || o.attrName.en)) || "") + ": " + ((o.optionLabel && (o.optionLabel[lang] || o.optionLabel.en)) || "");
      });
      var current = products.filter(function (x) { return x.id === i.productId; })[0];
      var code = i.sku || (current ? skuOf({ productId: i.productId, options: i.options.reduce(function (m, o) { m[o.attrId] = o.optionId; return m; }, {}) }) : "");
      return { n: n + 1, code: code, name: name, options: opts, image: i.product && i.product.image, qty: i.qty, price: i.price || 0, amount: round((i.price || 0) * i.qty) };
    });
    return { lang: lang, L: DOC[lang] || DOC.en, settings: settings, cur: cur, items: items, total: p.totals.sale, p: p };
  }

  function fmt(n, d) {
    return Number(n).toLocaleString(d.lang === "en" ? "en-US" : d.lang === "pt" ? "pt-BR" : "es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function docDate(iso, d) {
    if (!iso) return "";
    return new Date(iso + "T00:00:00").toLocaleDateString(d.lang === "en" ? "en-GB" : d.lang === "pt" ? "pt-BR" : "es-ES");
  }
  function fileName(p, ext) {
    return (p.number + (p.client ? " - " + p.client.name : "")).replace(/[\\/:*?"<>|]+/g, " ").trim() + "." + ext;
  }

  function exportPdf(p) {
    return Promise.all([
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js")
    ]).then(function () {
      return loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js");
    }).then(function () {
      var d = docData(p);
      return Promise.all([imageData("assets/img/logo.svg", 240, "image/png")].concat(d.items.map(function (it) {
        return imageData(it.image, 160);
      }))).then(function (imgs) { return { d: d, logo: imgs[0], thumbs: imgs.slice(1) }; });
    }).then(function (r) {
      var d = r.d, L = d.L, s = d.settings, client = d.p.client || {};
      var doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
      var W = 210, M = 14, navy = [11, 42, 79], muted = [91, 104, 120];
      var y = M;

      // Header: logo + company (left), title + number (right)
      if (r.logo) doc.addImage(r.logo.data, "PNG", M, y, 16, 16);
      doc.setTextColor.apply(doc, navy);
      doc.setFont("helvetica", "bold"); doc.setFontSize(11);
      var nameLines = doc.splitTextToSize(s.companyName || "Shenzhen Micheng International Trading Co., Ltd.", 95);
      doc.text(nameLines, M + 20, y + 5);
      var infoY = y + 5 + nameLines.length * 4.6;
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor.apply(doc, muted);
      var info = [];
      if (s.address) info = info.concat(doc.splitTextToSize(s.address, 90));
      if (s.phone) info.push(L.phone + ": " + s.phone);
      if (s.email) info.push(L.email + ": " + s.email);
      if (s.website) info.push(L.web + ": " + s.website);
      doc.text(info, M + 20, infoY);

      doc.setTextColor.apply(doc, navy); doc.setFont("helvetica", "bold"); doc.setFontSize(17);
      doc.text(L.title, W - M, y + 6, { align: "right" });
      doc.setFontSize(9); doc.setFont("helvetica", "normal"); doc.setTextColor(30, 40, 50);
      var meta = [L.no + " " + d.p.number, L.date + ": " + docDate(d.p.date, d)];
      if (d.p.validUntil) meta.push(L.valid + ": " + docDate(d.p.validUntil, d));
      meta.push(L.currency + ": " + d.cur.label);
      doc.text(meta, W - M, y + 13, { align: "right" });
      y = Math.max(infoY + info.length * 4 + 6, y + 32);

      // Bill to
      doc.setDrawColor(220, 226, 234); doc.setFillColor(246, 248, 251);
      var billLines = [client.name || ""].concat(client.address ? doc.splitTextToSize(client.address, W - 2 * M - 10) : []);
      if (client.phone) billLines.push(L.phone + ": " + client.phone);
      if (client.taxId) billLines.push(L.taxId + ": " + client.taxId);
      var boxH = 9 + billLines.length * 4.3;
      doc.roundedRect(M, y, W - 2 * M, boxH, 1.5, 1.5, "FD");
      doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor.apply(doc, muted);
      doc.text(L.billTo.toUpperCase(), M + 4, y + 5);
      doc.setFontSize(9.5); doc.setTextColor(30, 40, 50);
      doc.text(billLines[0], M + 4, y + 10);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
      if (billLines.length > 1) doc.text(billLines.slice(1), M + 4, y + 14.3);
      y += boxH + 6;

      // Items
      var body = d.items.map(function (it) {
        return [it.n, "", it.code, it.name + (it.options.length ? "\n" + it.options.join("\n") : ""), fmt(it.qty, d).replace(/[.,]00$/, ""), fmt(it.price, d), fmt(it.amount, d)];
      });
      doc.autoTable({
        startY: y,
        margin: { left: M, right: M },
        head: [[L.item, "", L.code, L.description, L.qty, L.unit + " (" + d.cur.label + ")", L.amount + " (" + d.cur.label + ")"]],
        body: body,
        theme: "grid",
        styles: { font: "helvetica", fontSize: 8.5, cellPadding: 2, valign: "middle", lineColor: [220, 226, 234], textColor: [30, 40, 50] },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", halign: "center" },
        columnStyles: {
          0: { cellWidth: 8, halign: "center" },
          1: { cellWidth: 18, minCellHeight: 18 },
          2: { cellWidth: 18, halign: "center", fontStyle: "bold" },
          3: { cellWidth: "auto" },
          4: { cellWidth: 15, halign: "right" },
          5: { cellWidth: 25, halign: "right" },
          6: { cellWidth: 27, halign: "right" }
        },
        didParseCell: function (h) {
          if (h.section === "body" && h.column.index === 3) h.cell.styles.fontStyle = "normal";
        },
        didDrawCell: function (h) {
          if (h.section === "body" && h.column.index === 1) {
            var t = r.thumbs[h.row.index];
            if (t) doc.addImage(t.data, "JPEG", h.cell.x + 1.5, h.cell.y + (h.cell.height - 15) / 2, 15, 15);
          }
        }
      });
      y = doc.lastAutoTable.finalY;

      // Total
      doc.setFillColor.apply(doc, navy);
      doc.rect(W - M - 70, y + 3, 70, 9, "F");
      doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(10);
      doc.text(L.total, W - M - 66, y + 9);
      doc.text(d.cur.symbol + " " + fmt(d.total, d), W - M - 3, y + 9, { align: "right" });
      y += 18;

      function section(title, lines) {
        if (!lines.length) return;
        if (y + 8 + lines.length * 4.2 > 285) { doc.addPage(); y = M; }
        doc.setTextColor.apply(doc, navy); doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
        doc.text(title, M, y);
        doc.setTextColor(30, 40, 50); doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
        doc.text(lines, M, y + 5);
        y += 9 + lines.length * 4.2;
      }
      var bank = [];
      if (s.bankBeneficiary) bank.push(L.beneficiary + ": " + s.bankBeneficiary);
      if (s.bankName) bank.push(L.bankName + ": " + s.bankName);
      if (s.bankAccount) bank.push(L.account + ": " + s.bankAccount);
      if (s.bankSwift) bank.push(L.swift + ": " + s.bankSwift);
      if (s.bankAddress) bank = bank.concat(doc.splitTextToSize(L.bankAddress + ": " + s.bankAddress, W - 2 * M));
      if (s.bankNotes) bank = bank.concat(doc.splitTextToSize(s.bankNotes, W - 2 * M));
      section(L.terms, d.p.terms ? doc.splitTextToSize(d.p.terms, W - 2 * M) : []);
      section(L.bank, bank);

      // Footer on every page
      var pages = doc.getNumberOfPages();
      for (var i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFontSize(7.5); doc.setTextColor.apply(doc, muted); doc.setFont("helvetica", "normal");
        doc.text((s.companyName || "Shenzhen Micheng International Trading") + " · " + d.p.number, M, 290);
        doc.text(L.page + " " + i + "/" + pages, W - M, 290, { align: "right" });
      }
      doc.save(fileName(d.p, "pdf"));
    });
  }

  function exportXlsx(p) {
    return loadScript("https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js").then(function () {
      var d = docData(p), L = d.L, s = d.settings, client = d.p.client || {};
      var wb = new window.ExcelJS.Workbook();
      wb.creator = s.companyName || "Micheng";
      var ws = wb.addWorksheet(d.p.number, { pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      ws.columns = [{ width: 6 }, { width: 12 }, { width: 66 }, { width: 10 }, { width: 16 }, { width: 18 }];
      var navy = "FF0B2A4F";
      var moneyFmt = '"' + d.cur.symbol + '" #,##0.00';

      ws.mergeCells("A1:C1");
      ws.getCell("A1").value = s.companyName || "Shenzhen Micheng International Trading Co., Ltd.";
      ws.getCell("A1").font = { bold: true, size: 13, color: { argb: navy } };
      ws.mergeCells("D1:F1");
      ws.getCell("D1").value = L.title;
      ws.getCell("D1").font = { bold: true, size: 15, color: { argb: navy } };
      ws.getCell("D1").alignment = { horizontal: "right" };

      var left = [];
      if (s.address) left.push(s.address.replace(/\n/g, ", "));
      if (s.phone) left.push(L.phone + ": " + s.phone);
      if (s.email) left.push(L.email + ": " + s.email);
      if (s.website) left.push(L.web + ": " + s.website);
      var right = [L.no + " " + d.p.number, L.date + ": " + docDate(d.p.date, d)];
      if (d.p.validUntil) right.push(L.valid + ": " + docDate(d.p.validUntil, d));
      right.push(L.currency + ": " + d.cur.label);
      var rowsN = Math.max(left.length, right.length);
      for (var i = 0; i < rowsN; i++) {
        var r = ws.getRow(2 + i);
        ws.mergeCells(2 + i, 1, 2 + i, 3);
        ws.mergeCells(2 + i, 4, 2 + i, 6);
        r.getCell(1).value = left[i] || "";
        r.getCell(4).value = right[i] || "";
        r.getCell(4).alignment = { horizontal: "right" };
        r.font = { size: 9, color: { argb: "FF5B6878" } };
      }
      var y = 3 + rowsN;

      ws.getCell(y, 1).value = L.billTo.toUpperCase();
      ws.getCell(y, 1).font = { bold: true, size: 9, color: { argb: "FF5B6878" } };
      var bill = [client.name || ""];
      if (client.address) bill.push(client.address.replace(/\n/g, ", "));
      if (client.phone) bill.push(L.phone + ": " + client.phone);
      if (client.taxId) bill.push(L.taxId + ": " + client.taxId);
      bill.forEach(function (line, n) {
        ws.mergeCells(y + 1 + n, 1, y + 1 + n, 6);
        var c = ws.getCell(y + 1 + n, 1);
        c.value = line;
        c.font = n === 0 ? { bold: true, size: 11 } : { size: 10 };
      });
      y += bill.length + 2;

      var head = ws.getRow(y);
      head.values = [L.item, L.code, L.description, L.qty, L.unit + " (" + d.cur.label + ")", L.amount + " (" + d.cur.label + ")"];
      head.eachCell(function (c) {
        c.font = { bold: true, color: { argb: "FFFFFFFF" } };
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } };
        c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      });
      var first = y + 1;
      d.items.forEach(function (it, n) {
        var r = ws.getRow(first + n);
        r.getCell(1).value = it.n;
        r.getCell(2).value = it.code;
        r.getCell(3).value = it.name + (it.options.length ? "\n" + it.options.join("\n") : "");
        r.getCell(4).value = it.qty;
        r.getCell(5).value = it.price;
        r.getCell(6).value = { formula: "D" + (first + n) + "*E" + (first + n), result: it.amount };
        r.getCell(1).alignment = { horizontal: "center", vertical: "top" };
        r.getCell(2).alignment = { horizontal: "center", vertical: "top" };
        r.getCell(2).font = { bold: true };
        r.getCell(3).alignment = { wrapText: true, vertical: "top" };
        [4, 5, 6].forEach(function (k) { r.getCell(k).alignment = { vertical: "top" }; });
        r.getCell(5).numFmt = moneyFmt;
        r.getCell(6).numFmt = moneyFmt;
        r.height = Math.max(18, 15 * (1 + it.options.length));
      });
      var last = first + d.items.length - 1;
      var totalRow = last + 1;
      ws.getCell(totalRow, 5).value = L.total;
      ws.getCell(totalRow, 5).font = { bold: true, color: { argb: "FFFFFFFF" } };
      ws.getCell(totalRow, 6).value = { formula: "SUM(F" + first + ":F" + last + ")", result: d.total };
      ws.getCell(totalRow, 6).numFmt = moneyFmt;
      ws.getCell(totalRow, 6).font = { bold: true, color: { argb: "FFFFFFFF" } };
      [5, 6].forEach(function (k) {
        ws.getCell(totalRow, k).fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } };
        ws.getCell(totalRow, k).alignment = { horizontal: "right" };
      });
      for (var rr = y; rr <= last; rr++) {
        for (var cc = 1; cc <= 6; cc++) {
          ws.getCell(rr, cc).border = { top: { style: "thin", color: { argb: "FFDCE2EA" } }, bottom: { style: "thin", color: { argb: "FFDCE2EA" } },
            left: { style: "thin", color: { argb: "FFDCE2EA" } }, right: { style: "thin", color: { argb: "FFDCE2EA" } } };
        }
      }
      y = totalRow + 2;

      function section(title, lines) {
        if (!lines.length) return;
        ws.getCell(y, 1).value = title;
        ws.getCell(y, 1).font = { bold: true, color: { argb: navy } };
        lines.forEach(function (line, n) {
          ws.mergeCells(y + 1 + n, 1, y + 1 + n, 6);
          ws.getCell(y + 1 + n, 1).value = line;
        });
        y += lines.length + 2;
      }
      section(L.terms, d.p.terms ? d.p.terms.split("\n") : []);
      var bank = [];
      if (s.bankBeneficiary) bank.push(L.beneficiary + ": " + s.bankBeneficiary);
      if (s.bankName) bank.push(L.bankName + ": " + s.bankName);
      if (s.bankAccount) bank.push(L.account + ": " + s.bankAccount);
      if (s.bankSwift) bank.push(L.swift + ": " + s.bankSwift);
      if (s.bankAddress) bank.push(L.bankAddress + ": " + s.bankAddress.replace(/\n/g, ", "));
      if (s.bankNotes) bank = bank.concat(s.bankNotes.split("\n"));
      section(L.bank, bank);

      return wb.xlsx.writeBuffer().then(function (buf) {
        var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = fileName(d.p, "xlsx");
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      });
    });
  }

  // Exports the saved version (drafts are saved first).
  function runExport(kind) {
    var btn = $(kind === "pdf" ? "#pf-pdf" : "#pf-xlsx");
    btn.disabled = true;
    setStatus(T("pf.exporting"));
    save().then(function (p) {
      return kind === "pdf" ? exportPdf(p) : exportXlsx(p);
    }).then(function () { setStatus(""); }, function (e) {
      setStatus(T("pf.exportError") + " " + e.message, "error");
    }).then(function () { btn.disabled = false; });
  }
  $("#pf-pdf").addEventListener("click", function () { runExport("pdf"); });
  $("#pf-xlsx").addEventListener("click", function () { runExport("xlsx"); });

  /* ---------- Wiring ---------- */
  var loadedOnce = false;
  document.addEventListener("admin:data", function () {
    if (!loadedOnce) { loadedOnce = true; load(); } // first data after login
    fillClientSelect();
    if (!$("#pf-editor").hidden) renderItems();
  });
  document.addEventListener("admin:lang", function () {
    renderList();
    if (!$("#pf-editor").hidden) { renderHeader(); renderItems(); }
  });
  document.querySelector('.tab[data-tab="proformas"]').addEventListener("click", load);

  // Expose for tests and for loading when the panel opens.
  window.Proformas = { load: load };
  load();
})();
