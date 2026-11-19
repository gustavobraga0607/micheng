/* Pricing tab: one row per product variant, with the purchase price of each
   supplier, the list sale price, the margin and bulk actions. The main
   supplier of a variant is the one with the lowest cost. Admin-only. */
(function () {
  "use strict";

  var A = window.Admin;
  var $ = function (s) { return document.querySelector(s); };
  var T = function (k, v) { return A.T(k, v); };
  var esc = function (s) { return A.escapeHtml(s); };

  var drafts = {};          // rowId -> { price: "typed", costs: { supplierId: "typed" } }
  var selected = {};        // rowId -> true
  var open = {};            // rowId -> true (suppliers panel open)
  var quick = "";           // "" | nocost | noprice | low | changed
  var target = 0.3;         // target margin (0-1)
  var clientPrices = {};    // last prices of the chosen client
  var rowsCache = [];

  /* ---------- Numbers ---------- */
  function num(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) && v >= 0 ? v : null;
    var s = String(v).trim().replace(/\s/g, "");
    if (!s) return null;
    var c = s.lastIndexOf(","), d = s.lastIndexOf(".");
    if (c > -1 && d > -1) s = c > d ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (c > -1) s = s.replace(",", ".");
    var n = Number(s);
    return isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : null;
  }
  function plainNum(v) { return v == null ? "" : String(Math.round(v * 10000) / 10000).replace(".", ","); }
  function money(v) { return v == null ? "—" : A.money(v, A.defaultCurrency()); }
  function pct(m) { return m == null ? "—" : (Math.round(m * 1000) / 10).toLocaleString(A.locale()) + "%"; }
  function marginOf(price, cost) { return price && cost != null ? (price - cost) / price : null; }
  function round2(v) { return Math.round(v * 100) / 100; }

  /* ---------- Rows (one per variant) ---------- */
  function supplierById(id) { return A.suppliers().filter(function (s) { return s.id === id; })[0]; }
  function supplierName(s) { return s ? s.company + (s.companyZh ? " · " + s.companyZh : "") : "?"; }
  function rowId(p, key) { return p.id + "|" + key; }
  function priceKey(productId, ids) { var k = ids.filter(Boolean).sort(); return productId + (k.length ? "|" + k.join(",") : ""); }

  function buildRows() {
    var out = [];
    A.products().forEach(function (p) {
      var variants = A.variantCodes(p);
      if (!variants.length) variants = [{ key: "", code: String(p.sku || ""), label: "" }];
      variants.forEach(function (v) { out.push(makeRow(p, v)); });
    });
    rowsCache = out;
    return out;
  }

  // Everything a row shows, with the typed (unsaved) values applied.
  function makeRow(p, v) {
    var id = rowId(p, v.key);
    var d = drafts[id] || { costs: {} };
    var links = (p.supplierLinks || []).map(function (l) {
      var saved = v.key && l.variantCosts && l.variantCosts[v.key] != null ? l.variantCosts[v.key] : l.cost;
      var typed = Object.prototype.hasOwnProperty.call(d.costs, l.supplierId) ? num(d.costs[l.supplierId]) : saved;
      return { supplierId: l.supplierId, saved: saved == null ? null : saved, cost: typed, typed: Object.prototype.hasOwnProperty.call(d.costs, l.supplierId) };
    });
    // Suppliers added on this screen (not linked yet)
    Object.keys(d.costs).forEach(function (sid) {
      if (!links.some(function (l) { return l.supplierId === sid; })) links.push({ supplierId: sid, saved: null, cost: num(d.costs[sid]), typed: true, added: true });
    });
    var priced = links.filter(function (l) { return l.cost != null; });
    var main = priced.length ? priced.reduce(function (a, b) { return b.cost < a.cost ? b : a; }) : links[0] || null;
    var savedPrice = p.listPrices && p.listPrices[v.key] != null ? p.listPrices[v.key] : null;
    var price = Object.prototype.hasOwnProperty.call(d, "price") ? num(d.price) : savedPrice;
    var cost = main ? main.cost : null;
    var ids = v.key ? v.key.split(",") : [];
    var memo = clientPrices[priceKey(p.id, ids)] || clientPrices[p.id];
    var changed = (Object.prototype.hasOwnProperty.call(d, "price") && price !== savedPrice) ||
      links.some(function (l) { return l.typed && l.cost !== l.saved; });
    return {
      id: id, product: p, key: v.key, code: v.code, label: v.label,
      image: (v.key && p.variantImages && p.variantImages[v.key]) || p.image,
      links: links, main: main, cost: cost, price: price, savedPrice: savedPrice,
      margin: marginOf(price, cost),
      suggested: cost != null && target < 1 ? round2(cost / (1 - target)) : null,
      last: memo && memo.currency === A.defaultCurrency() ? memo : null,
      changed: changed
    };
  }

  /* ---------- Filters ---------- */
  function plain(t) { return String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  function visible(rows) {
    var q = plain($("#pr-search").value.trim());
    var cat = $("#pr-cat").value, sup = $("#pr-sup").value;
    return rows.filter(function (r) {
      if (cat && r.product.category !== cat) return false;
      if (sup && !r.links.some(function (l) { return l.supplierId === sup; })) return false;
      if (q) {
        var hay = plain(r.code + " " + A.productName(r.product) + " " + r.label + " " + r.links.map(function (l) { return supplierName(supplierById(l.supplierId)); }).join(" "));
        if (q.split(/\s+/).some(function (w) { return hay.indexOf(w) < 0; })) return false;
      }
      return passQuick(r, quick);
    });
  }
  function passQuick(r, k) {
    if (k === "nocost") return r.cost == null;
    if (k === "noprice") return r.price == null;
    if (k === "low") return r.margin != null && r.margin < target;
    if (k === "changed") return r.changed;
    return true;
  }

  /* ---------- Drawing ---------- */
  function marginClass(m) { return m == null ? "" : m < 0 ? "is-neg" : m < target ? "is-low" : "is-ok"; }

  // Costs negotiated per client for this specification (Clients tab of the product).
  function clientCostsHtml(r) {
    var cs = r.product.clientSpecs || {}, cur = A.defaultCurrency(), list = [];
    Object.keys(cs).forEach(function (cid) {
      var i = cs[cid][r.key || ""];
      if (!i || !i.supplierId) return;
      var c = A.clients().filter(function (x) { return x.id === cid; })[0];
      var s = supplierById(i.supplierId);
      list.push((c ? c.name : "?") + ": " + (i.cost == null ? "—" : A.money(i.cost, cur)) + " · " + (s ? s.company : "?"));
    });
    return list.length ? '<small class="pr-ccost" title="' + esc(list.join("\n")) + '">' + esc(T("pr.clientCosts", { n: list.length })) + "</small>" : "";
  }
  function rowHtml(r) {
    var cur = A.defaultCurrency();
    var main = r.main ? supplierById(r.main.supplierId) : null;
    var others = r.links.length - (r.main ? 1 : 0);
    var priceDirty = drafts[r.id] && Object.prototype.hasOwnProperty.call(drafts[r.id], "price") && r.price !== r.savedPrice;
    var costDirty = r.main && r.main.typed && r.main.cost !== r.main.saved;
    var html = '<div class="pr-row' + (selected[r.id] ? " is-selected" : "") + (r.changed ? " is-changed" : "") + '" data-row="' + esc(r.id) + '" role="row">' +
      '<span class="pr-c pr-c--check"><input type="checkbox" data-sel aria-label="' + esc(T("pr.select", { code: r.code })) + '"' + (selected[r.id] ? " checked" : "") + " /></span>" +
      '<span class="pr-c pr-c--img">' + (r.image ? '<img src="' + esc(r.image) + '" alt="" loading="lazy" />' : "") + "</span>" +
      '<span class="pr-c pr-c--code">' + esc(r.code) + "</span>" +
      '<span class="pr-c pr-c--name"><b>' + esc(A.productName(r.product)) + "</b>" + (r.label ? "<small>" + esc(r.label) + "</small>" : "") + clientCostsHtml(r) + "</span>" +
      '<span class="pr-c pr-c--sup">' + (main ? '<span class="pr-sup">' + esc(supplierName(main)) + "</span>" : '<span class="muted">' + esc(T("pr.noSupplier")) + "</span>") +
        '<button type="button" class="pr-more" data-toggle aria-expanded="' + (open[r.id] ? "true" : "false") + '">' +
        esc(others > 0 ? T("pr.moreSuppliers", { n: others }) : T(main ? "pr.suppliers" : "pr.addSupplier")) + (open[r.id] ? " ▴" : " ▾") + "</button></span>" +
      '<span class="pr-c pr-c--num"><input type="text" inputmode="decimal" autocomplete="off" data-f="cost" value="' + esc(r.main && r.main.cost != null ? plainNum(r.main.cost) : "") + '"' +
        (r.main ? "" : " disabled") + ' placeholder="' + esc(r.main ? "0,00" : "—") + '" class="' + (costDirty ? "is-dirty" : r.cost == null && r.main ? "is-empty" : "") + '" aria-label="' + esc(T("pr.cost") + " " + r.code) + '" /></span>' +
      '<span class="pr-c pr-c--num"><input type="text" inputmode="decimal" autocomplete="off" data-f="price" value="' + esc(r.price != null ? plainNum(r.price) : "") + '" placeholder="0,00" class="pr-price' + (priceDirty ? " is-dirty" : r.price == null ? " is-empty" : "") + '" aria-label="' + esc(T("pr.price") + " " + r.code) + '" /></span>' +
      '<span class="pr-c pr-c--num"><b class="pr-margin ' + marginClass(r.margin) + '" data-out="margin">' + esc(r.cost == null ? T("pr.noCostShort") : pct(r.margin)) + "</b></span>" +
      '<span class="pr-c pr-c--num">' + (r.suggested != null ? '<button type="button" class="pr-use" data-use="suggested" title="' + esc(T("pr.useThis")) + '">' + esc(money(r.suggested)) + "</button>" : "—") + "</span>" +
      '<span class="pr-c pr-c--num pr-c--last">' + (r.last ? '<button type="button" class="pr-use pr-use--muted" data-use="last" title="' + esc(T("pr.useThis") + " · " + r.last.number) + '">' + esc(money(r.last.price)) + "</button>" : "—") + "</span>" +
      "</div>";
    if (open[r.id]) html += suppliersPanel(r, cur);
    return html;
  }

  function suppliersPanel(r) {
    var linked = r.links.map(function (l) { return l.supplierId; });
    var cat = r.product.category;
    var addable = A.suppliers().filter(function (s) {
      if (s.productSupplier === false || linked.indexOf(s.id) > -1) return false;
      return !cat || !(s.categories || []).length || s.categories.indexOf(cat) > -1;
    });
    var lines = r.links.map(function (l) {
      var s = supplierById(l.supplierId);
      var isMain = r.main && r.main.supplierId === l.supplierId && l.cost != null;
      var m = marginOf(r.price, l.cost);
      return '<div class="pr-supline' + (isMain ? " is-main" : "") + '">' +
        '<span class="pr-supline__name"><b>' + esc(supplierName(s)) + "</b>" + (isMain ? '<em class="pr-tag">' + esc(T("pr.mainTag")) + "</em>" : "") + (l.added ? '<em class="pr-tag pr-tag--new">' + esc(T("pr.newTag")) + "</em>" : "") + "</span>" +
        '<input type="text" inputmode="decimal" autocomplete="off" data-supcost="' + esc(l.supplierId) + '" value="' + esc(l.cost != null ? plainNum(l.cost) : "") + '" placeholder="0,00"' +
          ' class="' + (l.typed && l.cost !== l.saved ? "is-dirty" : "") + '" aria-label="' + esc(T("pr.cost") + " " + (s ? s.company : "")) + '" />' +
        '<b class="pr-margin ' + marginClass(m) + '">' + esc(l.cost == null ? "—" : pct(m)) + "</b>" +
        "</div>";
    }).join("");
    return '<div class="pr-panel" data-panel="' + esc(r.id) + '">' +
      '<p class="pr-panel__hint">' + esc(T("pr.panelHint")) + "</p>" + lines +
      (addable.length ? '<div class="pr-supadd"><select data-addsup aria-label="' + esc(T("pr.addSupplier")) + '"><option value="">' + esc(T("pr.addSupplier")) + "…</option>" +
        addable.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(supplierName(s)) + "</option>"; }).join("") + "</select></div>" : "") +
      "</div>";
  }

  function render() {
    var all = buildRows();
    var rows = visible(all);
    // Quick filter counts (over the other filters)
    var base = (function () { var keep = quick; quick = ""; var b = visible(all); quick = keep; return b; })();
    ["", "nocost", "noprice", "low", "changed"].forEach(function (k) {
      var b = $('.pr-chip[data-quick="' + k + '"]');
      if (!b) return;
      b.classList.toggle("is-active", quick === k);
      b.setAttribute("aria-pressed", quick === k ? "true" : "false");
      b.querySelector("span").textContent = base.filter(function (r) { return passQuick(r, k); }).length;
    });
    $("#pr-body").innerHTML = rows.length ? rows.map(rowHtml).join("") : '<p class="pr-empty">' + esc(T("pr.none")) + "</p>";
    $("#pr-allsel").checked = rows.length > 0 && rows.every(function (r) { return selected[r.id]; });
    renderBars(all);
  }

  function renderBars(all) {
    var nSel = Object.keys(selected).length;
    $("#pr-bulk").hidden = !nSel;
    $("#pr-bulk-count").textContent = T("pr.selected", { n: nSel });
    var nChanged = (all || buildRows()).filter(function (r) { return r.changed; }).length;
    $("#pr-savebar").hidden = !nChanged;
    $("#pr-save").textContent = T("pr.save", { n: nChanged });
    $("#tab-count-pricing").hidden = !nChanged;
    $("#tab-count-pricing").textContent = nChanged;
  }

  // Refreshes one row (after a value is committed) without redrawing the table.
  function refreshRow(id) {
    var r = rowsCache.filter(function (x) { return x.id === id; })[0];
    if (!r) return render();
    var fresh = makeRow(r.product, { key: r.key, code: r.code, label: r.label });
    rowsCache[rowsCache.indexOf(r)] = fresh;
    var el = document.querySelector('.pr-row[data-row="' + cssEsc(id) + '"]');
    var panel = document.querySelector('.pr-panel[data-panel="' + cssEsc(id) + '"]');
    if (!el) return render();
    var tmp = document.createElement("div");
    tmp.innerHTML = rowHtml(fresh);
    if (panel) panel.remove();
    el.replaceWith.apply(el, Array.prototype.slice.call(tmp.childNodes));
    renderBars();
  }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }
  function rowOf(el) { var e = el.closest("[data-row],[data-panel]"); return e && (e.getAttribute("data-row") || e.getAttribute("data-panel")); }
  function findRow(id) { return rowsCache.filter(function (x) { return x.id === id; })[0]; }
  function draftOf(id) { return drafts[id] || (drafts[id] = { costs: {} }); }

  // Keeps only real differences from what is saved.
  function tidy(id) {
    var d = drafts[id], r = findRow(id);
    if (!d || !r) return;
    if (Object.prototype.hasOwnProperty.call(d, "price") && num(d.price) === r.savedPrice) delete d.price;
    Object.keys(d.costs).forEach(function (sid) {
      var l = r.links.filter(function (x) { return x.supplierId === sid; })[0];
      if (l && !l.added && num(d.costs[sid]) === l.saved) delete d.costs[sid];
    });
    if (!Object.prototype.hasOwnProperty.call(d, "price") && !Object.keys(d.costs).length) delete drafts[id];
  }

  /* ---------- Editing ---------- */
  function setPrice(id, value) { var d = draftOf(id); d.price = value == null ? "" : plainNum(value); tidy(id); }
  function setCost(id, sid, typed) { var d = draftOf(id); d.costs[sid] = typed; tidy(id); }

  $("#pr-body").addEventListener("input", function (e) {
    var id = rowOf(e.target);
    if (!id) return;
    var f = e.target.getAttribute("data-f");
    var sid = e.target.getAttribute("data-supcost");
    var r = findRow(id);
    if (f === "price") { draftOf(id).price = e.target.value; tidy(id); }
    else if (f === "cost" && r && r.main) setCost(id, r.main.supplierId, e.target.value);
    else if (sid) setCost(id, sid, e.target.value);
    else return;
    // Live margin while typing
    var fresh = makeRow(r.product, { key: r.key, code: r.code, label: r.label });
    var out = document.querySelector('.pr-row[data-row="' + cssEsc(id) + '"] [data-out="margin"]');
    if (out) { out.textContent = fresh.cost == null ? T("pr.noCostShort") : pct(fresh.margin); out.className = "pr-margin " + marginClass(fresh.margin); }
    e.target.classList.add("is-dirty");
    renderBars();
  });
  $("#pr-body").addEventListener("change", function (e) {
    var id = rowOf(e.target);
    if (!id) return;
    if (e.target.matches("[data-sel]")) {
      if (e.target.checked) selected[id] = true; else delete selected[id];
      e.target.closest(".pr-row").classList.toggle("is-selected", e.target.checked);
      renderBars();
      return;
    }
    if (e.target.matches("[data-addsup]")) {
      if (e.target.value) { setCost(id, e.target.value, ""); drafts[id] = drafts[id] || { costs: {} }; drafts[id].costs[e.target.value] = ""; }
      refreshRow(id);
      var inp = document.querySelector('.pr-panel[data-panel="' + cssEsc(id) + '"] [data-supcost="' + cssEsc(e.target.value) + '"]');
      if (inp) inp.focus();
      return;
    }
    if (e.target.matches("[data-f], [data-supcost]")) {
      var active = document.activeElement;
      var keep = active && active.closest && rowOf(active) === id ? null : active;
      refreshRow(id);
      if (keep && keep.focus) keep.focus();
    }
  });
  $("#pr-body").addEventListener("click", function (e) {
    var id = rowOf(e.target);
    if (!id) return;
    if (e.target.closest("[data-toggle]")) {
      if (open[id]) delete open[id]; else open[id] = true;
      refreshRow(id);
      return;
    }
    var use = e.target.closest("[data-use]");
    if (use) {
      var r = findRow(id);
      var v = use.getAttribute("data-use") === "last" ? r.last && r.last.price : r.suggested;
      if (v != null) { setPrice(id, v); refreshRow(id); }
    }
  });
  // Enter goes down the same column; pasting a column from Excel fills the rows below.
  $("#pr-body").addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || !e.target.matches("[data-f]")) return;
    e.preventDefault();
    moveDown(e.target, 1);
  });
  function moveDown(input, step) {
    var f = input.getAttribute("data-f");
    var all = Array.prototype.slice.call(document.querySelectorAll('#pr-body input[data-f="' + f + '"]:not([disabled])'));
    var next = all[all.indexOf(input) + step];
    if (next) { next.focus(); next.select(); } else input.blur();
  }
  $("#pr-body").addEventListener("paste", function (e) {
    var input = e.target;
    if (!input.matches("[data-f]")) return;
    var text = (e.clipboardData || window.clipboardData).getData("text");
    var values = String(text || "").replace(/\r/g, "").split("\n").map(function (x) { return x.split("\t")[0].trim(); });
    while (values.length && values[values.length - 1] === "") values.pop();
    if (values.length < 2) return; // a single value: normal paste
    e.preventDefault();
    var f = input.getAttribute("data-f");
    var all = Array.prototype.slice.call(document.querySelectorAll('#pr-body input[data-f="' + f + '"]:not([disabled])'));
    var start = all.indexOf(input), n = 0;
    values.forEach(function (v, k) {
      var el = all[start + k];
      if (!el || num(v) == null) return;
      var id = rowOf(el), r = findRow(id);
      if (f === "price") setPrice(id, num(v));
      else if (r.main) setCost(id, r.main.supplierId, plainNum(num(v)));
      n += 1;
    });
    render();
    setStatus(T("pr.pasted", { n: n }), "ok");
  });

  /* ---------- Selection and bulk actions ---------- */
  $("#pr-allsel").addEventListener("change", function () {
    var on = this.checked;
    visible(rowsCache).forEach(function (r) { if (on) selected[r.id] = true; else delete selected[r.id]; });
    render();
  });
  $("#pr-bulk").addEventListener("click", function (e) {
    var b = e.target.closest("[data-bulk]");
    if (!b) return;
    var kind = b.getAttribute("data-bulk");
    if (kind === "clear") { selected = {}; return render(); }
    var pctUp = kind === "raise" ? num($("#pr-raise").value) : null;
    var mode = $("#pr-round").value;
    var done = 0, skipped = 0;
    rowsCache.forEach(function (r) {
      if (!selected[r.id]) return;
      var v = null;
      if (kind === "target") v = r.suggested;
      else if (kind === "last") v = r.last ? r.last.price : null;
      else if (kind === "raise") v = r.price != null && pctUp != null ? r.price * (1 + pctUp / 100) : null;
      else if (kind === "round") v = r.price != null ? roundPrice(r.price, mode) : null;
      if (v == null) { skipped += 1; return; }
      setPrice(r.id, round2(v));
      done += 1;
    });
    render();
    setStatus(T("pr.bulkDone", { n: done }) + (skipped ? " " + T("pr.bulkSkipped", { n: skipped }) : ""), done ? "ok" : "error");
  });
  function roundPrice(v, mode) {
    if (mode === "90") return Math.floor(v) + 0.9 >= v ? Math.floor(v) + 0.9 : Math.floor(v) + 1.9;
    if (mode === "int") return Math.ceil(v);
    return Math.ceil(v * 10 - 1e-9) / 10; // ,X0
  }

  /* ---------- Filters, target margin, client ---------- */
  $("#pr-quick").addEventListener("click", function (e) {
    var b = e.target.closest("[data-quick]");
    if (!b) return;
    quick = b.getAttribute("data-quick");
    render();
  });
  ["#pr-search"].forEach(function (s) { $(s).addEventListener("input", render); });
  ["#pr-cat", "#pr-sup"].forEach(function (s) { $(s).addEventListener("change", render); });
  $("#pr-target").addEventListener("change", function () {
    var m = num(this.value);
    if (m == null || m >= 100) { this.value = plainNum(target * 100); return; }
    target = m / 100;
    targetDirty = true;
    render();
  });
  var targetDirty = false;
  $("#pr-client").addEventListener("change", function () {
    var id = this.value;
    clientPrices = {};
    if (!id) return render();
    A.api("/api/proformas?prices=" + encodeURIComponent(id)).then(function (d) { clientPrices = d.prices || {}; render(); }, function () { render(); });
  });

  function setStatus(msg, kind) {
    var el = $("#pr-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }

  /* ---------- Save / discard ---------- */
  $("#pr-discard").addEventListener("click", function () {
    if (!confirm(T("pr.discardConfirm"))) return;
    drafts = {};
    render();
    setStatus("");
  });
  $("#pr-save").addEventListener("click", function () {
    var changes = [];
    var bad = null;
    Object.keys(drafts).forEach(function (id) {
      var r = findRow(id), d = drafts[id];
      if (!r) return;
      var c = { productId: r.product.id, key: r.key };
      if (Object.prototype.hasOwnProperty.call(d, "price")) {
        if (d.price !== "" && num(d.price) == null) bad = bad || r.code;
        c.price = num(d.price);
      }
      var costs = {};
      Object.keys(d.costs).forEach(function (sid) {
        if (d.costs[sid] !== "" && num(d.costs[sid]) == null) bad = bad || r.code;
        costs[sid] = num(d.costs[sid]);
      });
      if (Object.keys(costs).length) c.costs = costs;
      changes.push(c);
    });
    if (bad) return setStatus(T("pr.badNumber", { code: bad }), "error");
    if (!changes.length && !targetDirty) return;
    var btn = this;
    btn.disabled = true;
    setStatus(T("pr.saving"));
    A.api("/api/products?action=pricing", { method: "POST", body: { changes: changes, targetMargin: target } })
      .then(function (d) {
        A.replaceProducts(d.products || []);
        drafts = {};
        targetDirty = false;
        render();
        setStatus(T("pr.saved", { n: changes.length }), "ok");
      }, function (err) { setStatus(err.message, "error"); })
      .then(function () { btn.disabled = false; });
  });
  window.addEventListener("beforeunload", function (e) {
    if (Object.keys(drafts).length) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------- "Incluir produtos a fornecedor": one supplier, many variants, a cost each ---------- */
  var linkPicked = [];  // [{ id, productId, key, code, name, label, image, cost: "typed" }]
  function linkSupplier() { return supplierById($("#prl-supplier").value); }
  function linkCostOf(row, sid) {
    var l = row.links.filter(function (x) { return x.supplierId === sid; })[0];
    return l ? l.saved : null;
  }
  function openLinkDialog() {
    buildRows();
    var sel = $("#prl-supplier");
    var list = A.suppliers().filter(function (s) { return s.productSupplier !== false; });
    sel.innerHTML = '<option value="">' + esc(T("prl.chooseSupplier")) + "</option>" + list.map(function (s) {
      var cats = (s.categories || []).map(function (c) { return T("cat." + c); }).join(", ");
      return '<option value="' + esc(s.id) + '">' + esc(supplierName(s) + (cats ? " — " + cats : "")) + "</option>";
    }).join("");
    linkPicked = [];
    $("#prl-search").value = "";
    $("#prl-allcats").checked = false;
    linkStatus("");
    renderLinkDialog();
    var dlg = $("#prlink-dlg");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    sel.focus();
  }
  function linkStatus(msg, kind) { var el = $("#prl-status"); el.textContent = msg || ""; el.className = "status" + (kind ? " is-" + kind : ""); }
  function linkResults() {
    var sup = linkSupplier();
    if (!sup) return [];
    var cats = sup.categories || [];
    var q = plain($("#prl-search").value.trim());
    var words = q ? q.split(/\s+/) : [];
    return rowsCache.filter(function (r) {
      if (!$("#prl-allcats").checked && cats.length && cats.indexOf(r.product.category) < 0) return false;
      if (!words.length) return true;
      var hay = plain(r.code + " " + A.productName(r.product) + " " + r.label);
      return words.every(function (w) { return hay.indexOf(w) > -1; });
    });
  }
  function renderLinkDialog() {
    var sup = linkSupplier();
    $("#prl-search").disabled = !sup;
    var res = linkResults();
    var picked = {};
    linkPicked.forEach(function (x) { picked[x.id] = true; });
    var shown = res.slice(0, 60);
    $("#prl-results").innerHTML = !sup ? '<p class="muted">' + esc(T("prl.pickSupplierFirst")) + "</p>" :
      (shown.length ? '<div class="prl__reshead"><span>' + esc(T("prl.found", { n: res.length })) + "</span>" +
        (res.some(function (r) { return !picked[r.id]; }) ? '<button type="button" class="linkbtn" data-addall>' + esc(T("prl.addAll", { n: res.filter(function (r) { return !picked[r.id]; }).length })) + "</button>" : "") + "</div>" +
        shown.map(function (r) {
          var linked = r.links.some(function (l) { return l.supplierId === sup.id && !l.added; });
          return '<div class="prl__res' + (picked[r.id] ? " is-picked" : "") + '">' +
            (r.image ? '<img src="' + esc(r.image) + '" alt="" loading="lazy" />' : "<span></span>") +
            '<span class="prl__txt"><b><span class="sku">' + esc(r.code) + "</span> " + esc(A.productName(r.product)) + "</b>" + (r.label ? "<small>" + esc(r.label) + "</small>" : "") + "</span>" +
            (linked ? '<em class="pr-tag">' + esc(T("prl.linked")) + "</em>" : "<span></span>") +
            (picked[r.id] ? '<span class="muted">' + esc(T("prl.added")) + "</span>" : '<button type="button" class="btn btn--outline btn--sm" data-add="' + esc(r.id) + '">' + esc(T("prl.add")) + "</button>") +
            "</div>";
        }).join("") + (res.length > shown.length ? '<p class="muted">' + esc(T("prl.more", { n: res.length - shown.length })) + "</p>" : "")
        : '<p class="muted">' + esc(T("prl.noneFound")) + "</p>");
    $("#prl-count").textContent = linkPicked.length ? T("prl.pickedCount", { n: linkPicked.length }) : "";
    $("#prl-picked").innerHTML = linkPicked.length ? linkPicked.map(function (x, k) {
      return '<div class="prl__pick" data-k="' + k + '">' +
        '<span class="prl__txt"><b><span class="sku">' + esc(x.code) + "</span> " + esc(x.name) + "</b>" + (x.label ? "<small>" + esc(x.label) + "</small>" : "") + "</span>" +
        '<input type="text" inputmode="decimal" autocomplete="off" data-cost="' + k + '" value="' + esc(x.cost) + '" placeholder="' + esc(T("prl.costPh")) + '" aria-label="' + esc(T("pr.cost") + " " + x.code) + '" />' +
        '<button type="button" class="icon-btn icon-btn--danger" data-remove="' + k + '" aria-label="' + esc(T("prl.remove")) + '" title="' + esc(T("prl.remove")) + '">×</button></div>';
    }).join("") : '<p class="muted">' + esc(T("prl.nonePicked")) + "</p>";
    $("#prl-save").disabled = !sup || !linkPicked.length;
    $("#prl-save").textContent = T("prl.saveN", { n: linkPicked.length });
  }
  function pick(r) {
    if (linkPicked.some(function (x) { return x.id === r.id; })) return;
    var sup = linkSupplier();
    var c = sup ? linkCostOf(r, sup.id) : null;
    linkPicked.push({ id: r.id, productId: r.product.id, key: r.key, code: r.code, name: A.productName(r.product), label: r.label, cost: c != null ? plainNum(c) : "" });
  }
  $("#prl-supplier").addEventListener("change", function () {
    // Costs already registered with the new supplier fill the empty fields.
    var sup = linkSupplier();
    linkPicked.forEach(function (x) {
      var r = findRow(x.id);
      var c = sup && r ? linkCostOf(r, sup.id) : null;
      if (!x.cost && c != null) x.cost = plainNum(c);
    });
    renderLinkDialog();
    if (sup) $("#prl-search").focus();
  });
  $("#prl-search").addEventListener("input", renderLinkDialog);
  $("#prl-allcats").addEventListener("change", renderLinkDialog);
  $("#prl-results").addEventListener("click", function (e) {
    var add = e.target.closest("[data-add]");
    if (add) { var r = findRow(add.getAttribute("data-add")); if (r) pick(r); renderLinkDialog(); return; }
    if (e.target.closest("[data-addall]")) { linkResults().forEach(pick); renderLinkDialog(); }
  });
  $("#prl-picked").addEventListener("input", function (e) {
    var k = e.target.getAttribute("data-cost");
    if (k != null) linkPicked[Number(k)].cost = e.target.value;
  });
  $("#prl-picked").addEventListener("click", function (e) {
    var rm = e.target.closest("[data-remove]");
    if (rm) { linkPicked.splice(Number(rm.getAttribute("data-remove")), 1); renderLinkDialog(); }
  });
  $("#prl-picked").addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || !e.target.matches("[data-cost]")) return;
    e.preventDefault();
    var next = $("#prl-picked").querySelector('[data-cost="' + (Number(e.target.getAttribute("data-cost")) + 1) + '"]');
    if (next) { next.focus(); next.select(); } else $("#prl-save").focus();
  });
  // A column pasted from Excel fills the costs from this line down.
  $("#prl-picked").addEventListener("paste", function (e) {
    if (!e.target.matches("[data-cost]")) return;
    var values = String((e.clipboardData || window.clipboardData).getData("text") || "").replace(/\r/g, "").split("\n").map(function (x) { return x.split("\t")[0].trim(); });
    while (values.length && values[values.length - 1] === "") values.pop();
    if (values.length < 2) return;
    e.preventDefault();
    var start = Number(e.target.getAttribute("data-cost"));
    values.forEach(function (v, i) { if (linkPicked[start + i] && num(v) != null) linkPicked[start + i].cost = v; });
    renderLinkDialog();
  });
  $("#prlink-dlg").addEventListener("click", function (e) { if (e.target === this || e.target.closest("[data-close]")) this.close(); });
  $("#prlink-open").addEventListener("click", openLinkDialog);
  $("#prl-save").addEventListener("click", function () {
    var sup = linkSupplier();
    if (!sup || !linkPicked.length) return;
    var bad = linkPicked.filter(function (x) { return x.cost !== "" && num(x.cost) == null; })[0];
    if (bad) return linkStatus(T("pr.badNumber", { code: bad.code }), "error");
    var changes = linkPicked.map(function (x) {
      var costs = {};
      costs[sup.id] = num(x.cost);
      return { productId: x.productId, key: x.key, costs: costs };
    });
    var btn = this;
    btn.disabled = true;
    linkStatus(T("pr.saving"));
    A.api("/api/products?action=pricing", { method: "POST", body: { changes: changes } })
      .then(function (d) {
        A.replaceProducts(d.products || []);
        // Values typed in the table for this supplier and these rows are now saved.
        linkPicked.forEach(function (x) { if (drafts[x.id]) { delete drafts[x.id].costs[sup.id]; tidy(x.id); } });
        var n = linkPicked.length;
        $("#prlink-dlg").close();
        render();
        setStatus(T("prl.done", { n: n, supplier: sup.company }), "ok");
      }, function (err) { linkStatus(err.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Options of the selects, data from the panel ---------- */
  function fillSelects() {
    var sup = $("#pr-sup"), keep = sup.value;
    sup.innerHTML = '<option value="">' + esc(T("pr.allSuppliers")) + "</option>" + A.suppliers().filter(function (s) { return s.productSupplier !== false; })
      .map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(supplierName(s)) + "</option>"; }).join("");
    sup.value = keep;
    var cli = $("#pr-client"), keepC = cli.value;
    cli.innerHTML = '<option value="">' + esc(T("pr.noClient")) + "</option>" + A.clients()
      .map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("");
    cli.value = keepC;
  }
  document.addEventListener("admin:data", function (e) {
    if (e.detail && e.detail.pricing && !targetDirty) {
      target = Number(e.detail.pricing.targetMargin) || 0.3;
      $("#pr-target").value = plainNum(round2(target * 100));
    }
    fillSelects();
    if (!$("#pricing-view").hidden) render();
  });
  document.addEventListener("admin:lang", function () { fillSelects(); if (!$("#pricing-view").hidden) render(); });
  document.addEventListener("admin:tab", function (e) { if (e.detail === "pricing") { fillSelects(); render(); } });
})();
