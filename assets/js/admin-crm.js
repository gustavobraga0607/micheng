/* Client file (a small CRM) on the Clients tab: what the client has bought
   and been quoted, product by product (variant), with the history of
   quantities and prices, its orders and proformas, and what was received.
   Built from data the panel already has (proformas, products, finance). */
(function () {
  "use strict";

  var A = window.Admin;
  var $ = function (s) { return document.querySelector(s); };
  var T = function (k, v) { return A.T(k, v); };
  var esc = function (s) { return A.escapeHtml(s); };

  var clientId = null;   // client open in the file
  var tab = "products";  // products | orders
  var filter = "";       // "" | bought | quoted | registered
  var open = {};         // product row key -> history open

  function proformas() { return (window.Proformas && window.Proformas.list()) || []; }
  function entries() { return (window.Finance && window.Finance.entries()) || []; }
  function clientById(id) { return A.clients().filter(function (c) { return c.id === id; })[0]; }
  function productById(id) { return A.products().filter(function (p) { return p.id === id; })[0]; }
  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso + (String(iso).length === 10 ? "T00:00:00" : ""));
    return d.toLocaleDateString(A.locale());
  }
  function qtyText(n) { return Number(n || 0).toLocaleString(A.locale(), { maximumFractionDigits: 3 }); }
  function sums(map) { // { currency: amount } -> "¥ 1.000,00 + US$ 50,00"
    var keys = Object.keys(map).filter(function (c) { return Math.abs(map[c]) > 0.004; });
    return keys.length ? keys.map(function (c) { return A.money(map[c], c); }).join(" + ") : "—";
  }
  function add(map, cur, v) { map[cur] = Math.round(((map[cur] || 0) + v) * 100) / 100; }

  /* ---------- Data of one client ---------- */
  function variantLabel(p, key) {
    if (!p || !key) return "";
    var v = A.variantCodes(p).filter(function (x) { return x.key === key; })[0];
    return v ? v.label : "";
  }
  function variantCode(p, key, fallback) {
    if (!p) return fallback || "";
    if (!key) return String(p.sku || fallback || "");
    var n = p.variantSkus && p.variantSkus[key];
    return n ? p.sku + "-" + n : fallback || String(p.sku || "");
  }

  function collect(id) {
    var mine = proformas().filter(function (p) { return p.clientId === id; })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || String(b.number).localeCompare(String(a.number)); });
    var rows = {};
    function row(productId, key, item) {
      var k = productId + "|" + key;
      if (!rows[k]) {
        var p = productById(productId);
        rows[k] = {
          k: k, productId: productId, key: key, product: p,
          code: variantCode(p, key, item && item.sku),
          name: p ? A.productName(p) : item && item.product ? pickName(item.product.name) : "?",
          label: p ? variantLabel(p, key) : item ? (item.options || []).map(function (o) { var n = pickName(o.attrName); return (n ? n + ": " : "") + pickName(o.optionLabel); }).join(" · ") : "",
          image: p ? A.photoFor(p, key) : item && item.product ? item.product.image : null,
          ref: "", history: [], bought: 0, orders: 0, quoted: 0, prices: [], last: null
        };
      }
      return rows[k];
    }
    // Products bought (orders) and quoted (open proformas)
    mine.forEach(function (pf) {
      pf.items.forEach(function (it) {
        var key = it.options.map(function (o) { return o.optionId; }).filter(Boolean).sort().join(",");
        var r = row(it.productId, key, it);
        if (it.clientRef) r.ref = r.ref || it.clientRef;
        var line = { pfId: pf.id, number: pf.number, date: pf.date, closed: pf.status === "closed", qty: it.qty, price: it.price, currency: pf.currency };
        r.history.push(line);
        if (line.closed) {
          r.bought += it.qty; r.orders += 1;
          if (it.price != null) r.prices.push({ price: it.price, currency: pf.currency });
          if (!r.last) r.last = line; // newest first
        } else r.quoted += it.qty;
      });
    });
    // Products with the client's own code registered (product form)
    A.products().forEach(function (p) {
      var map = p.clientRefs && p.clientRefs[id];
      if (!map) return;
      Object.keys(map).forEach(function (key) {
        if (!map[key]) return;
        var r = row(p.id, key, null);
        r.ref = r.ref || map[key];
        r.registered = true;
      });
    });
    // What the client asked for each specification (its name for it, requirements, sample)
    A.products().forEach(function (p) {
      var m = p.clientSpecs && p.clientSpecs[id];
      if (!m) return;
      Object.keys(m).forEach(function (key) {
        var r = row(p.id, key, null);
        r.registered = true;
        r.spec = m[key];
      });
    });
    var list = Object.keys(rows).map(function (k) { return rows[k]; });
    list.forEach(function (r) {
      var same = r.prices.filter(function (x) { return r.last && x.currency === r.last.currency; }).map(function (x) { return x.price; });
      r.min = same.length ? Math.min.apply(null, same) : null;
      r.max = same.length ? Math.max.apply(null, same) : null;
      r.lastQuote = r.history.filter(function (h) { return !h.closed; })[0] || null;
    });
    list.sort(function (a, b) { return b.bought - a.bought || b.quoted - a.quoted || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }); });
    // Money received: incomes paid, linked to the client's orders or to the client
    var ids = {};
    mine.forEach(function (p) { ids[p.id] = true; });
    var received = {}, receivedBy = {};
    entries().forEach(function (e) {
      if (e.type !== "in" || e.status !== "paid") return;
      if (!(ids[e.proformaId] || (e.party && e.party.kind === "client" && e.party.id === id))) return;
      add(received, e.currency, e.amount);
      if (e.proformaId) { receivedBy[e.proformaId] = receivedBy[e.proformaId] || {}; add(receivedBy[e.proformaId], e.currency, e.amount); }
    });
    return { proformas: mine, rows: list, received: received, receivedBy: receivedBy };
  }
  function pickName(o) { return (o && (o[A.lang()] || o.en || o.pt)) || ""; }

  /* ---------- Drawing ---------- */
  function render() {
    var c = clientById(clientId);
    if (!c) return close();
    var data = collect(clientId);
    var orders = data.proformas.filter(function (p) { return p.status === "closed"; });
    var quotes = data.proformas.filter(function (p) { return p.status !== "closed"; });
    var bought = {}, quotedVal = {};
    orders.forEach(function (p) { add(bought, p.currency, p.totals.sale); });
    quotes.forEach(function (p) { add(quotedVal, p.currency, p.totals.sale); });
    var toReceive = {};
    orders.forEach(function (p) {
      var got = (data.receivedBy[p.id] || {})[p.currency] || 0;
      add(toReceive, p.currency, Math.max(0, p.totals.sale - got));
    });
    var details = [c.country && (c.country + (c.countryCode ? " (" + c.countryCode + ")" : "")), c.phone && "☎ " + c.phone, c.taxId && T("cli.taxId") + ": " + c.taxId].filter(Boolean);
    $("#crm-name").textContent = c.name;
    $("#crm-details").textContent = details.join(" · ") + (c.address ? (details.length ? " · " : "") + c.address : "");
    var kpis = [
      [T("crm.kOrders"), String(orders.length), orders[0] ? T("crm.kLast", { date: fmtDate(orders[0].date), number: orders[0].number }) : ""],
      [T("crm.kBought"), sums(bought), orders.length ? T("crm.kAvg", { value: avgText(orders) }) : ""],
      [T("crm.kReceived"), sums(data.received), T("crm.kToReceive", { value: sums(toReceive) })],
      [T("crm.kQuotes"), String(quotes.length), quotes.length ? sums(quotedVal) : ""],
      [T("crm.kProducts"), String(data.rows.filter(function (r) { return r.bought > 0; }).length), T("crm.kRegistered", { n: data.rows.filter(function (r) { return r.registered; }).length })]
    ];
    $("#crm-kpis").innerHTML = kpis.map(function (k) {
      return '<div class="crm-kpi"><span>' + esc(k[0]) + "</span><b>" + esc(k[1]) + "</b>" + (k[2] ? "<small>" + esc(k[2]) + "</small>" : "") + "</div>";
    }).join("");
    document.querySelectorAll(".crm-tab").forEach(function (b) {
      var on = b.getAttribute("data-crmtab") === tab;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("#crm-tab-products").textContent = data.rows.length;
    $("#crm-tab-orders").textContent = data.proformas.length;
    $("#crm-products").hidden = tab !== "products";
    $("#crm-orders").hidden = tab !== "orders";
    if (tab === "products") renderProducts(data); else renderOrders(data);
  }
  function avgText(orders) {
    var by = {}, n = {};
    orders.forEach(function (p) { add(by, p.currency, p.totals.sale); n[p.currency] = (n[p.currency] || 0) + 1; });
    var avg = {};
    Object.keys(by).forEach(function (cur) { avg[cur] = by[cur] / n[cur]; });
    return sums(avg);
  }

  function renderProducts(data) {
    var q = String($("#crm-search").value || "").trim().toLowerCase();
    var rows = data.rows.filter(function (r) {
      if (filter === "bought" && !r.bought) return false;
      if (filter === "quoted" && !r.quoted) return false;
      if (filter === "registered" && !(r.registered && !r.bought)) return false;
      return !q || (r.code + " " + r.name + " " + r.label + " " + r.ref + " " + (r.spec ? r.spec.name + " " + r.spec.requirements : "")).toLowerCase().indexOf(q) > -1;
    });
    document.querySelectorAll(".crm-chip").forEach(function (b) {
      var k = b.getAttribute("data-crmf");
      b.classList.toggle("is-active", k === filter);
      b.querySelector("span").textContent = data.rows.filter(function (r) {
        return !k || (k === "bought" ? r.bought : k === "quoted" ? r.quoted : r.registered && !r.bought);
      }).length;
    });
    $("#crm-prod-body").innerHTML = rows.length ? rows.map(function (r) {
      var trend = r.min != null && r.max != null && r.max !== r.min ? A.money(r.min, r.last.currency) + " – " + A.money(r.max, r.last.currency) : "";
      var html = '<div class="crm-row" data-k="' + esc(r.k) + '">' +
        '<span class="crm-c crm-c--img">' + (r.image ? '<img src="' + esc(r.image) + '" alt="" loading="lazy" />' : "") + "</span>" +
        '<span class="crm-c crm-c--prod"><b><span class="sku">' + esc(r.code) + "</span> " + esc(r.name) + "</b>" + (r.label ? "<small>" + esc(r.label) + "</small>" : "") +
          (r.spec && r.spec.name ? '<small class="crm-cname">' + esc(r.spec.name) + "</small>" : "") +
          (r.spec && r.spec.requirements ? '<small class="crm-req">' + esc(T("cs.req", { text: r.spec.requirements })) + "</small>" : "") +
          (r.spec && r.spec.supplierId ? '<small class="crm-cost">' + esc(T("cs.costLine", { cost: r.spec.cost == null ? "—" : A.money(r.spec.cost, A.defaultCurrency()), supplier: (A.suppliers().filter(function (s) { return s.id === r.spec.supplierId; })[0] || {}).company || "?" })) + "</small>" : "") +
          (r.spec && r.spec.sample ? ' <em class="spec-tag ' + (r.spec.sample === "approved" ? "spec-tag--ok" : r.spec.sample === "rejected" ? "spec-tag--arch" : "spec-tag--miss") + '">' + esc(T("cs.sample") + " " + T("cs.sample." + r.spec.sample)) + "</em>" : "") + "</span>" +
        '<span class="crm-c" data-label="' + esc(T("crm.ref")) + '">' + (r.ref ? '<span class="crm-ref">' + esc(r.ref) + "</span>" : "—") + "</span>" +
        '<span class="crm-c crm-c--num" data-label="' + esc(T("crm.qtyBought")) + '">' + (r.bought ? "<b>" + esc(qtyText(r.bought)) + "</b><small>" + esc(T("crm.inOrders", { n: r.orders })) + "</small>" : "—") + "</span>" +
        '<span class="crm-c crm-c--num" data-label="' + esc(T("crm.lastPrice")) + '">' + (r.last ? "<b>" + esc(A.money(r.last.price, r.last.currency)) + "</b><small>" + esc(fmtDate(r.last.date) + " · " + r.last.number) + "</small>" : "—") + "</span>" +
        '<span class="crm-c crm-c--num" data-label="' + esc(T("crm.range")) + '">' + (trend ? esc(trend) : "—") + "</span>" +
        '<span class="crm-c crm-c--num" data-label="' + esc(T("crm.quoted")) + '">' + (r.quoted ? "<b>" + esc(qtyText(r.quoted)) + "</b>" + (r.lastQuote ? "<small>" + esc(A.money(r.lastQuote.price, r.lastQuote.currency) + " · " + r.lastQuote.number) + "</small>" : "") : "—") + "</span>" +
        '<span class="crm-c crm-c--btn">' + (r.history.length ? '<button type="button" class="linkbtn" data-hist aria-expanded="' + (open[r.k] ? "true" : "false") + '">' + esc(T("crm.history", { n: r.history.length })) + (open[r.k] ? " ▴" : " ▾") + "</button>" : '<small class="muted">' + esc(T("crm.onlyRegistered")) + "</small>") + "</span>" +
        "</div>";
      if (open[r.k]) {
        html += '<div class="crm-hist">' + r.history.map(function (h) {
          return '<div class="crm-hist__row"><span>' + esc(fmtDate(h.date)) + "</span>" +
            '<button type="button" class="linkbtn" data-openpf="' + esc(h.pfId) + '">' + esc(h.number) + "</button>" +
            '<span class="badge badge--' + (h.closed ? "closed" : "draft") + '">' + esc(T(h.closed ? "pf.closed" : "pf.draft")) + "</span>" +
            '<span class="crm-c--num">' + esc(qtyText(h.qty)) + " × " + esc(A.money(h.price, h.currency)) + "</span>" +
            '<b class="crm-c--num">' + esc(A.money(Math.round((h.price || 0) * h.qty * 100) / 100, h.currency)) + "</b></div>";
        }).join("") + "</div>";
      }
      return html;
    }).join("") : '<p class="pr-empty">' + esc(T("crm.noProducts")) + "</p>";
  }

  function renderOrders(data) {
    $("#crm-ord-body").innerHTML = data.proformas.length ? data.proformas.map(function (p) {
      var got = data.receivedBy[p.id] || {};
      var paid = got[p.currency] || 0;
      var closed = p.status === "closed";
      var rest = closed ? Math.max(0, Math.round((p.totals.sale - paid) * 100) / 100) : null;
      return '<div class="crm-orow">' +
        '<span><button type="button" class="linkbtn" data-openpf="' + esc(p.id) + '"><b>' + esc(p.number) + "</b></button></span>" +
        '<span data-label="' + esc(T("crm.date")) + '">' + esc(fmtDate(p.date)) + "</span>" +
        '<span><span class="badge badge--' + (closed ? "closed" : "draft") + '">' + esc(T(closed ? "pf.closed" : "pf.draft")) + "</span></span>" +
        '<span class="crm-c--num" data-label="' + esc(T("crm.itemsCol")) + '">' + esc(T("crm.items", { n: p.items.length })) + "</span>" +
        '<span class="crm-c--num" data-label="' + esc(T("crm.value")) + '"><b>' + esc(A.money(p.totals.sale, p.currency)) + "</b></span>" +
        '<span class="crm-c--num" data-label="' + esc(T("crm.received")) + '">' + (closed ? esc(sums(got)) : "—") + "</span>" +
        '<span data-label="' + esc(T("crm.toReceive")) + '" class="crm-c--num ' + (rest ? "crm-due" : "crm-ok") + '">' + (closed ? (rest ? esc(A.money(rest, p.currency)) : esc(T("crm.paidUp"))) : "—") + "</span>" +
        "</div>";
    }).join("") : '<p class="pr-empty">' + esc(T("crm.noOrders")) + "</p>";
  }

  /* ---------- Opening and closing ---------- */
  function openFile(id) {
    clientId = id;
    tab = "products"; filter = ""; open = {};
    $("#crm-search").value = "";
    $("#client-panel").hidden = true;
    $("#client-list-panel").hidden = true;
    $("#crm").hidden = false;
    render();
    window.scrollTo(0, 0);
  }
  function close() {
    clientId = null;
    $("#crm").hidden = true;
    $("#client-panel").hidden = false;
    $("#client-list-panel").hidden = false;
  }
  $("#crm-back").addEventListener("click", close);
  $("#crm-edit").addEventListener("click", function () {
    var id = clientId;
    close();
    A.editClient(id);
  });
  $("#crm-newpf").addEventListener("click", function () {
    if (window.Proformas && window.Proformas.startFor) window.Proformas.startFor(clientId);
  });
  document.querySelector(".crm-tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-crmtab]");
    if (b) { tab = b.getAttribute("data-crmtab"); render(); }
  });
  $("#crm-chips").addEventListener("click", function (e) {
    var b = e.target.closest("[data-crmf]");
    if (b) { filter = b.getAttribute("data-crmf"); render(); }
  });
  $("#crm-search").addEventListener("input", render);
  $("#crm").addEventListener("click", function (e) {
    var h = e.target.closest("[data-hist]");
    if (h) { var k = h.closest("[data-k]").getAttribute("data-k"); if (open[k]) delete open[k]; else open[k] = true; render(); return; }
    var pf = e.target.closest("[data-openpf]");
    if (pf && window.Proformas && window.Proformas.open) window.Proformas.open(pf.getAttribute("data-openpf"));
  });
  document.addEventListener("admin:data", function () { if (clientId && !$("#crm").hidden) render(); });
  document.addEventListener("admin:lang", function () { if (clientId && !$("#crm").hidden) render(); });
  document.addEventListener("finance:changed", function () { if (clientId && !$("#crm").hidden) render(); });

  window.CRM = { open: openFile };
})();
