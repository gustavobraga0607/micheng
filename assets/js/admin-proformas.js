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
  var conflicted = false; // a save was refused because someone else changed the proforma
  var rows = []; // items being edited
  var clientPrices = {}; // remembered sale prices of the selected client
  var form = $("#pf-form");

  /* ---------- Helpers ---------- */
  function round(n, d) { var k = Math.pow(10, d || 2); return Math.round(n * k) / k; }
  function toNum(v) { return A.parseDecimal(v); } // "15,9" and "15.9"
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
  // Items can be edited on a proforma, or on an order while "Alterar itens" is on.
  var amending = false;
  function isLocked() { return isClosed() && !amending; }

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
    var kind = $("#pf-kind").value; // "" | draft (proformas) | closed (orders)
    var shown = proformas.filter(function (p) {
      if (kind && p.status !== kind) return false;
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
  $("#pf-kind").addEventListener("change", renderList);
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

  // Editor row from a saved item.
  function rowFromItem(i) {
    var opts = {};
    i.options.forEach(function (o) { opts[o.attrId] = o.optionId; });
    return { id: i.id, productId: i.productId, sku: i.sku, snapshot: i.product, supplierId: i.supplierId || "", options: opts,
      qty: i.qty, cost: i.cost, price: i.price, priceAuto: false, editing: false,
      clientRef: i.clientRef || "", refManual: false };
  }

  function openEditor(p) {
    editing = p || null;
    decState = { id: null, values: {} };
    setStatus("");
    form.reset();
    fillClientSelect();
    form.elements.clientId.value = p ? p.clientId || "" : "";
    form.elements.date.value = p ? p.date : today();
    form.elements.validUntil.value = p ? p.validUntil || "" : today(30);
    form.elements.currency.value = p ? p.currency : A.defaultCurrency();
    form.elements.language.value = p ? p.language : (["en", "pt", "es"].indexOf(A.lang()) > -1 ? A.lang() : "en");
    form.elements.terms.value = p ? p.terms || "" : "";
    form.elements.incoterm.value = p ? p.incoterm || "" : "";
    form.elements.incotermPlace.value = p ? p.incotermPlace || "" : "";
    amending = false;
    rows = p ? p.items.map(rowFromItem) : [];
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
    $("#pf-reopen").hidden = !closed || amending;
    $("#pf-amend").hidden = !closed || amending;
    $("#pf-amend-save").hidden = $("#pf-amend-cancel").hidden = $("#pf-amend-note").hidden = !amending;
    $("#pf-pdf").disabled = $("#pf-xlsx").disabled = amending; // documents come from the saved order
    $("#pf-delete").hidden = !editing;
    $("#pf-add-item").hidden = isLocked();
    form.querySelectorAll(".pf-fields input, .pf-fields select, textarea").forEach(function (el) { el.disabled = closed; });
    renderOrder();
    renderLog();
  }

  /* ---------- Change log (end of the page) ---------- */
  function logItemText(it) {
    var lang = A.lang();
    var pick = function (o) { return (o && (o[lang] || o.en || o.pt)) || ""; };
    var opts = (it.options || []).map(pick).filter(Boolean).join(" · ");
    return (it.sku ? it.sku + " " : "") + pick(it.name) + (opts ? " (" + opts + ")" : "");
  }
  function logChangeText(c, cur) {
    if (c.type === "invoice") return T("log.invoiceNumber", { number: c.number });
    var name = logItemText(c.item);
    var m = function (v) { return v == null ? "—" : A.money(v, cur); };
    if (c.type === "added") return T("log.added", { item: name, qty: c.qty, price: m(c.price) });
    if (c.type === "removed") return T("log.removed", { item: name, qty: c.qty, price: m(c.price) });
    if (c.type === "qty") return T("log.qty", { item: name, from: c.from, to: c.to });
    if (c.type === "price") return T("log.price", { item: name, from: m(c.from), to: m(c.to) });
    if (c.type === "discount") return T("log.discount", { item: name, from: m(c.from), to: m(c.to) });
    return "";
  }
  function renderLog() {
    var log = (editing && editing.log) || [];
    $("#pf-log").hidden = !log.length;
    if (!log.length) return;
    $("#pf-log-list").innerHTML = log.slice().reverse().map(function (e) {
      var when = new Date(e.at).toLocaleString(A.locale(), { dateStyle: "short", timeStyle: "short" });
      var lines = (e.changes || []).map(function (c) { return '<li class="pf-log__change pf-log__change--' + esc(c.type) + '">' + esc(logChangeText(c, editing.currency)) + "</li>"; }).join("");
      return '<li class="pf-log__entry"><div class="pf-log__meta"><b>' + esc(T("log.kind." + e.kind)) + "</b><span>" + esc(when) + (e.by ? " · " + esc(e.by) : "") + "</span></div>" +
        (lines ? "<ul>" + lines + "</ul>" : "") + "</li>";
    }).join("");
  }

  /* ---------- Amending the items of a closed order ---------- */
  function setAmending(on) {
    amending = on;
    if (!on) {
      // Back to the saved items (Cancel) or to what the server returned (Save).
      rows = editing.items.map(rowFromItem);
    }
    renderHeader();
    renderItems();
  }
  $("#pf-amend").addEventListener("click", function () { setStatus(""); setAmending(true); });
  $("#pf-amend-cancel").addEventListener("click", function () { setStatus(""); setAmending(false); });
  $("#pf-amend-save").addEventListener("click", function () {
    var btn = this;
    var dupMsg = duplicateMessage(duplicateRows());
    if (dupMsg) return setStatus(dupMsg, "error");
    var dups = duplicateRows();
    var bad = null;
    rows.forEach(function (r, i) {
      if (!r.productId) return;
      var problem = rowProblem(r, i, dups);
      if (problem && !bad) bad = problem;
      if (!problem) r.editing = false;
    });
    if (bad) { renderItems(); return setStatus(bad, "error"); }
    if (!rows.some(function (r) { return r.productId; })) return setStatus(T("pf.problem.items"), "error");
    btn.disabled = true;
    A.api("/api/proformas?id=" + encodeURIComponent(editing.id) + "&action=amend", { method: "POST", body: { items: body().items, baseUpdatedAt: editing.updatedAt } })
      .then(function (data) {
        var changed = data.proforma.updatedAt !== editing.updatedAt;
        accept(data.proforma);
        setAmending(false);
        setStatus(T(changed ? "amend.saved" : "amend.nothing"), "ok");
      }, function (e) {
        if (e.message === T("status.conflict")) conflicted = true;
        setStatus(e.message, "error");
      })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Order (closed proforma): income and expenses ----------
     The entries are ordinary finance entries linked to the order, so they also
     show in the Finance tab and, once paid, in the bank statement. */
  function orderEntries() {
    if (!editing || !window.Finance) return [];
    return window.Finance.entries().filter(function (e) { return e.proformaId === editing.id; })
      .sort(function (a, b) { return a.dueDate.localeCompare(b.dueDate); });
  }
  // Sums by currency, as text: "¥ 1.000,00" or "¥ 1.000,00 + US$ 50,00".
  function sumText(list) {
    var by = {};
    list.forEach(function (e) { by[e.currency] = round((by[e.currency] || 0) + e.amount); });
    var keys = Object.keys(by);
    return keys.length ? keys.map(function (c) { return A.money(by[c], c); }).join(" + ") : A.money(0, editing.currency);
  }
  function sumIn(list, cur) {
    return round(list.filter(function (e) { return e.currency === cur; }).reduce(function (t, e) { return t + e.amount; }, 0));
  }

  function renderOrder() {
    var box = $("#pf-order");
    box.hidden = !isClosed();
    if (box.hidden) return;
    var F = window.Finance;
    var list = orderEntries();
    var ins = list.filter(function (e) { return e.type === "in"; });
    var outs = list.filter(function (e) { return e.type === "out"; });
    var cur = editing.currency;
    var total = editing.totals.sale;
    var launched = sumIn(ins, cur);
    var received = sumIn(ins.filter(function (e) { return e.status === "paid"; }), cur);
    var missing = round(total - launched);
    var sameCurrency = list.every(function (e) { return e.currency === cur; });
    var result = round(launched - sumIn(outs, cur));
    var rows = list.map(function (e) {
      var st = F.stateOf(e);
      var badge = st === "paid" ? '<span class="badge badge--closed">' + esc(T(e.type === "in" ? "fin.received" : "fin.paid")) + "</span> <small>" + esc(fmtDate(e.paidDate)) + "</small>"
        : st === "overdue" ? '<span class="badge badge--late">' + esc(T("fin.overdue")) + "</span>"
        : '<span class="badge badge--draft">' + esc(T("fin.open")) + "</span>";
      return '<tr data-ord-entry="' + esc(e.id) + '"><td>' + esc(fmtDate(e.dueDate)) + "</td>" +
        '<td class="fin-desc"><b><span class="fin-type fin-type--' + e.type + '">' + (e.type === "in" ? "↓" : "↑") + "</span> " + esc(e.description) + "</b>" +
          "<small>" + esc([e.party && e.party.name, e.category, e.document].filter(Boolean).join(" · ")) + "</small></td>" +
        '<td class="num"><b class="' + (e.type === "in" ? "is-ok" : "is-neg") + '">' + esc((e.type === "in" ? "+ " : "− ") + A.money(e.amount, e.currency)) + "</b></td>" +
        "<td>" + badge + "</td>" +
        '<td class="num">' + (e.status === "paid" ? "" : '<button type="button" class="btn btn--outline btn--sm" data-ord-pay="' + esc(e.id) + '">' + esc(T(e.type === "in" ? "fin.receive" : "fin.pay")) + "</button>") + "</td></tr>";
    }).join("");
    box.innerHTML =
      '<div class="ord__head"><div><h3>' + esc(T("ord.title")) + '</h3><p>' + esc(T("ord.hint")) + "</p></div>" +
        '<div class="ord__actions"><button type="button" class="btn btn--outline fin-btn-out" data-ord-new="out">' + esc(T("ord.addOut")) + "</button>" +
        '<button type="button" class="btn btn--primary" data-ord-new="in">' + esc(T("ord.addIn")) + "</button></div></div>" +
      '<div class="ord__nums">' +
        "<div><span>" + esc(T("ord.total")) + "</span><b>" + esc(A.money(total, cur)) + "</b></div>" +
        '<div><span>' + esc(T("ord.launched")) + '</span><b class="is-ok">' + esc(sumText(ins)) + "</b>" +
          (missing > 0.004 ? '<small class="is-low">' + esc(T("ord.toLaunch", { value: A.money(missing, cur) })) + "</small>" : "") + "</div>" +
        "<div><span>" + esc(T("ord.received")) + "</span><b>" + esc(A.money(received, cur)) + "</b>" +
          (launched - received > 0.004 ? "<small>" + esc(T("ord.toReceive", { value: A.money(round(launched - received), cur) })) + "</small>" : "") + "</div>" +
        '<div><span>' + esc(T("ord.expenses")) + '</span><b class="is-neg">' + esc(sumText(outs)) + "</b></div>" +
        "<div><span>" + esc(T("ord.result")) + "</span>" + (sameCurrency
          ? '<b class="' + (result < 0 ? "is-neg" : "is-ok") + '">' + esc((result < 0 ? "− " : "") + A.money(Math.abs(result), cur)) + "</b>"
          : "<b>—</b><small>" + esc(T("ord.mixedCurrencies")) + "</small>") + "</div>" +
      "</div>" + invoiceBar(received, total, cur) +
      (list.length
        ? '<div class="pf-table-wrap"><table class="pf-table fin-table"><tbody>' + rows + "</tbody></table></div>"
        : '<p class="ord__empty">' + esc(T("ord.empty")) + "</p>") +
      declaredSection();
    recalcDeclared();
  }

  /* ----- Declared value per item (internal control) -----
     What the client declares on their own invoice. Kept per client and loaded
     into their next orders. It never changes the proforma or its documents. */
  var decState = { id: null, values: {} }; // typed values of the open order: { itemId: text }

  function decValues() {
    if (decState.id !== editing.id) {
      decState = { id: editing.id, values: {} };
      editing.items.forEach(function (i) { decState.values[i.id] = i.declared == null ? "" : String(i.declared).replace(".", ","); });
    }
    return decState.values;
  }
  function itemText(i) {
    var lang = A.lang();
    var opts = i.options.map(function (o) { return (o.optionLabel && (o.optionLabel[lang] || o.optionLabel.en)) || ""; }).filter(Boolean).join(" · ");
    return { name: pname(i.product), opts: opts };
  }

  function declaredSection() {
    var values = decValues();
    var cur = editing.currency;
    var rows = editing.items.map(function (i, n) {
      var t = itemText(i);
      return '<tr data-dec-row="' + esc(i.id) + '"><td>' + (n + 1) + "</td>" +
        '<td class="fin-desc"><b>' + (i.sku ? '<span class="sku">' + esc(i.sku) + "</span> " : "") + esc(t.name) + "</b>" + (t.opts ? "<small>" + esc(t.opts) + "</small>" : "") + "</td>" +
        '<td class="num">' + esc(String(i.qty)) + "</td>" +
        '<td class="num">' + esc(A.money(i.price, cur)) + "</td>" +
        '<td class="num"><input type="text" inputmode="decimal" autocomplete="off" class="dec-input" data-dec="' + esc(i.id) + '" value="' + esc(values[i.id] || "") + '" placeholder="—" /></td>' +
        '<td class="num">' + esc(A.money(round((i.price || 0) * i.qty), cur)) + "</td>" +
        '<td class="num" data-dec-total></td><td class="num" data-dec-diff></td></tr>';
    }).join("");
    return '<div class="dec">' +
      '<div class="ord__head"><div><h3>' + esc(T("dec.title")) + ' <span class="lock">' + esc(T("dec.internal")) + "</span></h3><p>" + esc(T("dec.hint")) + "</p></div>" +
        '<div class="ord__actions"><button type="button" class="btn btn--primary" id="dec-save">' + esc(T("dec.save")) + "</button></div></div>" +
      '<div class="pf-table-wrap"><table class="pf-table dec-table"><thead><tr><th>#</th><th>' + esc(T("dec.item")) + '</th><th class="num">' + esc(T("pf.qty")) +
        '</th><th class="num">' + esc(T("dec.sale")) + '</th><th class="num">' + esc(T("dec.declared")) + '</th><th class="num">' + esc(T("dec.totalSale")) +
        '</th><th class="num">' + esc(T("dec.totalDeclared")) + '</th><th class="num">' + esc(T("dec.diff")) + "</th></tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
        '<tfoot><tr><td colspan="5">' + esc(T("dec.totals")) + '</td><td class="num">' + esc(A.money(editing.totals.sale, cur)) + '</td><td class="num" id="dec-sum"></td><td class="num" id="dec-sum-diff"></td></tr></tfoot>' +
      "</table></div></div>";
  }

  // Totals of the declared column, from what is typed (no re-render, so typing keeps the focus).
  function declaredRows() {
    var values = decValues();
    return editing.items.map(function (i) {
      var text = String(values[i.id] == null ? "" : values[i.id]).trim();
      var v = text ? toNum(text) : null;
      return { item: i, text: text, value: v, invalid: Boolean(text) && v == null,
        sale: round((i.price || 0) * i.qty), declared: v == null ? null : round(v * i.qty) };
    });
  }
  function recalcDeclared() {
    if (!isClosed() || !$("#pf-order .dec")) return;
    var cur = editing.currency;
    var sum = 0, sale = 0, any = false;
    declaredRows().forEach(function (r) {
      var tr = $('#pf-order [data-dec-row="' + r.item.id + '"]');
      if (!tr) return;
      tr.querySelector(".dec-input").classList.toggle("is-invalid", r.invalid);
      tr.querySelector("[data-dec-total]").textContent = r.declared == null ? "—" : A.money(r.declared, cur);
      var diff = r.declared == null ? null : round(r.declared - r.sale);
      tr.querySelector("[data-dec-diff]").textContent = diff == null ? "—" : (diff < 0 ? "− " : diff > 0 ? "+ " : "") + A.money(Math.abs(diff), cur);
      if (r.declared != null) { sum += r.declared; sale += r.sale; any = true; }
    });
    $("#dec-sum").textContent = any ? A.money(round(sum), cur) : "—";
    var d = round(sum - sale);
    $("#dec-sum-diff").textContent = any ? (d < 0 ? "− " : d > 0 ? "+ " : "") + A.money(Math.abs(d), cur) : "—";
  }

  function saveDeclared() {
    var bad = declaredRows().filter(function (r) { return r.invalid; })[0];
    if (bad) return Promise.reject(new Error(T("dec.bad", { n: editing.items.indexOf(bad.item) + 1 })));
    return A.api("/api/proformas?id=" + encodeURIComponent(editing.id) + "&action=declared", { method: "POST", body: { items: decValues() } }).then(function (data) {
      decState = { id: null, values: {} };
      accept(data.proforma);
      return data.proforma;
    });
  }

  $("#pf-order").addEventListener("input", function (e) {
    var id = e.target.getAttribute("data-dec");
    if (!id) return;
    decValues()[id] = e.target.value;
    recalcDeclared();
  });
  $("#pf-order").addEventListener("click", function (e) {
    if (e.target.closest("#dec-save")) {
      saveDeclared().then(function () { setStatus(T("dec.saved"), "ok"); }, function (err) { setStatus(err.message, "error"); });
    }
  });

  /* ----- Commercial invoice (once the order is fully paid) ----- */
  function invoiceBar(received, total, cur) {
    var inv = editing.invoice;
    var paid = received + 0.005 >= total;
    var info = inv
      ? T("inv.done", { number: inv.number, date: fmtDate(inv.date) })
      : paid ? T("inv.ready") : T("inv.waiting", { value: A.money(round(total - received), cur) });
    var buttons = inv
      ? '<button type="button" class="btn btn--outline btn--sm" data-inv="edit">' + esc(T("inv.edit")) + "</button>" +
        '<button type="button" class="btn btn--primary btn--sm" data-inv="pdf">' + esc(T("inv.download")) + "</button>"
      : '<button type="button" class="btn btn--primary btn--sm" data-inv="edit"' + (paid ? "" : " disabled") + ">" + esc(T("inv.create")) + "</button>";
    return '<div class="inv-bar' + (paid ? " is-ready" : "") + '"><div><b>' + esc(T("inv.title")) + "</b><span>" + esc(info) + "</span></div>" +
      '<div class="inv-bar__actions">' + buttons + "</div></div>";
  }

  var inf = $("#inv-form");
  var INV_FIELDS = ["number", "date", "transport", "incoterm", "incotermPlace", "portLoading", "portDischarge", "originCountry", "acquisitionCountry",
    "provenanceCountry", "paymentTerms", "buyer", "packagesQty", "packagesKind", "volumeM3", "grossWeight", "netWeight", "marks",
    "freight", "insurance", "otherCosts", "otherCostsLabel", "notes"];
  var INV_NUMERIC = ["volumeM3", "grossWeight", "netWeight", "freight", "insurance", "otherCosts"];

  function openInvoice() {
    var inv = editing.invoice || {};
    var lang = editing.language || "en";
    var china = { en: "China", pt: "China", es: "China" }[lang] || "China";
    var defaults = {
      number: "INV-" + editing.number.replace(/^PF-/, ""), date: today(), transport: "sea", incoterm: "FOB", incotermPlace: "Shenzhen",
      portLoading: "Shenzhen, China", portDischarge: "", originCountry: china, acquisitionCountry: china, provenanceCountry: china,
      paymentTerms: editing.terms || "", buyer: "", packagesQty: "", packagesKind: "", volumeM3: "", grossWeight: "", netWeight: "", marks: "",
      freight: "", insurance: "", otherCosts: "", otherCostsLabel: "", notes: ""
    };
    INV_FIELDS.forEach(function (f) {
      var v = inv[f] != null && inv[f] !== "" ? inv[f] : defaults[f];
      inf.elements[f].value = INV_NUMERIC.indexOf(f) > -1 && v !== "" ? String(v).replace(".", ",") : v;
      inf.elements[f].classList.remove("is-invalid");
    });
    // The Incoterm is part of the order; only orders closed before it existed type it here.
    var fixed = Boolean(editing.incoterm);
    $("#inv-incoterm-fields").hidden = fixed;
    $("#inv-incoterm-fixed").hidden = !fixed;
    $("#inv-incoterm-fixed").textContent = fixed ? T("inv.incotermFromOrder", { value: editing.incoterm + " " + (editing.incotermPlace || "") }) : "";
    if (fixed) { inf.elements.incoterm.value = editing.incoterm; inf.elements.incotermPlace.value = editing.incotermPlace || ""; }
    var items = inv.items || {};
    $("#inv-items").innerHTML = editing.items.map(function (i, n) {
      var it = items[i.id] || {};
      var opts = i.options.map(function (o) { return (o.optionLabel && (o.optionLabel[A.lang()] || o.optionLabel.en)) || ""; }).filter(Boolean).join(" · ");
      return "<tr><td>" + (n + 1) + '</td><td class="fin-desc"><b>' + (i.sku ? '<span class="sku">' + esc(i.sku) + "</span> " : "") + esc(pname(i.product)) + "</b>" +
        (opts ? "<small>" + esc(opts) + "</small>" : "") + '</td><td class="num">' + esc(String(i.qty)) + "</td>" +
        '<td><label class="inv-mini"><span>' + esc(T("inv.unit")) + '</span><input type="text" maxlength="20" data-inv-unit="' + esc(i.id) + '" value="' + esc(it.unit || "PCS") + '" /></label></td></tr>';
    }).join("");
    $("#inv-stamp-warn").hidden = Boolean(A.settings().stamp);
    $("#inv-stamp-warn").textContent = T("inv.noStamp");
    setInvStatus("");
    var dlg = $("#inv-dlg");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }
  function setInvStatus(msg, kind) {
    var el = $("#inv-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }
  $("#inv-dlg").addEventListener("click", function (e) {
    if (e.target === this || e.target.closest("[data-close]")) this.close();
  });

  inf.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = {};
    INV_FIELDS.forEach(function (f) { body[f] = inf.elements[f].value; });
    body.items = {};
    editing.items.forEach(function (i) {
      body.items[i.id] = { unit: $('[data-inv-unit="' + i.id + '"]').value };
    });
    var required = ["number", "date", "incotermPlace", "portLoading", "portDischarge", "originCountry", "acquisitionCountry", "provenanceCountry",
      "paymentTerms", "packagesQty", "packagesKind", "volumeM3", "grossWeight", "netWeight"];
    var missing = required.filter(function (f) {
      var v = String(body[f] || "").trim();
      if (!v) return true;
      if (f === "packagesQty") return !/^\d+$/.test(v) || Number(v) < 1;
      if (INV_NUMERIC.indexOf(f) > -1) return !(toNum(v) > 0);
      return false;
    });
    INV_FIELDS.forEach(function (f) { inf.elements[f].classList.toggle("is-invalid", missing.indexOf(f) > -1); });
    if (missing.length) return setInvStatus(T("inv.missing"), "error");
    if (toNum(body.netWeight) > toNum(body.grossWeight)) {
      inf.elements.netWeight.classList.add("is-invalid");
      return setInvStatus(T("inv.netOverGross"), "error");
    }
    var btn = $("#inv-save");
    btn.disabled = true;
    setInvStatus(T("pf.exporting"));
    A.api("/api/proformas?id=" + encodeURIComponent(editing.id) + "&action=invoice", { method: "POST", body: body })
      .then(function (data) {
        accept(data.proforma);
        return exportInvoice(data.proforma).then(function () {
          $("#inv-dlg").close();
          setStatus(T("inv.generated", { number: data.proforma.invoice.number }), "ok");
        });
      })
      .catch(function (err) {
        setInvStatus(/Not fully paid/.test(err.message) ? T("inv.notPaid") : /Invoice data missing/.test(err.message) ? T("inv.missing") : err.message, "error");
      })
      .then(function () { btn.disabled = false; });
  });

  // Commercial invoice PDF, with the information the Brazilian customs (RFB) ask
  // for (Regulamento Aduaneiro, art. 557) and the company's stamp and signature.
  var INV_DOC = {
    en: { title: "COMMERCIAL INVOICE", no: "Invoice No.", date: "Date", order: "Order", currency: "Currency", exporter: "Exporter / Seller", importer: "Importer / Consignee",
      buyer: "Buyer / Acquirer", taxId: "Tax ID", phone: "Phone", email: "E-mail", shipping: "Shipping", incoterm: "Incoterm", transport: "Mode of transport",
      portLoading: "Port of loading", portDischarge: "Port of destination", origin: "Country of origin", acquisition: "Country of acquisition", provenance: "Country of provenance",
      payment: "Payment terms and currency", item: "#", code: "Code", description: "Description of goods", qty: "Qty", unit: "Unit",
      unitPrice: "Unit price", amount: "Amount", subtotal: "Total goods", freight: "Freight", insurance: "Insurance", other: "Other expenses", total: "TOTAL",
      packages: "Packages", packagesQty: "Number and kind of packages", marks: "Marks and numbers", gross: "Gross weight", net: "Net weight", volume: "Volume",
      notes: "Notes", declaration: "We certify that this invoice is true and correct and that the goods described above are of {origin} origin.",
      sign: "Authorized signature", page: "Page",
      tr: { sea: "Sea", air: "Air", road: "Road", rail: "Rail", multimodal: "Multimodal" } },
    pt: { title: "FATURA COMERCIAL", no: "Fatura nº", date: "Data", order: "Pedido", currency: "Moeda", exporter: "Exportador / Vendedor", importer: "Importador / Consignatário",
      buyer: "Adquirente / Encomendante", taxId: "Tax ID", phone: "Telefone", email: "E-mail", shipping: "Embarque", incoterm: "Incoterm", transport: "Via de transporte",
      portLoading: "Porto de embarque", portDischarge: "Porto de destino", origin: "País de origem", acquisition: "País de aquisição", provenance: "País de procedência",
      payment: "Condições e moeda de pagamento", item: "#", code: "Código", description: "Especificação das mercadorias", qty: "Qtd.", unit: "Unid.",
      unitPrice: "Preço unit.", amount: "Valor", subtotal: "Total das mercadorias", freight: "Frete", insurance: "Seguro", other: "Outras despesas", total: "TOTAL",
      packages: "Volumes", packagesQty: "Quantidade e espécie dos volumes", marks: "Marcas e numeração", gross: "Peso bruto", net: "Peso líquido", volume: "Cubagem",
      notes: "Observações", declaration: "Declaramos que esta fatura é verdadeira e correta e que as mercadorias acima descritas são de origem {origin}.",
      sign: "Assinatura autorizada", page: "Página",
      tr: { sea: "Marítima", air: "Aérea", road: "Rodoviária", rail: "Ferroviária", multimodal: "Multimodal" } },
    es: { title: "FACTURA COMERCIAL", no: "Factura nº", date: "Fecha", order: "Pedido", currency: "Moneda", exporter: "Exportador / Vendedor", importer: "Importador / Consignatario",
      buyer: "Adquirente / Comprador", taxId: "Tax ID", phone: "Teléfono", email: "Correo", shipping: "Embarque", incoterm: "Incoterm", transport: "Vía de transporte",
      portLoading: "Puerto de embarque", portDischarge: "Puerto de destino", origin: "País de origen", acquisition: "País de adquisición", provenance: "País de procedencia",
      payment: "Condiciones y moneda de pago", item: "#", code: "Código", description: "Descripción de las mercancías", qty: "Cant.", unit: "Unid.",
      unitPrice: "Precio unit.", amount: "Importe", subtotal: "Total mercancías", freight: "Flete", insurance: "Seguro", other: "Otros gastos", total: "TOTAL",
      packages: "Bultos", packagesQty: "Cantidad y tipo de bultos", marks: "Marcas y numeración", gross: "Peso bruto", net: "Peso neto", volume: "Cubicaje",
      notes: "Observaciones", declaration: "Certificamos que esta factura es verdadera y correcta y que las mercancías descritas son de origen {origin}.",
      sign: "Firma autorizada", page: "Página",
      tr: { sea: "Marítima", air: "Aérea", road: "Terrestre", rail: "Ferroviaria", multimodal: "Multimodal" } }
  };

  function exportInvoice(p) {
    var inv = p.invoice;
    return loadScript("assets/vendor/jspdf.umd.min.js").then(function () {
      return loadScript("assets/vendor/jspdf.plugin.autotable.min.js");
    }).then(function () {
      var d = docData(p);
      return Promise.all([imageData("assets/img/logo.svg", 240, "image/png"), A.stampDataUrl()]).then(function (imgs) {
        return { d: d, logo: imgs[0], stamp: imgs[1] };
      });
    }).then(function (r) {
      var d = r.d, lang = d.lang, L = INV_DOC[lang] || INV_DOC.en, s = d.settings, client = p.client || {};
      var doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
      var W = 210, M = 14, navy = [11, 42, 79], muted = [91, 104, 120], text = [30, 40, 50];
      var num2 = function (n) { return fmt(n, d); };
      var y = M;

      // Header: exporter (left) and invoice data (right)
      if (r.logo) doc.addImage(r.logo.data, "PNG", M, y, 15, 15);
      doc.setTextColor.apply(doc, navy); doc.setFont("helvetica", "bold"); doc.setFontSize(10.5);
      var nameLines = doc.splitTextToSize(s.companyName || "Shenzhen Micheng International Trading Co., Ltd.", 100);
      doc.text(nameLines, M + 19, y + 4.5);
      var info = [];
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.3);
      if (s.address) info = info.concat(doc.splitTextToSize(s.address, 100));
      if (s.companyTaxId) info.push(L.taxId + ": " + s.companyTaxId);
      if (s.phone) info.push(L.phone + ": " + s.phone);
      if (s.email) info.push(L.email + ": " + s.email);
      doc.setTextColor.apply(doc, muted);
      var infoY = y + 4.5 + nameLines.length * 4.4;
      doc.text(info, M + 19, infoY);
      doc.setTextColor.apply(doc, navy); doc.setFont("helvetica", "bold"); doc.setFontSize(16);
      doc.text(L.title, W - M, y + 6, { align: "right" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor.apply(doc, text);
      doc.text([L.no + " " + inv.number, L.date + ": " + docDate(inv.date, d), L.order + ": " + p.number, L.currency + ": " + d.cur.label], W - M, y + 12, { align: "right" });
      y = Math.max(infoY + info.length * 3.8 + 4, y + 30);

      // Boxes: importer | shipping
      function box(x, w, title, lines, top) {
        doc.setDrawColor(220, 226, 234); doc.setFillColor(246, 248, 251);
        var h = 8 + lines.length * 4;
        doc.roundedRect(x, top, w, h, 1.2, 1.2, "FD");
        doc.setFont("helvetica", "bold"); doc.setFontSize(7.5); doc.setTextColor.apply(doc, muted);
        doc.text(title.toUpperCase(), x + 3, top + 4.5);
        doc.setFont("helvetica", "normal"); doc.setFontSize(8.6); doc.setTextColor.apply(doc, text);
        doc.text(lines, x + 3, top + 9);
        return h;
      }
      var half = (W - 2 * M - 4) / 2;
      doc.setFontSize(8.6);
      var imp = [client.name || ""].concat(client.address ? doc.splitTextToSize(client.address, half - 6) : []);
      if (client.taxId) imp.push(L.taxId + ": " + client.taxId);
      if (client.phone) imp.push(L.phone + ": " + client.phone);
      var ship = [L.incoterm + ": " + inv.incoterm + " " + inv.incotermPlace, L.transport + ": " + (L.tr[inv.transport] || inv.transport),
        L.portLoading + ": " + inv.portLoading, L.portDischarge + ": " + inv.portDischarge];
      var hA = box(M, half, L.importer, imp, y), hB = box(M + half + 4, half, L.shipping, ship, y);
      y += Math.max(hA, hB) + 3;
      if (inv.buyer) y += box(M, W - 2 * M, L.buyer, doc.splitTextToSize(inv.buyer, W - 2 * M - 6), y) + 3;

      var third = (W - 2 * M - 8) / 3;
      var hC = Math.max(box(M, third, L.origin, [inv.originCountry], y), box(M + third + 4, third, L.acquisition, [inv.acquisitionCountry], y),
        box(M + 2 * (third + 4), third, L.provenance, [inv.provenanceCountry], y));
      y += hC + 3;
      y += box(M, W - 2 * M, L.payment, doc.splitTextToSize(inv.paymentTerms + " — " + d.cur.label, W - 2 * M - 6), y) + 4;

      // Items: description in full (name, description, options)
      var items = inv.items || {};
      var body = p.items.map(function (i, n) {
        var it = d.items[n];
        var extra = items[i.id] || {};
        var desc = [it.name].concat(it.description ? [it.description] : []).concat(it.options).join("\n");
        return [n + 1, it.code || "", desc, num2(it.qty).replace(/[.,]00$/, ""), extra.unit || "PCS", num2(it.price), num2(it.amount)];
      });
      doc.autoTable({
        startY: y, margin: { left: M, right: M }, theme: "grid", rowPageBreak: "avoid",
        head: [[L.item, L.code, L.description, L.qty, L.unit, L.unitPrice + " (" + d.cur.label + ")", L.amount + " (" + d.cur.label + ")"]],
        body: body,
        styles: { font: "helvetica", fontSize: 7.8, cellPadding: 1.8, valign: "middle", lineColor: [220, 226, 234], textColor: text },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", halign: "center" },
        columnStyles: { 0: { cellWidth: 7, halign: "center" }, 1: { cellWidth: 16, halign: "center" },
          2: { cellWidth: "auto" }, 3: { cellWidth: 14, halign: "right" }, 4: { cellWidth: 13, halign: "center" }, 5: { cellWidth: 22, halign: "right" }, 6: { cellWidth: 25, halign: "right" } }
      });
      y = doc.lastAutoTable.finalY + 2;

      // Totals (goods + freight, insurance and other expenses when included)
      var lines = [[L.subtotal, p.totals.sale]];
      if (inv.freight) lines.push([L.freight, inv.freight]);
      if (inv.insurance) lines.push([L.insurance, inv.insurance]);
      if (inv.otherCosts) lines.push([L.other + (inv.otherCostsLabel ? " (" + inv.otherCostsLabel + ")" : ""), inv.otherCosts]);
      var grand = round(lines.reduce(function (t, l) { return t + l[1]; }, 0));
      if (y + 8 + lines.length * 5 > 270) { doc.addPage(); y = M; }
      doc.setFontSize(8.8); doc.setTextColor.apply(doc, text); doc.setFont("helvetica", "normal");
      lines.forEach(function (l) { doc.text(l[0], W - M - 75, y + 4); doc.text(d.cur.symbol + " " + num2(l[1]), W - M - 2, y + 4, { align: "right" }); y += 5; });
      doc.setFillColor.apply(doc, navy); doc.rect(W - M - 78, y, 78, 8, "F");
      doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(9.5);
      doc.text(L.total + " " + inv.incoterm + " " + inv.incotermPlace, W - M - 75, y + 5.4);
      doc.text(d.cur.symbol + " " + num2(grand), W - M - 2, y + 5.4, { align: "right" });
      y += 13;

      // Packages and weights
      var pk = [L.packagesQty + ": " + inv.packagesQty + " " + inv.packagesKind,
        L.gross + ": " + num2(inv.grossWeight) + " kg   ·   " + L.net + ": " + num2(inv.netWeight) + " kg   ·   " + L.volume + ": " + fmt3(inv.volumeM3, d) + " m³"];
      if (inv.marks) pk.push(L.marks + ": " + inv.marks);
      if (y + 12 + pk.length * 4 > 270) { doc.addPage(); y = M; }
      y += box(M, W - 2 * M, L.packages, pk, y) + 3;
      if (inv.notes) {
        var nl = doc.splitTextToSize(inv.notes, W - 2 * M - 6);
        if (y + 12 + nl.length * 4 > 270) { doc.addPage(); y = M; }
        y += box(M, W - 2 * M, L.notes, nl, y) + 3;
      }

      // Declaration, stamp and signature
      if (y + 48 > 285) { doc.addPage(); y = M; }
      doc.setFont("helvetica", "italic"); doc.setFontSize(8.3); doc.setTextColor.apply(doc, muted);
      doc.text(doc.splitTextToSize(L.declaration.replace("{origin}", inv.originCountry), W - 2 * M), M, y + 4);
      var sx = W - M - 70, sy = y + 10;
      if (r.stamp) {
        var props = doc.getImageProperties(r.stamp);
        var sw = 52, sh = sw * props.height / props.width;
        if (sh > 30) { sh = 30; sw = sh * props.width / props.height; }
        doc.addImage(r.stamp, props.fileType || "PNG", sx + (70 - sw) / 2, sy, sw, sh);
      }
      doc.setDrawColor(150, 160, 170); doc.line(sx, sy + 32, W - M, sy + 32);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor.apply(doc, text);
      doc.text(s.companyName || "Shenzhen Micheng International Trading Co., Ltd.", sx + 35, sy + 36.5, { align: "center", maxWidth: 70 });
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor.apply(doc, muted);
      doc.text(L.sign, sx + 35, sy + 40.5, { align: "center" });

      var pages = doc.getNumberOfPages();
      for (var k = 1; k <= pages; k++) {
        doc.setPage(k); doc.setFontSize(7.5); doc.setTextColor.apply(doc, muted); doc.setFont("helvetica", "normal");
        doc.text((s.companyName || "Shenzhen Micheng International Trading") + " · " + inv.number, M, 290);
        doc.text(L.page + " " + k + "/" + pages, W - M, 290, { align: "right" });
      }
      doc.save(PD.safeName(inv.number + (client.name ? " - " + client.name : ""), "pdf"));
    });
  }
  // Up to 3 decimals, in the document's language (1.85 in English, 1,85 in Portuguese).
  function fmt3(n, d) { return Number(n).toLocaleString(d.lang === "en" ? "en-US" : d.lang === "pt" ? "pt-BR" : "es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 3 }); }

  $("#pf-order").addEventListener("click", function (e) {
    var F = window.Finance;
    if (!F || !editing) return;
    var invBtn = e.target.closest("[data-inv]");
    if (invBtn) {
      if (invBtn.getAttribute("data-inv") === "edit") return openInvoice();
      setStatus(T("pf.exporting"));
      return exportInvoice(editing).then(function () { setStatus(""); }, function (err) { setStatus(T("pf.exportError") + " " + err.message, "error"); });
    }
    var add = e.target.closest("[data-ord-new]");
    var pay = e.target.closest("[data-ord-pay]");
    var row = e.target.closest("[data-ord-entry]");
    if (add) {
      var type = add.getAttribute("data-ord-new");
      var cur = editing.currency;
      var launched = sumIn(orderEntries().filter(function (x) { return x.type === "in"; }), cur);
      F.openEntry(type, null, {
        proformaId: editing.id,
        clientId: editing.clientId,
        currency: cur,
        description: T(type === "in" ? "ord.inDesc" : "ord.outDesc", { number: editing.number }),
        amount: type === "in" ? Math.max(0, round(editing.totals.sale - launched)) : 0, // what is still to be invoiced
        category: type === "in" ? F.categories("in")[0] : ""
      });
    } else if (pay) {
      F.openPay(pay.getAttribute("data-ord-pay"));
    } else if (row) {
      var entry = F.entries().filter(function (x) { return x.id === row.getAttribute("data-ord-entry"); })[0];
      if (entry) F.openEntry(null, entry);
    }
  });
  document.addEventListener("finance:changed", function () { if (!$("#pf-editor").hidden) renderOrder(); });

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
        (row.clientRef ? '<small class="pf-row__ref">' + esc(T("pf.clientRef")) + ": <b>" + esc(row.clientRef) + "</b></small>" : "") +
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
    var closed = isLocked();
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
          '<label class="pf-ref"><span>' + esc(T("pf.clientRef")) + '</span><input type="text" maxlength="60" autocomplete="off" data-f="clientRef" value="' +
            esc(row.clientRef || "") + '" placeholder="' + esc(T("pf.clientRefPh")) + '"' + dis + " /></label>" +
          '<div class="pf-item__nums">' +
            '<label><span>' + esc(T("pf.qty")) + '</span><input type="text" inputmode="decimal" autocomplete="off" data-f="qty" value="' + esc(row.qty == null ? "" : row.qty) + '"' + dis + " /></label>" +
            '<label class="internal"><span>' + esc(T("pf.cost")) + '</span><input type="text" inputmode="decimal" autocomplete="off" data-f="cost" value="' + esc(row.cost == null ? "" : row.cost) + '"' + dis + " /></label>" +
            '<label><span>' + esc(T("pf.price")) + '</span><input type="text" inputmode="decimal" autocomplete="off" data-f="price" value="' + esc(row.price == null ? "" : row.price) + '"' + dis + " /></label>" +
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

  // The selected client's reference for the row's configuration, from the product.
  function catalogRef(row) {
    var product = productById(row.productId);
    var map = product && product.clientRefs && product.clientRefs[form.elements.clientId.value];
    if (!map) return "";
    var current = {};
    (product.attributes || []).forEach(function (a) { a.options.forEach(function (o) { current[o.id] = true; }); });
    var key = Object.keys(row.options).map(function (k) { return row.options[k]; })
      .filter(function (id) { return id && current[id]; }).sort().join(",");
    return map[key] || map[""] || "";
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
    if (changed === "productId") row.refManual = false;
    if (!row.refManual) row.clientRef = catalogRef(row);
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
    if (el && f === "clientRef") {
      var r = rows[Number(el.dataset.row)];
      r.clientRef = e.target.value;
      r.refManual = true;
      return;
    }
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
      rows.forEach(function (row) {
        if (row.priceAuto) { var m = rememberedPrice(row); row.price = m ? m.price : row.price; }
        if (!row.refManual) row.clientRef = catalogRef(row);
      });
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
      incoterm: form.elements.incoterm.value,
      incotermPlace: form.elements.incotermPlace.value,
      baseUpdatedAt: editing ? editing.updatedAt : undefined, // refused if someone else saved it meanwhile
      items: rows.filter(function (r) { return r.productId; }).map(function (r) {
        return { id: r.id, productId: r.productId, supplierId: r.supplierId, options: r.options, qty: r.qty, cost: r.cost, price: r.price,
          clientRef: r.clientRef || "" };
      })
    };
  }

  function accept(p) {
    editing = p;
    decState = { id: null, values: {} }; // the server's copy is the truth again
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
    }, function (e) {
      if (e.message === T("status.conflict")) conflicted = true; // the reloaded data brings the other version
      throw e;
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
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); });
    }).then(function (r) {
      if (!r.ok) {
        var list = (r.data.problems || []).map(problemText);
        if (r.status === 503) list = [T("status.busy")];
        setStatus(list.length ? list.join(" ") : r.data.error, "error");
        return;
      }
      accept(r.data.proforma);
      setStatus(T("pf.closedOk"), "ok");
      A.reloadProducts(); // references typed on it are now in the product catalog
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
  var PD = window.ProformaDoc; // shared with the proforma web page (proforma-doc.js)
  var DOC = PD.DOC, loadScript = PD.loadScript, fmt = PD.fmt, docDate = PD.docDate, fileName = PD.fileName;

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

  // Web page of the proforma, where the client sees the photos in full size.
  function viewUrl(p) {
    return p.shareToken ? location.origin + "/proforma?t=" + encodeURIComponent(p.shareToken) + "&lang=" + (p.language || "en") : "";
  }
  // Creates the page's link the first time a document is exported.
  function ensureShare(p) {
    if (p.shareToken) return Promise.resolve(p);
    return A.api("/api/proformas?id=" + encodeURIComponent(p.id) + "&action=share", { method: "POST", body: {} }).then(function (data) {
      var idx = proformas.findIndex(function (x) { return x.id === p.id; });
      if (idx > -1) proformas[idx] = data.proforma;
      if (editing && editing.id === p.id) editing = data.proforma;
      return data.proforma;
    });
  }

  // Everything the documents show — nothing internal (cost, margin, supplier).
  // ref: the "reference price" version (clearly marked as such, see exportPdf).
  function docData(p, ref) {
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
      // Full description in the document's language (proformas saved before
      // descriptions were kept fall back to the product's current text).
      var texts = (i.product && i.product.description) || (current && current.description) || {};
      var description = String(texts[lang] || texts.en || "").trim();
      var code = i.sku || (current ? skuOf({ productId: i.productId, options: i.options.reduce(function (m, o) { m[o.attrId] = o.optionId; return m; }, {}) }) : "");
      // Always the product's current photo (the variant's own one when it has it).
      var image = rowImage({ options: i.options.reduce(function (m, o) { m[o.attrId] = o.optionId; return m; }, {}), snapshot: i.product }, current);
      var unit = ref ? i.declared || 0 : i.price || 0;
      return { n: n + 1, code: code, ref: i.clientRef || "", name: name, description: description, options: opts, image: image, qty: i.qty, price: unit, amount: round(unit * i.qty) };
    });
    var total = ref ? round(items.reduce(function (t, it) { return t + it.amount; }, 0)) : p.totals.sale;
    return { lang: lang, L: DOC[lang] || DOC.en, settings: settings, cur: cur, items: items, total: total, p: p, link: ref ? "" : viewUrl(p), reference: Boolean(ref) };
  }

  function exportPdf(p, ref) {
    return Promise.all([
      loadScript("assets/vendor/jspdf.umd.min.js")
    ]).then(function () {
      return loadScript("assets/vendor/jspdf.plugin.autotable.min.js");
    }).then(function () {
      var d = docData(p, ref);
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
      if (d.reference) {
        doc.setFontSize(13);
        doc.text(doc.splitTextToSize(L.refTitle, 85), W - M, y + 5, { align: "right" });
      } else doc.text(L.title, W - M, y + 6, { align: "right" });
      doc.setFontSize(9); doc.setFont("helvetica", "normal"); doc.setTextColor(30, 40, 50);
      var meta = [L.no + " " + d.p.number, L.date + ": " + docDate(d.p.date, d)];
      if (d.p.validUntil) meta.push(L.valid + ": " + docDate(d.p.validUntil, d));
      meta.push(L.currency + ": " + d.cur.label);
      if (d.p.incoterm) meta.push("Incoterm: " + d.p.incoterm + " " + (d.p.incotermPlace || ""));
      doc.text(meta, W - M, y + (d.reference ? 17 : 13), { align: "right" });
      y = Math.max(infoY + info.length * 4 + 6, y + 32);

      // Link to the web page with the photos in full size.
      if (d.link) {
        doc.setFont("helvetica", "bold"); doc.setFontSize(9.5); doc.setTextColor(26, 111, 216);
        var linkText = "\u00bb " + L.photos; // "»" exists in the PDF's built-in font
        doc.textWithLink(linkText, M, y - 1, { url: d.link });
        doc.setDrawColor(26, 111, 216); doc.setLineWidth(0.25);
        doc.line(M, y - 0.2, M + doc.getTextWidth(linkText), y - 0.2);
        doc.setLineWidth(0.2);
        y += 4;
      }

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
      // "Your ref." column only when some item has the client's reference.
      var hasRef = d.items.some(function (it) { return it.ref; });
      // The description column takes the width the other columns leave. Its
      // lines are split here, the name with the bold font, so they fit exactly.
      var descWidth = W - 2 * M - (8 + 18 + 17 + (hasRef ? 20 + 15 + 22 + 25 : 15 + 25 + 27));
      var inner = descWidth - 4; // cell padding 2 mm on each side
      doc.setFontSize(8.5);
      var descText = d.items.map(function (it) {
        doc.setFont("helvetica", "bold");
        var nameLines = doc.splitTextToSize(it.name, inner);
        doc.setFont("helvetica", "normal");
        var rest = (it.description ? doc.splitTextToSize(it.description, inner) : [])
          .concat(it.options.length ? doc.splitTextToSize(it.options.join("\n"), inner) : []);
        it.boldLines = nameLines.length;
        return nameLines.concat(rest).join("\n");
      });
      var body = d.items.map(function (it, k) {
        return [it.n, "", it.code].concat(hasRef ? [it.ref] : []).concat([descText[k], fmt(it.qty, d).replace(/[.,]00$/, ""), fmt(it.price, d), fmt(it.amount, d)]);
      });
      var desc = hasRef ? 4 : 3;
      var colStyles = { 0: { cellWidth: 8, halign: "center" }, 1: { cellWidth: 18, minCellHeight: 18 }, 2: { cellWidth: 17, halign: "center", fontStyle: "bold" } };
      if (hasRef) colStyles[3] = { cellWidth: 20, halign: "center" };
      colStyles[desc] = { cellWidth: descWidth };
      colStyles[desc + 1] = { cellWidth: 15, halign: "right" };
      colStyles[desc + 2] = { cellWidth: hasRef ? 22 : 25, halign: "right" };
      colStyles[desc + 3] = { cellWidth: hasRef ? 25 : 27, halign: "right" };
      // Description cell: product name in bold, then its description and the
      // chosen options in grey (one autoTable cell has a single style).
      function drawDescription(h) {
        var it = d.items[h.row.index];
        var lines = h.cell.descLines || [];
        if (!it || !lines.length) return;
        var bold = it.boldLines || 0;
        var fs = h.cell.styles.fontSize, lh = fs * doc.getLineHeightFactor() / doc.internal.scaleFactor;
        var x = h.cell.x + h.cell.padding("left");
        var top = h.cell.y + (h.cell.height - lines.length * lh) / 2;
        doc.setFontSize(fs);
        lines.forEach(function (line, k) {
          doc.setFont("helvetica", k < bold ? "bold" : "normal");
          if (k < bold) doc.setTextColor(30, 40, 50); else doc.setTextColor(84, 96, 112);
          doc.text(line, x, top + lh * k, { baseline: "top" });
        });
        doc.setFont("helvetica", "normal"); doc.setTextColor(30, 40, 50);
      }
      doc.autoTable({
        startY: y,
        margin: { left: M, right: M },
        head: [[L.item, "", L.code].concat(hasRef ? [L.ref] : []).concat([L.description, L.qty, L.unit + " (" + d.cur.label + ")", L.amount + " (" + d.cur.label + ")"])],
        body: body,
        theme: "grid",
        rowPageBreak: "avoid", // an item is never split across two pages
        styles: { font: "helvetica", fontSize: 8.5, cellPadding: 2, valign: "middle", lineColor: [220, 226, 234], textColor: [30, 40, 50] },
        headStyles: { fillColor: navy, textColor: 255, fontStyle: "bold", halign: "center" },
        columnStyles: colStyles,
        didParseCell: function (h) {
          if (h.section === "body" && h.column.index === desc) h.cell.styles.fontStyle = "normal";
        },
        // Description cell: product name in bold, then its description and
        // chosen options in grey (drawn here, as one cell has a single style).
        willDrawCell: function (h) {
          if (h.section !== "body" || h.column.index !== desc) return;
          h.cell.descLines = h.cell.text.slice();
          h.cell.text = []; // drawn in didDrawCell, after the cell background
        },
        didDrawCell: function (h) {
          if (h.section === "body" && h.column.index === desc) drawDescription(h);
          if (h.section === "body" && h.column.index === 1) {
            var t = r.thumbs[h.row.index];
            if (t) doc.addImage(t.data, "JPEG", h.cell.x + 1.5, h.cell.y + (h.cell.height - 15) / 2, 15, 15);
            if (t && d.link) doc.link(h.cell.x, h.cell.y, h.cell.width, h.cell.height, { url: d.link });
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
      if (d.reference) section(L.refMark, doc.splitTextToSize(L.refNote, W - 2 * M)); // never bank details here
      else section(L.bank, bank);

      // Footer on every page (and, on the reference version, the watermark)
      var pages = doc.getNumberOfPages();
      for (var i = 1; i <= pages; i++) {
        doc.setPage(i);
        if (d.reference) {
          doc.saveGraphicsState();
          doc.setGState(new doc.GState({ opacity: 0.13 }));
          doc.setFont("helvetica", "bold"); doc.setFontSize(22); doc.setTextColor(198, 40, 40);
          // Centred on the page along a 35° diagonal (jsPDF rotates around the text's start point).
          var a = 35 * Math.PI / 180, half = doc.getTextWidth(L.refMark) / 2;
          doc.text(L.refMark, W / 2 - half * Math.cos(a), 150 + half * Math.sin(a), { angle: 35 });
          doc.restoreGraphicsState();
          doc.setFontSize(8); doc.setFont("helvetica", "bold"); doc.setTextColor(198, 40, 40);
          doc.text(L.refMark, W / 2, 284, { align: "center" });
        }
        doc.setFontSize(7.5); doc.setTextColor.apply(doc, muted); doc.setFont("helvetica", "normal");
        doc.text((s.companyName || "Shenzhen Micheng International Trading") + " · " + d.p.number, M, 290);
        doc.text(L.page + " " + i + "/" + pages, W - M, 290, { align: "right" });
      }
      doc.save(d.reference ? PD.safeName(d.p.number + (d.p.client ? " - " + d.p.client.name : "") + " - " + L.refTitle.split("— ")[1], "pdf") : fileName(d.p, "pdf"));
    });
  }

  function exportXlsx(p, ref) {
    return PD.buildXlsx(docData(p, ref));
  }

  // Exports the saved version (drafts are saved first).
  function runExport(kind) {
    var btn = $(kind === "pdf" ? "#pf-pdf" : "#pf-xlsx");
    btn.disabled = true;
    setStatus(T("pf.exporting"));
    save().then(ensureShare).then(function (p) {
      return kind === "pdf" ? exportPdf(p) : exportXlsx(p);
    }).then(function () { setStatus(""); }, function (e) {
      setStatus(T("pf.exportError") + " " + e.message, "error");
    }).then(function () { btn.disabled = false; });
  }
  // An order with discounted prices: ask which price the document uses (PDF or Excel).
  var exportKind = "pdf";
  function askOrExport(kind) {
    var hasRef = isClosed() && editing.items.some(function (i) { return i.declared != null; });
    if (!hasRef) return runExport(kind);
    exportKind = kind;
    var missing = editing.items.map(function (i, n) { return i.declared == null ? n + 1 : null; }).filter(Boolean);
    $("#pf-pdf-ref").disabled = missing.length > 0;
    $("#pf-pdf-missing").textContent = missing.length ? T("pf.pdfRefMissing", { items: missing.join(", ") }) : "";
    $("#pf-pdf-title").textContent = T(kind === "pdf" ? "pf.pdfChoose" : "pf.xlsxChoose");
    var dlg = $("#pf-pdf-dlg");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }
  $("#pf-pdf").addEventListener("click", function () { askOrExport("pdf"); });
  $("#pf-xlsx").addEventListener("click", function () { askOrExport("xlsx"); });
  $("#pf-pdf-dlg").addEventListener("click", function (e) {
    var dlg = this;
    var choice = e.target.closest("[data-pdf]");
    if (e.target === dlg || e.target.closest("[data-close]") || choice) dlg.close();
    if (!choice) return;
    if (choice.getAttribute("data-pdf") === "sale") return runExport(exportKind);
    var btn = $(exportKind === "pdf" ? "#pf-pdf" : "#pf-xlsx");
    btn.disabled = true;
    setStatus(T("pf.exporting"));
    (exportKind === "pdf" ? exportPdf(editing, true) : exportXlsx(editing, true))
      .then(function () { setStatus(""); }, function (err) { setStatus(T("pf.exportError") + " " + err.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Wiring ---------- */
  document.addEventListener("admin:data", function (e) {
    // The panel's combined load brings the proformas too.
    if (e.detail && e.detail.proformas) {
      proformas = e.detail.proformas;
      // The open proforma keeps what is being typed; only its saved copy is replaced.
      if (editing) {
        var fresh = proformas.filter(function (x) { return x.id === editing.id; })[0];
        if (fresh && fresh.updatedAt === editing.updatedAt) editing = fresh;
        else if (fresh && conflicted && !$("#pf-editor").hidden) {
          // Someone else saved it meanwhile: show their version (ours could not be saved over it).
          openEditor(fresh);
          setStatus(T("pf.conflict"), "error");
        }
        conflicted = false;
      }
      renderList();
    }
    fillClientSelect();
    if (!$("#pf-editor").hidden) renderItems();
  });
  document.addEventListener("admin:lang", function () {
    renderList();
    if (!$("#pf-editor").hidden) { renderHeader(); renderItems(); }
  });

  // Expose for tests and for loading when the panel opens.
  window.Proformas = { load: load, list: function () { return proformas; } };
})();
