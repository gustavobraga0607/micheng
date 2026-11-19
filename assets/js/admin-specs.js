/* Product page: the "Especificações" tab (each exact model of the product, with
   its characteristics, technical details, photo and the category's mandatory
   fields) and the "Clientes" tab (which client buys which specification, with
   the client's code, name for it, requirements and approved sample). */
(function () {
  "use strict";

  var A = window.Admin;
  var $ = function (s) { return document.querySelector(s); };
  var T = function (k, v) { return A.T(k, v); };
  var esc = function (s) { return A.escapeHtml(s); };

  var FIELDS = ["details", "weight", "measures", "packaging", "perBox"];
  var DEFAULT_CHECKLIST = ["details", "packaging"];
  var current = null;     // key of the specification open ("" = new)
  var draft = null;       // { options: {attrId: optId}, info: {...}, from: key|null }
  var showArchived = false;
  var editingLink = null; // client link being edited: { clientId, key } or "new"

  function product() { var id = A.openProductId(); return id ? A.products().filter(function (p) { return p.id === id; })[0] : null; }
  function attrsOf(p) { return (p.attributes || []).filter(function (a) { return a.options.length; }); }
  function pick(o) { var l = A.lang(); return (o && (o[l] || o.en || o.pt)) || ""; }
  function attrName(a) { return pick(a.name) || a.source; }
  function optLabel(o) { return pick(o.label) || o.source; }
  function checklist(p) {
    var c = (A.settings() || {}).checklist;
    return c && Array.isArray(c[p.category]) ? c[p.category] : DEFAULT_CHECKLIST;
  }
  function codeOf(p, key) { var n = (p.variantSkus || {})[key]; return n ? p.sku + "-" + n : String(p.sku || ""); }
  function optionsOfKey(p, key) {
    var ids = key ? key.split(",") : [], out = {};
    attrsOf(p).forEach(function (a) { var o = a.options.filter(function (x) { return ids.indexOf(x.id) > -1; })[0]; if (o) out[a.id] = o.id; });
    return out;
  }
  function summary(p, key) {
    var ids = key ? key.split(",") : [];
    return attrsOf(p).map(function (a) {
      var o = a.options.filter(function (x) { return ids.indexOf(x.id) > -1; })[0];
      return o ? attrName(a) + ": " + optLabel(o) : "";
    }).filter(Boolean).join(" · ");
  }
  // What a specification still lacks: characteristics without a value (the product's
  // characteristics changed) and the category's mandatory fields.
  function missingOf(p, key) {
    var info = (p.specs || {})[key] || {};
    var opts = optionsOfKey(p, key);
    var miss = attrsOf(p).filter(function (a) { return !opts[a.id]; }).map(attrName);
    checklist(p).forEach(function (f) {
      if (f === "photo" ? !((p.variantImages || {})[key]) : !String(info[f] || "").trim()) miss.push(T("spec.f." + f));
    });
    return miss;
  }
  function clientsOfKey(p, key) {
    var names = [];
    var refs = p.clientRefs || {}, infos = p.clientSpecs || {};
    A.clients().forEach(function (c) {
      var has = (refs[c.id] && Object.prototype.hasOwnProperty.call(refs[c.id], key)) || (infos[c.id] && infos[c.id][key]);
      if (has) names.push(c.name + (refs[c.id] && refs[c.id][key] ? " (" + refs[c.id][key] + ")" : ""));
    });
    return names;
  }
  function specKeys(p, withArchived) { return A.variantCodes(p, withArchived).map(function (v) { return v.key; }); }

  /* ---------- Especificações ---------- */
  function renderSpecs() {
    var p = product();
    var box = $("#specs-pane");
    if (!p) { box.innerHTML = ""; return; }
    var attrs = attrsOf(p);
    var all = specKeys(p, true), active = specKeys(p, false);
    $("#ptab-specs-count").textContent = active.length;
    if (!attrs.length) {
      box.innerHTML = '<p class="spec-empty">' + esc(T("spec.noAttrs")) + "</p>";
      return;
    }
    var archived = all.length - active.length;
    var list = (showArchived ? all : active).map(function (key) {
      var miss = missingOf(p, key), arch = (p.specs || {})[key] && p.specs[key].archived;
      var tag = arch ? ["arch", T("spec.tagArchived")] : miss.length ? ["miss", T("spec.tagMissing", { n: miss.length })] : ["ok", T("spec.tagOk")];
      var cl = clientsOfKey(p, key);
      return '<button type="button" class="spec-li' + (current === key ? " is-active" : "") + '" data-spec="' + esc(key) + '">' +
        '<span class="spec-li__code">' + esc(codeOf(p, key)) + "</span>" +
        '<span class="spec-li__txt"><span>' + esc(summary(p, key) || "—") + "</span><small>" + esc(cl.length ? cl.join(" · ") : T("spec.noClient")) + "</small></span>" +
        '<span class="spec-tag spec-tag--' + tag[0] + '">' + esc(tag[1]) + "</span></button>";
    }).join("");
    box.innerHTML = '<div class="spec-layout">' +
      '<section class="spec-list"><div class="spec-list__tools"><input type="search" id="spec-q" placeholder="' + esc(T("spec.search")) + '" />' +
        '<button type="button" class="btn btn--primary btn--sm" data-spec-new>' + esc(T("spec.new")) + "</button></div>" +
        '<div class="spec-list__items" id="spec-items">' + (list || '<p class="spec-empty">' + esc(T("spec.none")) + "</p>") + "</div>" +
        (archived ? '<label class="check spec-list__arch"><input type="checkbox" id="spec-arch"' + (showArchived ? " checked" : "") + " /> " + esc(T("spec.showArchived", { n: archived })) + "</label>" : "") +
        '<p class="hint spec-hint">' + esc(T("spec.listHint")) + "</p></section>" +
      '<section class="spec-edit" id="spec-edit">' + editorHtml(p) + "</section></div>";
    var q = $("#spec-q");
    if (q) q.addEventListener("input", filterList);
  }
  function filterList() {
    var q = String($("#spec-q").value || "").toLowerCase();
    document.querySelectorAll("#spec-items .spec-li").forEach(function (b) { b.hidden = q && b.textContent.toLowerCase().indexOf(q) < 0; });
  }

  function editorHtml(p) {
    if (current == null && !draft) return '<p class="spec-empty">' + esc(T("spec.pick")) + "</p>";
    var key = current;
    var isNew = draft && draft.from === undefined;
    var d = draft || { from: key, options: optionsOfKey(p, key), info: Object.assign({}, (p.specs || {})[key] || {}) };
    draft = d;
    var need = checklist(p);
    var info = d.info || {};
    var arch = !isNew && (p.specs || {})[key] && p.specs[key].archived;
    var miss = isNew ? [] : missingOf(p, key);
    var title = isNew ? (d.copyOf != null ? T("spec.titleCopy", { code: codeOf(p, d.copyOf) }) : T("spec.titleNew")) : codeOf(p, key);
    var photo = !isNew && (p.variantImages || {})[key];
    var costs = (p.supplierLinks || []).map(function (l) {
      var c = !isNew && l.variantCosts && l.variantCosts[key] != null ? l.variantCosts[key] : l.cost;
      var s = A.suppliers().filter(function (x) { return x.id === l.supplierId; })[0];
      return { name: s ? s.company : "?", cost: c };
    });
    var list = !isNew && p.listPrices ? p.listPrices[key] : null;
    var f = function (name, label, wide, rows) {
      var req = need.indexOf(name) > -1;
      var empty = req && !String(info[name] || "").trim();
      return '<label class="' + (wide ? "spec-f spec-f--wide" : "spec-f") + '"><span>' + esc(label) + (req ? " *" : "") + "</span>" +
        (rows ? '<textarea data-f="' + name + '" rows="' + rows + '" maxlength="2000" class="' + (empty ? "is-need" : "") + '">' + esc(info[name] || "") + "</textarea>"
          : '<input type="text" data-f="' + name + '" value="' + esc(info[name] || "") + '" class="' + (empty ? "is-need" : "") + '" />') + "</label>";
    };
    return '<div class="spec-edit__head"><div><h3>' + esc(title) + "</h3>" +
        (isNew ? "" : "<small>" + esc(summary(p, key)) + "</small>") + "</div>" +
        '<div class="spec-edit__actions">' + (isNew ? "" :
          '<button type="button" class="btn btn--outline btn--sm" data-spec-copy>' + esc(T("spec.duplicate")) + "</button>" +
          '<button type="button" class="btn btn--outline btn--sm" data-spec-archive>' + esc(T(arch ? "spec.restore" : "spec.archive")) + "</button>") + "</div></div>" +
      (arch ? '<p class="spec-banner spec-banner--arch">' + esc(T("spec.archivedNote")) + "</p>" : "") +
      (!isNew && miss.length && !arch ? '<p class="spec-banner">' + esc(T("spec.missing", { fields: miss.join(", ") })) + "</p>" : "") +
      '<div class="spec-block"><b>' + esc(T("spec.attrs")) + '</b><div class="spec-grid">' +
        attrsOf(p).map(function (a) {
          var v = d.options[a.id] || "";
          return '<label class="spec-f"><span>' + esc(attrName(a)) + ' *</span><select data-attr="' + esc(a.id) + '" class="' + (v ? "" : "is-need") + '"><option value="">' + esc(T("spec.choose")) + "</option>" +
            a.options.map(function (o) { return '<option value="' + esc(o.id) + '"' + (o.id === v ? " selected" : "") + ">" + esc(optLabel(o)) + "</option>"; }).join("") + "</select></label>";
        }).join("") + '</div><p class="hint">' + esc(T("spec.attrsHint")) + "</p></div>" +
      '<div class="spec-block">' + f("details", T("spec.f.details"), true, 3) +
        '<div class="spec-grid spec-grid--4">' + f("weight", T("spec.f.weight")) + f("measures", T("spec.f.measures")) + f("packaging", T("spec.f.packaging")) + f("perBox", T("spec.f.perBox")) + "</div></div>" +
      '<div class="spec-block"><b>' + esc(T("spec.f.photo")) + (need.indexOf("photo") > -1 ? " *" : "") + "</b>" +
        (isNew ? '<p class="hint">' + esc(T("spec.photoAfterSave")) + "</p>" :
          '<div class="spec-photo">' + (photo ? '<img src="' + esc(photo) + '" alt="" />' : '<span class="spec-photo__none">' + esc(T("spec.noPhoto")) + "</span>") +
          '<label class="btn btn--outline btn--sm fin-file-btn"><input type="file" accept="image/jpeg,image/png,image/webp" data-spec-photo hidden /><span>' + esc(T(photo ? "spec.changePhoto" : "spec.addPhoto")) + "</span></label>" +
          (photo ? '<button type="button" class="linkbtn danger" data-spec-photo-del>' + esc(T("spec.removePhoto")) + "</button>" : "") + "</div>") + "</div>" +
      (isNew ? "" : '<div class="spec-block"><b>' + esc(T("spec.commercial")) + '</b><div class="spec-costs">' +
        (costs.length ? costs.map(function (c) { return "<span>" + esc(c.name) + "</span><b>" + esc(c.cost == null ? "—" : A.money(c.cost, A.defaultCurrency())) + "</b>"; }).join("") : "<span>" + esc(T("spec.noSuppliers")) + "</span><b></b>") +
        "<span>" + esc(T("spec.listPrice")) + "</span><b>" + esc(list == null ? "—" : A.money(list, A.defaultCurrency())) + "</b></div>" +
        '<p class="hint">' + esc(T("spec.commercialHint")) + "</p></div>") +
      '<div class="spec-edit__foot"><p class="status" id="spec-status" role="status" aria-live="polite"></p>' +
        (isNew ? '<button type="button" class="btn btn--outline" data-spec-cancel>' + esc(T("form.cancel")) + "</button>" : "") +
        '<button type="button" class="btn btn--primary" data-spec-save>' + esc(T(isNew ? "spec.create" : "spec.save")) + "</button></div>";
  }
  function setSpecStatus(msg, kind) { var el = $("#spec-status"); if (!el) return; el.textContent = msg || ""; el.className = "status" + (kind ? " is-" + kind : ""); }

  function saveSpec(extra) {
    var p = product();
    if (!p || !draft) return;
    var isNew = draft.from === undefined;
    var body = { options: draft.options, info: draft.info };
    if (!isNew) body.key = current;
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    var btn = $("[data-spec-save]");
    if (btn) btn.disabled = true;
    setSpecStatus("…");
    A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=spec", { method: "POST", body: body })
      .then(function (d) {
        A.replaceProducts([d.product]);
        current = d.key; draft = null;
        render();
        setSpecStatus(T(extra && "archived" in extra ? (extra.archived ? "spec.archivedOk" : "spec.restoredOk") : isNew ? "spec.created" : "spec.saved", { code: codeOf(d.product, d.key) }), "ok");
      }, function (err) {
        if (btn) btn.disabled = false;
        var data = err.data || {};
        if (data.error === "Checklist incomplete") setSpecStatus(T("spec.needFields", { fields: (data.fields || []).map(function (f) { return T("spec.f." + f); }).join(", ") }), "error");
        else if (data.error === "Missing characteristics") setSpecStatus(T("spec.needAttrs", { attrs: (data.missing || []).join(", ") }), "error");
        else if (data.error === "Specification exists") setSpecStatus(T("spec.exists", { code: data.code }), "error");
        else setSpecStatus(err.message, "error");
        markNeeds();
      });
  }
  function markNeeds() {
    document.querySelectorAll("#spec-edit [data-attr]").forEach(function (s) { s.classList.toggle("is-need", !s.value); });
  }

  $("#specs-pane").addEventListener("click", function (e) {
    var p = product();
    if (!p) return;
    var li = e.target.closest("[data-spec]");
    if (li) { current = li.getAttribute("data-spec"); draft = null; return render(); }
    if (e.target.closest("[data-spec-new]")) { current = null; draft = { options: {}, info: {} }; return render(); }
    if (e.target.closest("[data-spec-copy]")) {
      // A copy of this specification to change: same characteristics and details, new code when saved.
      var from = current;
      draft = { options: optionsOfKey(p, from), info: Object.assign({}, (p.specs || {})[from] || {}), copyOf: from };
      delete draft.info.archived; delete draft.info.archivedBy;
      current = null;
      render();
      setSpecStatus(T("spec.copyHint"), "ok");
      return;
    }
    if (e.target.closest("[data-spec-cancel]")) { draft = null; current = null; return render(); }
    if (e.target.closest("[data-spec-save]")) return saveSpec();
    if (e.target.closest("[data-spec-archive]")) {
      var arch = (p.specs || {})[current] && p.specs[current].archived;
      if (!arch && !confirm(T("spec.archiveConfirm"))) return;
      return saveSpec({ archived: !arch });
    }
    if (e.target.closest("[data-spec-photo-del]")) {
      if (!confirm(T("form.variantPhotoRemove") + "?")) return;
      A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=variantImage", { method: "POST", body: { key: current, remove: true } })
        .then(function (d) { A.replaceProducts([d.product]); render(); }, function (err) { setSpecStatus(err.message, "error"); });
    }
  });
  $("#specs-pane").addEventListener("change", function (e) {
    if (e.target.id === "spec-arch") { showArchived = e.target.checked; return render(); }
    var a = e.target.getAttribute("data-attr");
    if (a && draft) { draft.options[a] = e.target.value; e.target.classList.toggle("is-need", !e.target.value); return; }
    if (e.target.matches("[data-spec-photo]")) {
      var p = product(), file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      setSpecStatus("…");
      A.squareImage(file).then(function (data) {
        return A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=variantImage", { method: "POST", body: { key: current, image: data } });
      }).then(function (d) { A.replaceProducts([d.product]); render(); setSpecStatus(T("spec.photoOk"), "ok"); }, function (err) { setSpecStatus(err.message, "error"); });
    }
  });
  $("#specs-pane").addEventListener("input", function (e) {
    var f = e.target.getAttribute("data-f");
    if (f && draft) { draft.info[f] = e.target.value; e.target.classList.remove("is-need"); }
  });

  /* ---------- Clientes ---------- */
  function renderClients() {
    var p = product();
    var box = $("#pclients-pane");
    if (!p) { box.innerHTML = ""; return; }
    var hasSpecs = specKeys(p, true).length > 0;
    var refs = p.clientRefs || {}, infos = p.clientSpecs || {};
    var groups = A.clients().map(function (c) {
      var keys = {};
      Object.keys(refs[c.id] || {}).forEach(function (k) { keys[k] = true; });
      Object.keys(infos[c.id] || {}).forEach(function (k) { keys[k] = true; });
      return { client: c, keys: Object.keys(keys) };
    }).filter(function (g) { return g.keys.length; });
    var nLinks = groups.reduce(function (t, g) { return t + g.keys.length; }, 0);
    $("#ptab-clients-count").textContent = groups.length;
    var sampleTxt = function (i) {
      if (!i.sample) return '<span class="muted">—</span>';
      return '<span class="spec-tag spec-tag--' + (i.sample === "approved" ? "ok" : i.sample === "pending" ? "miss" : "arch") + '">' + esc(T("cs.sample." + i.sample)) + (i.sampleDate ? " " + esc(new Date(i.sampleDate + "T00:00:00").toLocaleDateString(A.locale())) : "") + "</span>";
    };
    var html = '<div class="cs-head"><p class="hint">' + esc(T("cs.hint")) + '</p><button type="button" class="btn btn--primary btn--sm" data-cs-new>' + esc(T("cs.new")) + "</button></div>";
    if (editingLink === "new") html += linkForm(p, null, null);
    html += groups.length ? groups.map(function (g) {
      return '<section class="cs-group"><div class="cs-group__head"><b>' + esc(g.client.name) + "</b><small>" + esc(T("cs.count", { n: g.keys.length })) + "</small></div>" +
        g.keys.map(function (k) {
          var i = (infos[g.client.id] || {})[k] || {};
          var ref = (refs[g.client.id] || {})[k] || "";
          if (editingLink && editingLink !== "new" && editingLink.clientId === g.client.id && editingLink.key === k) return linkForm(p, g.client.id, k);
          var arch = (p.specs || {})[k] && p.specs[k].archived;
          return '<div class="cs-row">' +
            '<span class="cs-code">' + esc(k ? codeOf(p, k) : T("cs.allSpecs")) + "</span>" +
            '<span class="cs-model">' + esc(k ? summary(p, k) : T("cs.productLevel")) + (arch ? ' <em class="spec-tag spec-tag--arch">' + esc(T("spec.tagArchived")) + "</em>" : "") + "</span>" +
            '<span>' + (ref ? '<span class="crm-ref">' + esc(ref) + "</span>" : '<span class="muted">—</span>') + "</span>" +
            '<span class="cs-txt">' + esc(i.name || "—") + "</span>" +
            '<span class="cs-txt">' + esc(i.requirements || "—") + "</span>" +
            "<span>" + sampleTxt(i) + "</span>" +
            '<span class="cs-actions"><button type="button" class="linkbtn" data-cs-edit="' + esc(g.client.id) + '" data-key="' + esc(k) + '">' + esc(T("list.edit")) + "</button>" +
            '<button type="button" class="linkbtn danger" data-cs-del="' + esc(g.client.id) + '" data-key="' + esc(k) + '">' + esc(T("cs.unlink")) + "</button></span></div>";
        }).join("") + "</section>";
    }).join("") : (editingLink === "new" ? "" : '<p class="spec-empty">' + esc(T("cs.none")) + "</p>");
    if (!hasSpecs && attrsOf(p).length) html = '<p class="spec-banner">' + esc(T("cs.needSpecs")) + "</p>" + html;
    box.innerHTML = html + '<p class="status" id="cs-status" role="status" aria-live="polite"></p>';
    void nLinks;
  }
  function linkForm(p, clientId, key) {
    var isNew = clientId == null;
    var i = isNew ? {} : ((p.clientSpecs || {})[clientId] || {})[key] || {};
    var ref = isNew ? "" : ((p.clientRefs || {})[clientId] || {})[key] || "";
    var keys = specKeys(p, false);
    var hasSpecs = specKeys(p, true).length > 0;
    return '<form class="cs-form" data-cs-form>' +
      '<div class="spec-grid">' +
        '<label class="spec-f"><span>' + esc(T("cs.client")) + ' *</span><select name="clientId"' + (isNew ? "" : " disabled") + '><option value="">' + esc(T("spec.choose")) + "</option>" +
          A.clients().map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === clientId ? " selected" : "") + ">" + esc(c.name) + "</option>"; }).join("") + "</select></label>" +
        '<label class="spec-f spec-f--wide2"><span>' + esc(T("cs.spec")) + ' *</span><select name="key"' + (isNew ? "" : " disabled") + ">" +
          (hasSpecs ? '<option value="">' + esc(T("spec.choose")) + "</option>" + (isNew ? keys : [key]).map(function (k) { return '<option value="' + esc(k) + '"' + (k === key ? " selected" : "") + ">" + esc(codeOf(p, k) + " — " + summary(p, k)) + "</option>"; }).join("")
            : '<option value="">' + esc(T("cs.productLevel")) + "</option>") + "</select></label>" +
        '<label class="spec-f"><span>' + esc(T("cs.ref")) + '</span><input type="text" name="ref" maxlength="60" value="' + esc(ref) + '" /></label>' +
        '<label class="spec-f spec-f--wide2"><span>' + esc(T("cs.name")) + '</span><input type="text" name="name" maxlength="160" value="' + esc(i.name || "") + '" /></label>' +
        '<label class="spec-f spec-f--wide2"><span>' + esc(T("cs.requirements")) + '</span><input type="text" name="requirements" maxlength="1000" value="' + esc(i.requirements || "") + '" placeholder="' + esc(T("cs.requirementsPh")) + '" /></label>' +
        '<label class="spec-f"><span>' + esc(T("cs.sample")) + '</span><select name="sample"><option value="">—</option>' +
          ["approved", "pending", "rejected"].map(function (s) { return '<option value="' + s + '"' + (i.sample === s ? " selected" : "") + ">" + esc(T("cs.sample." + s)) + "</option>"; }).join("") + "</select></label>" +
        '<label class="spec-f"><span>' + esc(T("cs.sampleDate")) + '</span><input type="date" name="sampleDate" value="' + esc(i.sampleDate || "") + '" /></label>' +
      '</div><div class="spec-edit__foot"><button type="button" class="btn btn--outline btn--sm" data-cs-cancel>' + esc(T("form.cancel")) + "</button>" +
        '<button type="submit" class="btn btn--primary btn--sm">' + esc(T("spec.save")) + "</button></div>" +
      (isNew ? "" : '<input type="hidden" name="fixedClient" value="' + esc(clientId) + '" /><input type="hidden" name="fixedKey" value="' + esc(key) + '" />') + "</form>";
  }
  function setCsStatus(msg, kind) { var el = $("#cs-status"); if (!el) return; el.textContent = msg || ""; el.className = "status" + (kind ? " is-" + kind : ""); }
  function sendLink(body) {
    var p = product();
    return A.api("/api/products?id=" + encodeURIComponent(p.id) + "&action=clientSpec", { method: "POST", body: body })
      .then(function (d) { A.replaceProducts([d.product]); editingLink = null; render(); setCsStatus(T(body.remove ? "cs.unlinked" : "cs.saved"), "ok"); },
        function (err) { setCsStatus(err.message, "error"); });
  }
  $("#pclients-pane").addEventListener("click", function (e) {
    if (e.target.closest("[data-cs-new]")) { editingLink = "new"; return render(); }
    if (e.target.closest("[data-cs-cancel]")) { editingLink = null; return render(); }
    var ed = e.target.closest("[data-cs-edit]");
    if (ed) { editingLink = { clientId: ed.getAttribute("data-cs-edit"), key: ed.getAttribute("data-key") }; return render(); }
    var del = e.target.closest("[data-cs-del]");
    if (del && confirm(T("cs.unlinkConfirm"))) sendLink({ clientId: del.getAttribute("data-cs-del"), key: del.getAttribute("data-key"), remove: true });
  });
  $("#pclients-pane").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var clientId = f.elements.fixedClient ? f.elements.fixedClient.value : f.elements.clientId.value;
    var key = f.elements.fixedKey ? f.elements.fixedKey.value : f.elements.key.value;
    var p = product();
    if (!clientId) return setCsStatus(T("cs.needClient"), "error");
    if (!key && specKeys(p, true).length) return setCsStatus(T("cs.needSpec"), "error");
    sendLink({ clientId: clientId, key: key, ref: f.elements.ref.value, name: f.elements.name.value, requirements: f.elements.requirements.value,
      sample: f.elements.sample.value, sampleDate: f.elements.sampleDate.value });
  });

  /* ---------- Wiring ---------- */
  function render() {
    var p = product();
    if (!p) return;
    $("#ptab-specs-count").textContent = specKeys(p, false).length;
    var tab = document.querySelector("#ptabs [data-ptab].is-active");
    tab = tab && tab.getAttribute("data-ptab");
    if (tab === "specs") renderSpecs();
    if (tab === "clients") renderClients();
    if (tab !== "clients") renderClientsCount(p);
  }
  function renderClientsCount(p) {
    var refs = p.clientRefs || {}, infos = p.clientSpecs || {};
    var n = A.clients().filter(function (c) { return Object.keys(refs[c.id] || {}).length || Object.keys(infos[c.id] || {}).length; }).length;
    $("#ptab-clients-count").textContent = n;
  }
  document.addEventListener("admin:ptab", function (e) {
    if (!e.detail.productId) return;
    if (e.detail.tab === "general") return render();
    if (product() && current != null && !(product().variantSkus || {}).hasOwnProperty(current)) current = null;
    render();
  });
  document.addEventListener("admin:product-open", function () { current = null; draft = null; editingLink = null; showArchived = false; render(); });
  document.addEventListener("admin:lang", function () { if (product()) render(); });
})();
