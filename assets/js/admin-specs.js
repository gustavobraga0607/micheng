/* Product page, "Especificações" tab: one table with every exact model of the
   product (photo, code, characteristics, technical sheet status, main supplier
   and cost, list price, margin, clients), filters and grouping (by client or by
   a characteristic). A row opens a side panel with three parts: technical sheet,
   suppliers and price, clients. A product with characteristics and no
   specification yet starts with a grid to create several at once. */
(function () {
  "use strict";

  var A = window.Admin;
  var $ = function (s) { return document.querySelector(s); };
  var T = function (k, v) { return A.T(k, v); };
  var esc = function (s) { return A.escapeHtml(s); };

  var DEFAULT_CHECKLIST = ["details"];
  var NEW = "\u0000new";      // the drawer holds a specification not created yet
  var filter = "active";     // active | incomplete | noclient | archived
  var groupBy = "";          // "" | "client" | an attribute id
  var query = "";
  var open = null;           // key of the specification in the side panel (NEW = new one)
  var dtab = "sheet";        // sheet | com | clients
  var draft = null;          // editing state of the open specification
  var editingLink = null;    // client link being edited in the panel: clientId or "new"
  var wizard = null;         // creating several: { checked: {key: true}, supplierId, cost, price }
  var flash = null;          // message shown above the table after an action

  /* ---------- Data helpers ---------- */
  function product() { var id = A.openProductId(); return id ? A.products().filter(function (p) { return p.id === id; })[0] : null; }
  function attrsOf(p) { return (p.attributes || []).filter(function (a) { return a.options.length; }); }
  function pick(o) { var l = A.lang(); return (o && (o[l] || o.en || o.pt)) || ""; }
  function attrName(a) { return pick(a.name) || a.source; }
  function optLabel(o) { return pick(o.label) || o.source; }
  function checklist(p) {
    var c = (A.settings() || {}).checklist;
    return c && Array.isArray(c[p.category]) ? c[p.category] : DEFAULT_CHECKLIST;
  }
  function isSingle(p) { return !attrsOf(p).length; }
  function codeOf(p, key) { var n = (p.variantSkus || {})[key]; return n ? p.sku + "-" + n : String(p.sku || ""); }
  function isArchived(p, key) { return Boolean(((p.specs || {})[key] || {}).archived); }
  function allKeys(p) {
    if (isSingle(p)) return [""];
    var vs = p.variantSkus || {};
    return Object.keys(vs).sort(function (a, b) { return vs[a] - vs[b]; });
  }
  function optionsOfKey(p, key) {
    var ids = key ? key.split(",") : [], out = {};
    attrsOf(p).forEach(function (a) { var o = a.options.filter(function (x) { return ids.indexOf(x.id) > -1; })[0]; if (o) out[a.id] = o.id; });
    return out;
  }
  function optionOf(p, key, attr) {
    var ids = key ? key.split(",") : [];
    return attr.options.filter(function (x) { return ids.indexOf(x.id) > -1; })[0] || null;
  }
  function summary(p, key) {
    return attrsOf(p).map(function (a) { var o = optionOf(p, key, a); return o ? attrName(a) + ": " + optLabel(o) : ""; }).filter(Boolean).join(" · ");
  }
  function chipsHtml(p, key) {
    if (isSingle(p)) return '<span class="st-chip st-chip--muted">' + esc(T("spec.single")) + "</span>";
    return attrsOf(p).map(function (a) {
      var o = optionOf(p, key, a);
      return '<span class="st-chip" title="' + esc(attrName(a)) + '">' + esc(o ? optLabel(o) : "?") + "</span>";
    }).join("");
  }
  // What a specification still lacks: the category's mandatory fields.
  function missingOf(p, key) {
    if (isSingle(p)) return [];
    var info = (p.specs || {})[key] || {}, miss = [];
    var opts = optionsOfKey(p, key);
    attrsOf(p).forEach(function (a) { if (!opts[a.id]) miss.push(attrName(a)); });
    checklist(p).forEach(function (f) {
      if (f === "photo" ? A.photoFor(p, key) === p.image : !String(info[f] || "").trim()) miss.push(T("spec.f." + f));
    });
    return miss;
  }
  function supName(id) { var s = A.suppliers().filter(function (x) { return x.id === id; })[0]; return s ? s.company : "?"; }
  // The cheapest supplier of a specification (its own cost, else the supplier's default).
  function mainCost(p, key) {
    var best = null;
    (p.supplierLinks || []).forEach(function (l) {
      var c = key && l.variantCosts && l.variantCosts[key] != null ? l.variantCosts[key] : l.cost;
      if (c != null && (!best || c < best.cost)) best = { supplierId: l.supplierId, cost: c };
    });
    return best;
  }
  function clientsOf(p, key) {
    var refs = p.clientRefs || {}, infos = p.clientSpecs || {};
    return A.clients().filter(function (c) {
      return (refs[c.id] && Object.prototype.hasOwnProperty.call(refs[c.id], key)) || (infos[c.id] && infos[c.id][key]);
    }).map(function (c) { return { client: c, ref: (refs[c.id] || {})[key] || "", info: (infos[c.id] || {})[key] || {} }; });
  }
  function galleryHit(p, key) {
    var ids = String(key || "").split(",").filter(Boolean);
    var g = (p.gallery || []).filter(function (x) { return x.optionId && ids.indexOf(x.optionId) > -1; })[0];
    if (!g) return null;
    var label = "";
    attrsOf(p).forEach(function (a) { a.options.forEach(function (o) { if (o.id === g.optionId) label = attrName(a) + ": " + optLabel(o); }); });
    return { url: g.url, label: label };
  }
  function numText(n) { return n == null ? "" : /^(pt|es)$/.test(A.lang()) ? String(n).replace(".", ",") : String(n); }
  function money(v) { return v == null ? "—" : A.money(v, A.defaultCurrency()); }
  // Every option combination of the product (for the creation grid).
  function combos(p) {
    var out = [[]];
    attrsOf(p).forEach(function (a) {
      var next = [];
      out.forEach(function (c) { a.options.forEach(function (o) { next.push(c.concat(o.id)); }); });
      out = next;
    });
    return out.map(function (ids) { return ids.slice().sort().join(","); });
  }

  /* ---------- Editing state of one specification ---------- */
  function comState(p, key, explicit) {
    return {
      sup: (p.supplierLinks || []).map(function (l) {
        var own = key ? (l.variantCosts || {})[key] : l.cost;
        return { id: l.supplierId, cost: numText(own != null ? own : explicit ? (key ? l.cost : null) : null), base: key && !explicit ? l.cost : null };
      }),
      price: numText((p.listPrices || {})[key]), unlink: []
    };
  }
  function draftFor(p, key) {
    if (draft && draft.from === key) return draft;
    draft = Object.assign({ from: key, options: optionsOfKey(p, key), info: Object.assign({}, (p.specs || {})[key] || {}) }, comState(p, key, false));
    return draft;
  }
  function effCost(r) { var v = String(r.cost || "").trim(); return v ? A.parseDecimal(v) : r.base; }
  function principalId(d) {
    var best = null;
    d.sup.forEach(function (r) { var c = effCost(r); if (c != null && (best == null || c < best.c)) best = { id: r.id, c: c }; });
    return best ? best.id : null;
  }
  function badNumber(d) {
    var vals = d.sup.map(function (r) { return r.cost; }).concat([d.price]);
    return vals.filter(function (v) { return String(v || "").trim() && A.parseDecimal(v) == null; })[0];
  }

  /* ---------- Table ---------- */
  function rowsOf(p) {
    return allKeys(p).map(function (key) {
      var miss = missingOf(p, key), cl = clientsOf(p, key), main = mainCost(p, key);
      var price = (p.listPrices || {})[key];
      return {
        key: key, code: codeOf(p, key), archived: isArchived(p, key), miss: miss, clients: cl, main: main, price: price == null ? null : price,
        margin: price && main && main.cost != null ? (price - main.cost) / price : null,
        text: (codeOf(p, key) + " " + summary(p, key) + " " + cl.map(function (x) { return x.client.name + " " + x.ref + " " + (x.info.name || ""); }).join(" ")).toLowerCase()
      };
    });
  }
  function passes(r) {
    if (filter === "archived") { if (!r.archived) return false; }
    else {
      if (r.archived) return false;
      if (filter === "incomplete" && !r.miss.length) return false;
      if (filter === "noclient" && r.clients.length) return false;
    }
    return !query || query.split(/\s+/).every(function (t) { return r.text.indexOf(t) > -1; });
  }
  function rowHtml(p, r, clientCtx) {
    var status = r.archived ? '<span class="st-st st-st--arch">' + esc(T("spec.tagArchived")) + "</span>"
      : r.miss.length ? '<span class="st-st st-st--miss" title="' + esc(r.miss.join(", ")) + '">' + esc(T("st.missing", { list: r.miss.join(", ") })) + "</span>"
      : '<span class="st-st st-st--ok">' + esc(T("spec.tagOk")) + "</span>";
    var clientsTxt;
    if (clientCtx) {
      var x = r.clients.filter(function (c) { return c.client.id === clientCtx; })[0] || { info: {}, ref: "" };
      clientsTxt = (x.ref ? '<b class="st-ref">' + esc(x.ref) + "</b> " : "") + esc(x.info.name || "") +
        (x.info.supplierId ? '<small class="st-ccost">' + esc(money(x.info.cost) + " · " + supName(x.info.supplierId)) + "</small>" : "");
    } else {
      clientsTxt = r.clients.length ? r.clients.map(function (c) {
        return esc(c.client.name) + (c.info.supplierId && c.info.cost != null ? ' <small class="st-ccost">(' + esc(money(c.info.cost)) + ")</small>" : "");
      }).join(", ") : '<span class="muted">—</span>';
    }
    return '<button type="button" class="st-row' + (open === r.key ? " is-open" : "") + (r.archived ? " is-arch" : "") + '" data-open="' + esc(r.key) + '"' + (clientCtx ? ' data-tab="clients"' : "") + ">" +
      '<span class="st-img"><img src="' + esc(A.photoFor(p, r.key) || "") + '" alt="" loading="lazy" /></span>' +
      '<span class="st-code">' + esc(r.code) + "</span>" +
      '<span class="st-chips">' + chipsHtml(p, r.key) + "</span>" +
      '<span class="st-stc">' + status + "</span>" +
      '<span class="st-sup">' + (r.main ? "<b>" + esc(money(r.main.cost)) + "</b><small>" + esc(supName(r.main.supplierId)) + "</small>" : '<span class="st-warn">' + esc(T("st.noSupplier")) + "</span>") + "</span>" +
      '<span class="st-num" data-label="' + esc(T("spec.listPrice")) + '">' + esc(money(r.price)) + "</span>" +
      '<span class="st-num st-margin" data-label="' + esc(T("st.h.margin")) + '">' + (r.margin == null ? "—" : esc(Math.round(r.margin * 1000) / 10 + "%")) + "</span>" +
      '<span class="st-cl" data-label="' + esc(T(clientCtx ? "st.h.clientData" : "ptab.clients")) + '">' + clientsTxt + "</span></button>";
  }
  function tableHtml(p) {
    var rows = rowsOf(p);
    var count = function (f) { var keep = filter; filter = f; var q = query; query = ""; var n = rows.filter(passes).length; filter = keep; query = q; return n; };
    var shown = rows.filter(passes);
    var single = isSingle(p);
    var html = (flash ? '<p class="st-flash status is-' + flash.kind + '">' + esc(flash.msg) + "</p>" : "") +
      '<div class="st-tools">' +
        '<input type="search" id="st-q" placeholder="' + esc(T("st.search")) + '" value="' + esc(query) + '" aria-label="' + esc(T("st.search")) + '" />' +
        (single ? "" : ["active", "incomplete", "noclient", "archived"].map(function (f) {
          var n = count(f);
          if (f === "archived" && !n) return "";
          return '<button type="button" class="st-filter' + (filter === f ? " is-active" : "") + '" data-filter="' + f + '" aria-pressed="' + (filter === f) + '">' + esc(T("st.f." + f)) + " <b>" + n + "</b></button>";
        }).join("")) +
        '<span class="st-tools__end">' +
          (single ? "" : '<label class="st-group"><span>' + esc(T("st.groupBy")) + '</span><select id="st-group"><option value="">' + esc(T("st.groupNone")) + "</option>" +
            '<option value="client"' + (groupBy === "client" ? " selected" : "") + ">" + esc(T("cs.client")) + "</option>" +
            attrsOf(p).map(function (a) { return '<option value="' + esc(a.id) + '"' + (groupBy === a.id ? " selected" : "") + ">" + esc(attrName(a)) + "</option>"; }).join("") + "</select></label>" +
            '<button type="button" class="btn btn--outline btn--sm" data-wizard>' + esc(T("st.many")) + "</button>" +
            '<button type="button" class="btn btn--primary btn--sm" data-new>' + esc(T("st.new")) + "</button>") +
        "</span></div>";
    var head = '<div class="st-row st-head" aria-hidden="true"><span></span><span>' + esc(T("csh.code")) + "</span><span>" + esc(T("spec.attrs")) + "</span><span>" + esc(T("st.h.sheet")) +
      "</span><span>" + esc(T("csh.cost")) + "</span><span>" + esc(T("spec.listPrice")) + "</span><span>" + esc(T("st.h.margin")) + "</span><span>" + esc(T(groupBy === "client" ? "st.h.clientData" : "ptab.clients")) + "</span></div>";
    var body;
    if (!shown.length) body = '<p class="spec-empty">' + esc(T(rows.length ? "st.noneFilter" : "spec.none")) + "</p>";
    else if (groupBy === "client") {
      var groups = A.clients().map(function (c) {
        return { title: c.name, ctx: c.id, rows: shown.filter(function (r) { return r.clients.some(function (x) { return x.client.id === c.id; }); }) };
      }).filter(function (g) { return g.rows.length; });
      var free = shown.filter(function (r) { return !r.clients.length; });
      if (free.length) groups.push({ title: T("smode.noClient"), ctx: null, rows: free, free: true });
      body = groups.map(function (g) {
        return '<div class="st-ghead' + (g.free ? " st-ghead--free" : "") + '"><b>' + esc(g.title) + "</b><small>" + esc(T("cs.count", { n: g.rows.length })) + "</small></div>" +
          g.rows.map(function (r) { return rowHtml(p, r, g.ctx); }).join("");
      }).join("");
    } else if (groupBy) {
      var attr = attrsOf(p).filter(function (a) { return a.id === groupBy; })[0];
      body = attr ? attr.options.map(function (o) {
        var rs = shown.filter(function (r) { var x = optionOf(p, r.key, attr); return x && x.id === o.id; });
        return rs.length ? '<div class="st-ghead"><b>' + esc(attrName(attr) + ": " + optLabel(o)) + "</b><small>" + esc(T("cs.count", { n: rs.length })) + "</small></div>" +
          rs.map(function (r) { return rowHtml(p, r); }).join("") : "";
      }).join("") : "";
    } else body = shown.map(function (r) { return rowHtml(p, r); }).join("");
    return html + '<div class="st" role="list">' + head + body + "</div>" +
      (single ? '<p class="hint st-hint">' + esc(T("st.singleHint")) + "</p>" : '<p class="hint st-hint">' + esc(T("st.hint")) + "</p>");
  }

  /* ---------- Side panel ---------- */
  function drawerHtml(p) {
    var isNew = open === NEW;
    var key = isNew ? null : open;
    var d = isNew ? draft : draftFor(p, key);
    var single = isSingle(p);
    var arch = !isNew && isArchived(p, key);
    var photo = !isNew && (p.variantImages || {})[key];
    var hit = !isNew && !photo && galleryHit(p, key);
    var img = isNew ? p.image : A.photoFor(p, key);
    var tabs = (single ? [] : [["sheet", T("sd.sheet")]]).concat([["com", T("sd.com")]], isNew ? [] : [["clients", T("sd.clients", { n: clientsOf(p, key).length })]]);
    if (!tabs.some(function (t) { return t[0] === dtab; })) dtab = tabs[0][0];
    var title = isNew ? (d.copyOf != null ? T("spec.titleCopy", { code: codeOf(p, d.copyOf) }) : T("spec.titleNew")) : single ? String(p.sku || "") + " · " + T("spec.single") : codeOf(p, key);
    var miss = isNew ? [] : missingOf(p, key);
    var body = dtab === "sheet" ? sheetHtml(p, key, d, isNew, photo, hit) : dtab === "com" ? commercialHtml(p, d) : clientsHtml(p, key);
    return '<div class="sd-back" data-close></div>' +
      '<aside class="sd" role="dialog" aria-modal="true" aria-label="' + esc(title) + '">' +
        '<div class="sd-head"><img src="' + esc(img || "") + '" alt="" />' +
          '<div><b class="sd-title">' + esc(title) + "</b>" + (isNew ? "" : "<small>" + esc(summary(p, key)) + "</small>") +
          (hit ? '<small class="sd-gal">' + esc(T("spec.fromGallery", { opt: hit.label })) + "</small>" : "") + "</div>" +
          '<button type="button" class="sd-x" data-close aria-label="' + esc(T("sd.close")) + '">×</button></div>' +
        (arch ? '<p class="spec-banner spec-banner--arch sd-banner">' + esc(T("spec.archivedNote")) + "</p>" : "") +
        (!arch && miss.length ? '<p class="spec-banner sd-banner">' + esc(T("spec.missing", { fields: miss.join(", ") })) + "</p>" : "") +
        '<nav class="sd-tabs" role="tablist">' + tabs.map(function (t) {
          return '<button type="button" role="tab" class="sd-tab' + (dtab === t[0] ? " is-active" : "") + '" data-dtab="' + t[0] + '" aria-selected="' + (dtab === t[0]) + '">' + esc(t[1]) + "</button>";
        }).join("") + "</nav>" +
        '<div class="sd-body">' + body + "</div>" +
        '<div class="sd-foot"><p class="status" id="spec-status" role="status" aria-live="polite"></p>' +
          (isNew || single ? "" : '<span class="sd-actions"><button type="button" class="btn btn--outline btn--sm" data-spec-copy>' + esc(T("spec.duplicate")) + "</button>" +
            '<button type="button" class="btn btn--outline btn--sm" data-spec-archive>' + esc(T(arch ? "spec.restore" : "spec.archive")) + "</button>" +
            (arch ? '<button type="button" class="btn btn--outline btn--sm btn--danger-outline" data-spec-delete>' + esc(T("spec.delete")) + "</button>" : "") + "</span>") +
          (dtab === "clients" ? "" : (isNew ? '<button type="button" class="btn btn--outline" data-close>' + esc(T("form.cancel")) + "</button>" : "") +
            '<button type="button" class="btn btn--primary" data-spec-save>' + esc(T(isNew ? "spec.create" : "spec.save")) + "</button>") +
        "</div></aside>";
  }
  function sheetHtml(p, key, d, isNew, photo, hit) {
    var need = checklist(p), info = d.info || {};
    var f = function (name, label, wide, rows) {
      var req = need.indexOf(name) > -1, empty = req && !String(info[name] || "").trim();
      return '<label class="' + (wide ? "spec-f spec-f--wide" : "spec-f") + '"><span>' + esc(label) + (req ? " *" : "") + "</span>" +
        (rows ? '<textarea data-f="' + name + '" rows="' + rows + '" maxlength="2000" class="' + (empty ? "is-need" : "") + '">' + esc(info[name] || "") + "</textarea>"
          : '<input type="text" data-f="' + name + '" value="' + esc(info[name] || "") + '" class="' + (empty ? "is-need" : "") + '" />') + "</label>";
    };
    return '<div class="spec-block"><b>' + esc(T("spec.attrs")) + '</b><div class="spec-grid">' +
        attrsOf(p).map(function (a) {
          var v = d.options[a.id] || "";
          return '<label class="spec-f"><span>' + esc(attrName(a)) + ' *</span><select data-attr="' + esc(a.id) + '" class="' + (v ? "" : "is-need") + '"><option value="">' + esc(T("spec.choose")) + "</option>" +
            a.options.map(function (o) { return '<option value="' + esc(o.id) + '"' + (o.id === v ? " selected" : "") + ">" + esc(optLabel(o)) + "</option>"; }).join("") + "</select></label>";
        }).join("") + '</div><p class="hint">' + esc(T("spec.attrsHint")) + "</p></div>" +
      '<div class="spec-block">' + f("details", T("spec.f.details"), true, 4) +
        '<div class="spec-grid">' + f("weight", T("spec.f.weight")) + f("measures", T("spec.f.measures")) + f("packaging", T("spec.f.packaging")) + "</div></div>" +
      '<div class="spec-block"><b>' + esc(T("spec.f.photo")) + (need.indexOf("photo") > -1 ? " *" : "") + "</b>" +
        (isNew ? '<p class="hint">' + esc(T("spec.photoAfterSave")) + "</p>" :
          '<div class="spec-photo">' + (photo ? '<img src="' + esc(photo) + '" alt="" />' :
            hit ? '<img src="' + esc(hit.url) + '" alt="" /><span class="spec-photo__none">' + esc(T("spec.fromGallery", { opt: hit.label })) + "</span>"
              : '<span class="spec-photo__none">' + esc(T("spec.noPhoto")) + "</span>") +
          '<label class="btn btn--outline btn--sm fin-file-btn"><input type="file" accept="image/jpeg,image/png,image/webp" data-spec-photo hidden /><span>' + esc(T(photo ? "spec.changePhoto" : "sd.ownPhoto")) + "</span></label>" +
          (photo ? '<button type="button" class="linkbtn danger" data-spec-photo-del>' + esc(T("spec.removePhoto")) + "</button>" : "") + "</div>") + "</div>";
  }
  function commercialHtml(p, d) {
    var cur = A.defaultCurrency(), main = principalId(d);
    var used = d.sup.map(function (r) { return r.id; });
    var free = A.suppliers().filter(function (x) { return x.productSupplier !== false && used.indexOf(x.id) < 0; });
    var priceN = String(d.price || "").trim() ? A.parseDecimal(d.price) : null;
    var mainRow = d.sup.filter(function (r) { return r.id === main; })[0];
    var mc = mainRow ? effCost(mainRow) : null;
    return '<div class="spec-block"><b>' + esc(T("spec.commercial")) + '</b><div class="spec-sup">' +
      (d.sup.length ? d.sup.map(function (r) {
        return '<div class="spec-sup__row" data-sup="' + esc(r.id) + '"><span class="spec-sup__name">' + esc(supName(r.id)) + "</span>" +
          '<input type="text" inputmode="decimal" data-cost="' + esc(r.id) + '" value="' + esc(r.cost) + '" placeholder="' +
            esc(r.base != null ? T("spec.supBase", { v: A.money(r.base, cur) }) : T("spec.supCostPh")) + '" aria-label="' + esc(T("spec.supCost") + " · " + supName(r.id)) + '" />' +
          '<em class="spec-tag spec-tag--ok spec-sup__main"' + (r.id === main ? "" : " hidden") + ">" + esc(T("spec.supPrincipal")) + "</em>" +
          '<button type="button" class="icon-btn icon-btn--danger" data-unlink="' + esc(r.id) + '" title="' + esc(T("spec.supRemove")) + '" aria-label="' + esc(T("spec.supRemove")) + '">×</button></div>';
      }).join("") : '<p class="spec-empty">' + esc(T("spec.noSuppliers")) + "</p>") +
      (free.length ? '<select data-sup-add aria-label="' + esc(T("spec.supAdd")) + '"><option value="">' + esc(T("spec.supAdd")) + "</option>" +
        free.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.company) + "</option>"; }).join("") + "</select>" : "") +
      "</div></div>" +
      '<div class="spec-block"><b>' + esc(T("spec.listPrice")) + '</b><div class="sd-price">' +
        '<label class="spec-f"><span>' + esc(T("spec.listPrice")) + " (" + esc(cur) + ')</span><input type="text" inputmode="decimal" data-price value="' + esc(d.price) + '" /></label>' +
        '<span class="sd-margin" id="sd-margin">' + esc(marginText(priceN, mc)) + "</span></div>" +
      '<p class="hint">' + esc(T("spec.supHint")) + "</p></div>";
  }
  function marginText(price, cost) {
    if (price == null || cost == null || !price) return "";
    return T("sd.marginIs", { m: Math.round((price - cost) / price * 1000) / 10 + "%" });
  }
  function clientsHtml(p, key) {
    var list = clientsOf(p, key);
    var cards = list.map(function (x) {
      if (editingLink === x.client.id) return linkForm(p, x.client.id, key);
      var i = x.info;
      var sample = i.sample ? '<span class="spec-tag spec-tag--' + (i.sample === "approved" ? "ok" : i.sample === "pending" ? "miss" : "arch") + '">' + esc(T("cs.sample") + " " + T("cs.sample." + i.sample)) +
        (i.sampleDate ? " " + esc(new Date(i.sampleDate + "T00:00:00").toLocaleDateString(A.locale())) : "") + "</span>" : "";
      return '<div class="sd-card"><div class="sd-card__head"><b>' + esc(x.client.name) + "</b>" + sample + "</div>" +
        '<dl class="sd-card__grid">' +
          "<div><dt>" + esc(T("cs.ref")) + "</dt><dd>" + (x.ref ? '<span class="crm-ref">' + esc(x.ref) + "</span>" : "—") + "</dd></div>" +
          "<div><dt>" + esc(T("cs.name")) + "</dt><dd>" + esc(i.name || "—") + "</dd></div>" +
          "<div><dt>" + esc(T("csh.cost")) + "</dt><dd>" + (i.supplierId ? '<b class="st-ccost">' + esc(money(i.cost)) + "</b> · " + esc(supName(i.supplierId)) : '<span class="muted">' + esc(T("cs.costDefault")) + "</span>") + "</dd></div>" +
          "<div><dt>" + esc(T("cs.requirements")) + "</dt><dd>" + esc(i.requirements || "—") + "</dd></div>" +
        "</dl>" +
        '<div class="sd-card__actions"><button type="button" class="linkbtn" data-cs-edit="' + esc(x.client.id) + '">' + esc(T("list.edit")) + "</button>" +
          '<button type="button" class="linkbtn danger" data-cs-del="' + esc(x.client.id) + '">' + esc(T("cs.unlink")) + "</button></div></div>";
    }).join("");
    return (cards || (editingLink === "new" ? "" : '<p class="spec-empty">' + esc(T("spec.noClient")) + "</p>")) +
      (editingLink === "new" ? linkForm(p, null, key) : '<button type="button" class="btn btn--outline btn--sm sd-add" data-cs-new>' + esc(T("smode.linkClient")) + "</button>") +
      '<p class="status" id="cs-status" role="status" aria-live="polite"></p>';
  }
  function linkForm(p, clientId, key) {
    var isNew = clientId == null;
    var i = isNew ? {} : ((p.clientSpecs || {})[clientId] || {})[key] || {};
    var ref = isNew ? "" : ((p.clientRefs || {})[clientId] || {})[key] || "";
    var linked = clientsOf(p, key).map(function (x) { return x.client.id; });
    return '<form class="cs-form sd-form" data-cs-form>' +
      '<div class="spec-grid">' +
        (isNew ? '<label class="spec-f spec-f--wide"><span>' + esc(T("cs.client")) + ' *</span><select name="clientId"><option value="">' + esc(T("spec.choose")) + "</option>" +
          A.clients().filter(function (c) { return linked.indexOf(c.id) < 0; }).map(function (c) { return '<option value="' + esc(c.id) + '">' + esc(c.name) + "</option>"; }).join("") + "</select></label>"
          : '<input type="hidden" name="clientId" value="' + esc(clientId) + '" /><b class="spec-f--wide sd-form__client">' + esc((A.clients().filter(function (c) { return c.id === clientId; })[0] || {}).name || "") + "</b>") +
        '<label class="spec-f"><span>' + esc(T("cs.ref")) + '</span><input type="text" name="ref" maxlength="60" value="' + esc(ref) + '" /></label>' +
        '<label class="spec-f spec-f--wide2"><span>' + esc(T("cs.name")) + '</span><input type="text" name="name" maxlength="160" value="' + esc(i.name || "") + '" /></label>' +
        '<label class="spec-f spec-f--wide"><span>' + esc(T("cs.requirements")) + '</span><input type="text" name="requirements" maxlength="1000" value="' + esc(i.requirements || "") + '" placeholder="' + esc(T("cs.requirementsPh")) + '" /></label>' +
        '<label class="spec-f spec-f--wide2"><span>' + esc(T("cs.supplier")) + '</span><select name="supplierId"><option value="">' + esc(T("cs.supplierDefault")) + "</option>" +
          A.suppliers().filter(function (x) { return x.productSupplier !== false; }).map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === i.supplierId ? " selected" : "") + ">" + esc(x.company) + "</option>"; }).join("") + "</select></label>" +
        '<label class="spec-f"><span>' + esc(T("cs.cost")) + " (" + esc(A.defaultCurrency()) + ')</span><input type="text" inputmode="decimal" name="cost" value="' + esc(i.cost == null ? "" : numText(i.cost)) + '" /></label>' +
        '<label class="spec-f"><span>' + esc(T("cs.sample")) + '</span><select name="sample"><option value="">—</option>' +
          ["approved", "pending", "rejected"].map(function (s) { return '<option value="' + s + '"' + (i.sample === s ? " selected" : "") + ">" + esc(T("cs.sample." + s)) + "</option>"; }).join("") + "</select></label>" +
        '<label class="spec-f"><span>' + esc(T("cs.sampleDate")) + '</span><input type="date" name="sampleDate" value="' + esc(i.sampleDate || "") + '" /></label>' +
      '</div><div class="spec-edit__foot"><button type="button" class="btn btn--outline btn--sm" data-cs-cancel>' + esc(T("form.cancel")) + "</button>" +
        '<button type="submit" class="btn btn--primary btn--sm">' + esc(T("spec.save")) + "</button></div></form>";
  }

  /* ---------- Creating several at once ---------- */
  function wizardHtml(p, firstTime) {
    var existing = {};
    allKeys(p).forEach(function (k) { existing[k] = true; });
    var attrs = attrsOf(p), all = combos(p), w = wizard;
    var n = Object.keys(w.checked).filter(function (k) { return w.checked[k] && !existing[k]; }).length;
    var cell = function (key, label) {
      if (existing[key]) return '<span class="wz-cell is-done">' + esc(codeOf(p, key)) + (label ? " · " + esc(label) : "") + "</span>";
      return '<label class="wz-cell' + (w.checked[key] ? " is-on" : "") + '"><input type="checkbox" data-wz="' + esc(key) + '"' + (w.checked[key] ? " checked" : "") + " /> " + esc(label || T("wz.create")) + "</label>";
    };
    var grid;
    if (attrs.length === 2) {
      var a = attrs[0], b = attrs[1];
      grid = '<div class="wz-grid" style="grid-template-columns: minmax(120px, 180px) repeat(' + b.options.length + ', minmax(110px, 1fr))">' +
        '<span class="wz-corner">' + esc(attrName(a)) + " ↓ · " + esc(attrName(b)) + " →</span>" +
        b.options.map(function (o) { return '<b class="wz-colh">' + esc(optLabel(o)) + "</b>"; }).join("") +
        a.options.map(function (oa) {
          return '<b class="wz-rowh">' + esc(optLabel(oa)) + "</b>" + b.options.map(function (ob) { return cell([oa.id, ob.id].sort().join(","), ""); }).join("");
        }).join("") + "</div>";
    } else {
      var shownCombos = all.slice(0, 400);
      grid = '<div class="wz-list">' + shownCombos.map(function (key) { return cell(key, summary(p, key)); }).join("") + "</div>" +
        (all.length > 400 ? '<p class="hint">' + esc(T("wz.tooMany", { n: all.length })) + "</p>" : "");
    }
    return (firstTime ? '<ol class="wiz-steps"><li class="is-done">' + esc(T("wiz.s1")) + '</li><li class="is-done">' + esc(T("wiz.s2")) + '</li><li class="is-on">' + esc(T("wiz.s3")) + "</li></ol>" : "") +
      '<section class="wz">' +
        '<div><b class="wz-title">' + esc(T("wz.title")) + '</b><p class="hint wz-hint">' + esc(T("wz.hint")) + "</p></div>" +
        '<div class="wz-quick"><button type="button" class="linkbtn" data-wz-all>' + esc(T("wz.all")) + '</button><button type="button" class="linkbtn" data-wz-none>' + esc(T("wz.none")) + "</button></div>" +
        grid +
        '<div class="wz-com"><label class="spec-f"><span>' + esc(T("wz.supplier")) + '</span><select id="wz-sup"><option value="">—</option>' +
          A.suppliers().filter(function (x) { return x.productSupplier !== false; }).map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.id === w.supplierId ? " selected" : "") + ">" + esc(x.company) + "</option>"; }).join("") + "</select></label>" +
          '<label class="spec-f"><span>' + esc(T("wz.cost")) + " (" + esc(A.defaultCurrency()) + ')</span><input type="text" inputmode="decimal" id="wz-cost" value="' + esc(w.cost || "") + '" placeholder="' + esc(T("wz.later")) + '" /></label>' +
          '<label class="spec-f"><span>' + esc(T("spec.listPrice")) + " (" + esc(A.defaultCurrency()) + ')</span><input type="text" inputmode="decimal" id="wz-price" value="' + esc(w.price || "") + '" placeholder="' + esc(T("wz.later")) + '" /></label></div>' +
        '<div class="wz-foot"><p class="status" id="wz-status" role="status" aria-live="polite"></p>' +
          (firstTime ? '<button type="button" class="btn btn--outline" data-wz-skip>' + esc(T("wz.skip")) + "</button>" : '<button type="button" class="btn btn--outline" data-wz-cancel>' + esc(T("form.cancel")) + "</button>") +
          '<button type="button" class="btn btn--primary" data-wz-go' + (n ? "" : " disabled") + ">" + esc(T("wz.go", { n: n })) + "</button></div>" +
      "</section>";
  }
  function runWizard() {
    var p = product(), w = wizard;
    if (!p || !w) return;
    var keys = Object.keys(w.checked).filter(function (k) { return w.checked[k] && !Object.prototype.hasOwnProperty.call(p.variantSkus || {}, k); });
    var cost = String(w.cost || "").trim(), price = String(w.price || "").trim();
    var st = function (m, k) { var el = $("#wz-status"); if (el) { el.textContent = m; el.className = "status" + (k ? " is-" + k : ""); } };
    if ((cost && A.parseDecimal(cost) == null) || (price && A.parseDecimal(price) == null)) return st(T("status.badPrice", { value: cost || price }), "error");
    if (cost && !w.supplierId) return st(T("cs.needSupplier"), "error");
    var btn = $("[data-wz-go]"); if (btn) btn.disabled = true;
    var made = [];
    keys.reduce(function (chain, key, i) {
      return chain.then(function () {
        st(T("wz.creating", { n: i + 1, total: keys.length }));
        var ids = key.split(","), options = {};
        attrsOf(product()).forEach(function (a) { a.options.forEach(function (o) { if (ids.indexOf(o.id) > -1) options[a.id] = o.id; }); });
        return A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=spec", { method: "POST", body: { options: options, info: {}, skipChecklist: true } })
          .then(function (r) { A.replaceProducts([r.product]); made.push(r.key); });
      });
    }, Promise.resolve()).then(function () {
      if (!made.length || (!w.supplierId && !price)) return;
      var changes = made.map(function (key) {
        var c = { productId: p.id, key: key };
        if (w.supplierId) { c.costs = {}; c.costs[w.supplierId] = cost ? A.parseDecimal(cost) : null; }
        if (price) c.price = A.parseDecimal(price);
        return c;
      });
      return A.api("/api/products?action=pricing", { method: "POST", body: { changes: changes } }).then(function (r) { A.replaceProducts(r.products || []); });
    }).then(function () {
      wizard = null; filter = "active";
      flash = { kind: "ok", msg: T("wz.done", { n: made.length }) };
      render();
    }, function (err) {
      if (btn) btn.disabled = false;
      st((made.length ? T("wz.partial", { n: made.length }) + " " : "") + err.message, "error");
    });
  }

  /* ---------- Saving ---------- */
  function setSpecStatus(msg, kind) { var el = $("#spec-status"); if (!el) return; el.textContent = msg || ""; el.className = "status" + (kind ? " is-" + kind : ""); }
  function pricingChange(p, key, d) {
    var costs = {};
    d.sup.forEach(function (r) { costs[r.id] = String(r.cost || "").trim() ? A.parseDecimal(r.cost) : null; });
    var change = { productId: p.id, key: key, costs: costs, price: String(d.price || "").trim() ? A.parseDecimal(d.price) : null };
    if (d.unlink.length) change.unlink = d.unlink.slice();
    return A.api("/api/products?action=pricing", { method: "POST", body: { changes: [change] } }).then(function (r) {
      A.replaceProducts(r.products || []);
      d.comDirty = false; d.unlink = [];
    });
  }
  function saveSpec(extra) {
    var p = product();
    if (!p || !draft) return;
    var d = draft, isNew = open === NEW, single = isSingle(p);
    var bad = !extra && badNumber(d);
    if (bad) return setSpecStatus(T("status.badPrice", { value: bad }), "error");
    var btn = $("[data-spec-save]");
    if (btn) btn.disabled = true;
    setSpecStatus("…");
    var key = isNew ? null : open;
    var step = Promise.resolve();
    if (!extra && !isNew && d.comDirty) step = step.then(function () { return pricingChange(p, key, d); });
    if (!single && (extra || isNew || d.specDirty)) step = step.then(function () {
      var body = { options: d.options, info: d.info };
      if (!isNew) body.key = key;
      if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
      return A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=spec", { method: "POST", body: body }).then(function (r) {
        A.replaceProducts([r.product]); key = r.key; d.specDirty = false;
      });
    });
    if (!extra && isNew) step = step.then(function () { if (d.comDirty || d.sup.length) return pricingChange(product(), key, d); });
    step.then(function () {
      var q = product();
      open = key; draft = null;
      render();
      setSpecStatus(T(extra && "archived" in extra ? (extra.archived ? "spec.archivedOk" : "spec.restoredOk") : isNew ? "spec.created" : "spec.saved", { code: codeOf(q, key) }), "ok");
    }, function (err) {
      if (btn) btn.disabled = false;
      var data = err.data || {};
      if (data.error === "Checklist incomplete") { dtab = "sheet"; render(); setSpecStatus(T("spec.needFields", { fields: (data.fields || []).map(function (f) { return T("spec.f." + f); }).join(", ") }), "error"); }
      else if (data.error === "Missing characteristics") setSpecStatus(T("spec.needAttrs", { attrs: (data.missing || []).join(", ") }), "error");
      else if (data.error === "Specification exists") setSpecStatus(T("spec.exists", { code: data.code }), "error");
      else setSpecStatus(err.message, "error");
    });
  }
  function sendLink(body) {
    var p = product();
    return A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=clientSpec", { method: "POST", body: body })
      .then(function (d) {
        A.replaceProducts([d.product]); editingLink = null; render();
        var el = $("#cs-status"); if (el) { el.textContent = T(body.remove ? "cs.unlinked" : "cs.saved"); el.className = "status is-ok"; }
      }, function (err) { var el = $("#cs-status"); if (el) { el.textContent = err.message; el.className = "status is-error"; } });
  }
  function closeDrawer() { open = null; draft = null; editingLink = null; render(); }

  /* ---------- Events ---------- */
  var pane = $("#specs-pane");
  pane.addEventListener("click", function (e) {
    var p = product();
    if (!p) return;
    var t = e.target;
    if (t.closest("[data-close]")) return closeDrawer();
    var f = t.closest("[data-filter]");
    if (f) { filter = f.getAttribute("data-filter"); flash = null; return render(); }
    var row = t.closest("[data-open]");
    if (row) { open = row.getAttribute("data-open"); draft = null; editingLink = null; dtab = row.getAttribute("data-tab") || (isSingle(p) ? "com" : "sheet"); flash = null; return render(); }
    if (t.closest("[data-new]")) {
      open = NEW; dtab = "sheet"; editingLink = null; flash = null;
      draft = Object.assign({ options: {}, info: {} }, comState(p, "", false));
      draft.sup.forEach(function (r) { r.cost = ""; r.base = null; });
      draft.price = "";
      return render();
    }
    if (t.closest("[data-wizard]")) { wizard = { checked: {}, supplierId: "", cost: "", price: "" }; open = null; flash = null; return render(); }
    if (t.closest("[data-wz-cancel]") || t.closest("[data-wz-skip]")) { wizard = null; if (t.closest("[data-wz-skip]")) wizardSkipped[p.id] = true; return render(); }
    if (t.closest("[data-wz-all]") || t.closest("[data-wz-none]")) {
      var on = Boolean(t.closest("[data-wz-all]"));
      combos(p).forEach(function (k) { wizard.checked[k] = on; });
      return render();
    }
    if (t.closest("[data-wz-go]")) return runWizard();
    var dt = t.closest("[data-dtab]");
    if (dt) { dtab = dt.getAttribute("data-dtab"); editingLink = null; return render(); }
    if (t.closest("[data-spec-save]")) return saveSpec();
    if (t.closest("[data-spec-copy]")) {
      var from = open;
      draft = Object.assign({ options: optionsOfKey(p, from), info: Object.assign({}, (p.specs || {})[from] || {}), copyOf: from }, comState(p, from, true));
      draft.comDirty = true;
      delete draft.info.archived; delete draft.info.archivedBy;
      open = NEW; dtab = "sheet";
      render();
      return setSpecStatus(T("spec.copyHint"), "ok");
    }
    if (t.closest("[data-spec-archive]")) {
      var arch = isArchived(p, open);
      if (!arch && !confirm(T("spec.archiveConfirm"))) return;
      draftFor(p, open);
      return saveSpec({ archived: !arch });
    }
    if (t.closest("[data-spec-delete]")) {
      var code = codeOf(p, open);
      if (!confirm(T("spec.deleteConfirm", { code: code }))) return;
      setSpecStatus("…");
      return A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=spec", { method: "POST", body: { key: open, remove: true } })
        .then(function (d) { A.replaceProducts([d.product]); open = null; draft = null; flash = { kind: "ok", msg: T("spec.deleted", { code: code }) }; render(); },
          function (err) { var data = err.data || {}; setSpecStatus(data.error === "Specification in use" ? T("spec.inUse", { number: data.number }) : err.message, "error"); });
    }
    if (t.closest("[data-spec-photo-del]")) {
      if (!confirm(T("form.variantPhotoRemove") + "?")) return;
      return A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=variantImage", { method: "POST", body: { key: open, remove: true } })
        .then(function (d) { A.replaceProducts([d.product]); render(); }, function (err) { setSpecStatus(err.message, "error"); });
    }
    var un = t.closest("[data-unlink]");
    if (un && draft) {
      var sid = un.getAttribute("data-unlink");
      if (!confirm(T("spec.supRemoveConfirm", { name: supName(sid) }))) return;
      draft.sup = draft.sup.filter(function (r) { return r.id !== sid; });
      if ((p.supplierLinks || []).some(function (l) { return l.supplierId === sid; })) draft.unlink.push(sid);
      draft.comDirty = true;
      return render();
    }
    if (t.closest("[data-cs-new]")) { editingLink = "new"; return render(); }
    if (t.closest("[data-cs-cancel]")) { editingLink = null; return render(); }
    var ed = t.closest("[data-cs-edit]");
    if (ed) { editingLink = ed.getAttribute("data-cs-edit"); return render(); }
    var del = t.closest("[data-cs-del]");
    if (del && confirm(T("cs.unlinkConfirm"))) sendLink({ clientId: del.getAttribute("data-cs-del"), key: open, remove: true });
  });
  pane.addEventListener("change", function (e) {
    var t = e.target;
    if (t.id === "st-group") { groupBy = t.value; return render(); }
    if (t.matches("[data-wz]")) { wizard.checked[t.getAttribute("data-wz")] = t.checked; return render(); }
    if (t.id === "wz-sup") { wizard.supplierId = t.value; return; }
    var a = t.getAttribute("data-attr");
    if (a && draft) { draft.options[a] = t.value; draft.specDirty = true; t.classList.toggle("is-need", !t.value); return; }
    if (t.matches("[data-sup-add]") && draft && t.value) {
      var sid = t.value;
      draft.unlink = draft.unlink.filter(function (x) { return x !== sid; });
      draft.sup.push({ id: sid, cost: "", base: null });
      draft.comDirty = true;
      return render();
    }
    if (t.matches("[data-spec-photo]")) {
      var p = product(), file = t.files[0];
      t.value = "";
      if (!file) return;
      setSpecStatus("…");
      A.squareImage(file).then(function (data) {
        return A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=variantImage", { method: "POST", body: { key: open, image: data } });
      }).then(function (d) { A.replaceProducts([d.product]); render(); setSpecStatus(T("spec.photoOk"), "ok"); }, function (err) { setSpecStatus(err.message, "error"); });
    }
  });
  pane.addEventListener("input", function (e) {
    var t = e.target;
    if (t.id === "st-q") {
      query = t.value.trim().toLowerCase();
      var pos = t.selectionStart;
      render();
      var q = $("#st-q"); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
      return;
    }
    if (t.id === "wz-cost") { wizard.cost = t.value; return; }
    if (t.id === "wz-price") { wizard.price = t.value; return; }
    var f = t.getAttribute("data-f");
    if (f && draft) { draft.info[f] = t.value; draft.specDirty = true; t.classList.remove("is-need"); return; }
    var c = t.getAttribute("data-cost");
    if (c && draft) {
      draft.sup.forEach(function (r) { if (r.id === c) r.cost = t.value; });
      draft.comDirty = true;
      var main = principalId(draft);
      document.querySelectorAll("#specs-pane .spec-sup__row").forEach(function (row) { row.querySelector(".spec-sup__main").hidden = row.getAttribute("data-sup") !== main; });
      updateMargin();
      return;
    }
    if (t.hasAttribute("data-price") && draft) { draft.price = t.value; draft.comDirty = true; updateMargin(); }
  });
  function updateMargin() {
    var el = $("#sd-margin");
    if (!el || !draft) return;
    var main = principalId(draft), row = draft.sup.filter(function (r) { return r.id === main; })[0];
    el.textContent = marginText(String(draft.price || "").trim() ? A.parseDecimal(draft.price) : null, row ? effCost(row) : null);
  }
  pane.addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var clientId = f.elements.clientId.value;
    var err = function (m) { var el = $("#cs-status"); if (el) { el.textContent = m; el.className = "status is-error"; } };
    if (!clientId) return err(T("cs.needClient"));
    var sid = f.elements.supplierId.value, costTxt = String(f.elements.cost.value || "").trim();
    if (costTxt && !sid) return err(T("cs.needSupplier"));
    if (costTxt && A.parseDecimal(costTxt) == null) return err(T("status.badPrice", { value: costTxt }));
    sendLink({ clientId: clientId, key: open, ref: f.elements.ref.value, name: f.elements.name.value, requirements: f.elements.requirements.value,
      sample: f.elements.sample.value, sampleDate: f.elements.sampleDate.value, supplierId: sid, cost: costTxt ? A.parseDecimal(costTxt) : null });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && open != null && !$("#specs-pane").hidden) closeDrawer();
  });

  /* ---------- Wiring ---------- */
  var wizardSkipped = {};
  function render() {
    var p = product();
    if (!p) return;
    $("#ptab-specs-count").textContent = allKeys(p).filter(function (k) { return !isArchived(p, k); }).length;
    var tab = document.querySelector("#ptabs [data-ptab].is-active");
    if (!tab || tab.getAttribute("data-ptab") !== "specs") return;
    if (open != null && open !== NEW && allKeys(p).indexOf(open) < 0) { open = null; draft = null; }
    var firstTime = !isSingle(p) && !allKeys(p).length && !wizardSkipped[p.id];
    if (firstTime && !wizard) wizard = { checked: {}, supplierId: "", cost: "", price: "" };
    var html = wizard ? wizardHtml(p, firstTime) : tableHtml(p);
    if (open != null && !wizard) html += drawerHtml(p);
    $("#specs-body").innerHTML = html;
    document.body.classList.toggle("has-drawer", open != null && !wizard);
  }
  document.addEventListener("admin:ptab", function (e) {
    if (!e.detail.productId) return;
    if (e.detail.tab !== "specs") { open = null; draft = null; document.body.classList.remove("has-drawer"); }
    render();
  });
  document.addEventListener("admin:product-open", function () {
    open = null; draft = null; editingLink = null; wizard = null; filter = "active"; groupBy = ""; query = ""; flash = null;
    render();
  });
  document.addEventListener("admin:lang", function () { if (product()) render(); });
  document.addEventListener("admin:data", function () { if (product()) render(); });
})();
