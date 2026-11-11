(function () {
  "use strict";

  var LANGS = ["pt", "en", "es", "zh"];
  var MAX_SIDE = 1600; // photos are resized in the browser before upload

  var $ = function (sel) { return document.querySelector(sel); };
  var loginView = $("#login-view");
  var appView = $("#app-view");
  var form = $("#product-form");
  var statusEl = $("#form-status");
  var listEl = $("#product-list");
  var products = [];
  var suppliers = [];
  // supplier id -> { cost, variants: { comboKey: cost }, open } typed in the product form
  var selectedSuppliers = new Map();
  var defaultCurrency = "CNY"; // from the Settings tab; RMB unless changed there

  // Currencies offered on proformas. CNY is shown as "RMB".
  var CURRENCIES = {
    CNY: { label: "RMB", symbol: "¥" },
    USD: { label: "USD", symbol: "US$" },
    EUR: { label: "EUR", symbol: "€" },
    BRL: { label: "BRL", symbol: "R$" }
  };

  // Reads "15.9", "15,9", "1.234,56", "1,234.56" or "1.000" (thousand); null when empty or invalid.
  function parseDecimal(value) {
    if (value === "" || value == null) return null;
    var s = String(value).trim().replace(/\s/g, "");
    if (!s) return null;
    var c = s.lastIndexOf(","), d = s.lastIndexOf(".");
    if (c > -1 && d > -1) s = c > d ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (c > -1) s = s.match(/,/g).length > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
    else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ""); // "1.000" = one thousand
    if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return null;
    var n = Number(s);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function money(value, currency) {
    var c = CURRENCIES[currency] || CURRENCIES.CNY;
    var n = Number(value);
    if (!isFinite(n)) return "—";
    return c.symbol + " " + n.toLocaleString(HTML_LANG[current], { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  var refState = {}; // client references being edited: { clientId: { comboKey or "": ref } }
  var attrState = []; // characteristics being edited: [{ id, name, options: [{ id, label }] }]
  var pendingImage = null; // data URL of the resized photo
  var duplicateOf = null; // product being duplicated into the form (not saved yet)

  /* ---------- Panel language (shares the site's saved choice) ---------- */
  var LANG_KEY = "micheng-lang";
  var HTML_LANG = { pt: "pt-BR", en: "en", es: "es", zh: "zh-CN" };
  var current = "pt";

  function T(key, vars) {
    var dict = window.ADMIN_I18N[current] || window.ADMIN_I18N.pt;
    var out = dict[key] != null ? dict[key] : window.ADMIN_I18N.pt[key] || key;
    Object.keys(vars || {}).forEach(function (k) { out = out.replace("{" + k + "}", vars[k]); });
    return out;
  }

  function langName(code) {
    var names = window.ADMIN_LANG_NAMES[current];
    if (!code) return T("lang.unknown");
    return names[code] || code.toUpperCase();
  }

  function detectPanelLang() {
    var saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch (e) { /* ignore */ }
    if (saved && window.ADMIN_I18N[saved]) return saved;
    var nav = String(navigator.language || "pt").toLowerCase().slice(0, 2);
    return window.ADMIN_I18N[nav] ? nav : "pt";
  }

  function setLang(lang) {
    current = window.ADMIN_I18N[lang] ? lang : "pt";
    try { localStorage.setItem(LANG_KEY, current); } catch (e) { /* ignore */ }
    document.documentElement.lang = HTML_LANG[current];
    document.title = T("title");
    document.querySelectorAll("[data-t]").forEach(function (el) { el.textContent = T(el.getAttribute("data-t")); });
    document.querySelectorAll("[data-t-title]").forEach(function (el) {
      el.setAttribute("title", T(el.getAttribute("data-t-title")));
      el.setAttribute("aria-label", T(el.getAttribute("data-t-title")));
    });
    document.querySelectorAll("[data-t-placeholder]").forEach(function (el) {
      el.setAttribute("placeholder", T(el.getAttribute("data-t-placeholder")));
      el.setAttribute("aria-label", T(el.getAttribute("data-t-placeholder")));
    });
    document.querySelectorAll(".lang__btn").forEach(function (btn) {
      var active = btn.getAttribute("data-lang") === current;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    updateFormMode();
    updateSupplierMode();
    renderList();
    renderPicker();
    renderAttrs();
    renderSuppliers();
    updateClientMode();
    renderClients();
    renderSettingsUpdated();
    setStatus("");
    setSupplierStatus("");
    setClientStatus("");
    setSettingsStatus("");
    document.dispatchEvent(new CustomEvent("admin:lang"));
  }

  document.querySelectorAll(".lang__btn").forEach(function (btn) {
    btn.addEventListener("click", function () { setLang(btn.getAttribute("data-lang")); });
  });

  function api(path, options) {
    options = options || {};
    var headers = options.body ? { "Content-Type": "application/json" } : {};
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
      cache: "no-store"
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && path !== "/api/login") showLogin();
        if (r.status === 503 && path !== "/api/login") throw new Error(T("status.busy"));
        if (r.status === 429) throw new Error(T("login.tooMany"));
        if (!r.ok) throw new Error(data.error || "Erro " + r.status);
        return data;
      });
    });
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (kind ? " is-" + kind : "");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* ---------- Views ---------- */
  function showLogin() {
    appView.hidden = true;
    loginView.hidden = false;
    loginView.querySelector("input[name=user]").focus();
  }
  function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
    loadProducts();
    loadSuppliers();
    loadClients();
    loadSettings();
  }

  /* ---------- Tabs ---------- */
  function showTab(name) {
    document.querySelectorAll(".tab").forEach(function (tab) {
      var active = tab.dataset.tab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    // Settings opens from the gear next to "Sign out".
    var gear = $(".tab-gear");
    gear.classList.toggle("is-active", name === "settings");
    gear.setAttribute("aria-pressed", name === "settings" ? "true" : "false");
    ["products", "suppliers", "clients", "proformas", "finance", "settings"].forEach(function (view) {
      $("#" + view + "-view").hidden = view !== name;
    });
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tab, .tab-gear").forEach(function (tab) {
    tab.addEventListener("click", function () { showTab(tab.dataset.tab); });
  });
  document.querySelectorAll("[data-goto]").forEach(function (btn) {
    btn.addEventListener("click", function () { showTab(btn.dataset.goto); });
  });

  /* ---------- Login / logout ---------- */
  $("#login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var btn = f.querySelector("button");
    var err = $("#login-error");
    err.textContent = "";
    btn.disabled = true;
    api("/api/login", { method: "POST", body: { user: f.user.value, password: f.password.value } })
      .then(function () { f.password.value = ""; showApp(); })
      .catch(function (e2) {
        err.textContent = /Invalid/.test(e2.message) ? T("login.invalid") : e2.message;
      })
      .then(function () { btn.disabled = false; });
  });

  $("#logout").addEventListener("click", function () {
    api("/api/logout", { method: "POST" }).then(showLogin, showLogin);
  });

  /* ---------- Photo ---------- */
  // Average colour and spread of the pixels along the edges that will touch
  // the padding (top/bottom for a wide photo, left/right for a tall one).
  function edgeColor(img, wide) {
    var c = document.createElement("canvas");
    var k = 64 / Math.max(img.width, img.height);
    c.width = Math.max(1, Math.round(img.width * k));
    c.height = Math.max(1, Math.round(img.height * k));
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    var data = ctx.getImageData(0, 0, c.width, c.height).data;
    var px = [];
    function add(x, y) { var i = (y * c.width + x) * 4; px.push([data[i], data[i + 1], data[i + 2]]); }
    var x, y;
    if (wide) for (x = 0; x < c.width; x++) { add(x, 0); add(x, c.height - 1); }
    else for (y = 0; y < c.height; y++) { add(0, y); add(c.width - 1, y); }
    var mean = [0, 1, 2].map(function (ch) {
      return px.reduce(function (sum, p) { return sum + p[ch]; }, 0) / px.length;
    });
    var spread = Math.sqrt(px.reduce(function (sum, p) {
      return sum + Math.pow(p[0] - mean[0], 2) + Math.pow(p[1] - mean[1], 2) + Math.pow(p[2] - mean[2], 2);
    }, 0) / (px.length * 3));
    return { rgb: "rgb(" + mean.map(Math.round).join(",") + ")", uniform: spread < 14 };
  }

  // Photos are always stored square: a rectangular photo is centred and the
  // empty space is filled with its own background colour when that is plain
  // (e.g. a white studio background), or with a blurred copy of the photo.
  function resizeImage(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error(T("status.imageType")));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var side = Math.min(MAX_SIDE, Math.max(img.width, img.height));
        var scale = side / Math.max(img.width, img.height);
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);
        var canvas = document.createElement("canvas");
        canvas.width = canvas.height = side;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; // transparent PNGs get a white background
        ctx.fillRect(0, 0, side, side);

        if (Math.abs(w - h) > side * 0.01) {
          var edge = edgeColor(img, w > h);
          ctx.fillStyle = edge.rgb;
          ctx.fillRect(0, 0, side, side);
          if (!edge.uniform && "filter" in ctx) {
            // Blurred "cover" copy of the photo behind it, slightly enlarged so
            // the blurred borders do not show.
            var cover = (side / Math.min(img.width, img.height)) * 1.15;
            var cw = img.width * cover, ch = img.height * cover;
            ctx.filter = "blur(" + Math.round(side * 0.035) + "px)";
            ctx.drawImage(img, (side - cw) / 2, (side - ch) / 2, cw, ch);
            ctx.filter = "none";
            ctx.fillStyle = "rgba(255,255,255,0.12)";
            ctx.fillRect(0, 0, side, side);
          }
        }
        ctx.drawImage(img, Math.round((side - w) / 2), Math.round((side - h) / 2), w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(T("status.imageRead"))); };
      img.src = url;
    });
  }


  function showPreview(src) {
    var prev = $("#photo-preview");
    prev.src = src || "";
    prev.hidden = !src;
    $("#photo-hint").hidden = Boolean(src);
  }

  var drop = $("#photo-drop");
  var fileInput = form.elements.photo;
  fileInput.addEventListener("change", function () {
    var file = fileInput.files[0];
    if (!file) return;
    resizeImage(file).then(function (dataUrl) {
      pendingImage = dataUrl;
      showPreview(dataUrl);
      drop.classList.remove("is-invalid");
    }, function (e) { setStatus(e.message, "error"); });
  });
  ["dragenter", "dragover"].forEach(function (ev) {
    drop.addEventListener(ev, function () { drop.classList.add("is-over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    drop.addEventListener(ev, function () { drop.classList.remove("is-over"); });
  });

  /* ---------- Form ---------- */
  function trFields(kind) {
    return Array.prototype.slice.call(form.querySelectorAll('[data-tr="' + kind + '"]'));
  }

  // Title and button labels depend on whether a product is being edited.
  function updateFormMode() {
    var editing = Boolean(form.elements.id.value);
    $("#form-title").textContent = duplicateOf
      ? T("form.duplicateTitle", { name: duplicateOf.name[current] || duplicateOf.source.name })
      : T(editing ? "form.edit" : "form.new");
    var editingProduct = editing && products.filter(function (x) { return x.id === form.elements.id.value; })[0];
    if (editingProduct && editingProduct.sku) $("#form-title").textContent += " · SKU " + editingProduct.sku;
    $("#save-btn").textContent = T(editing ? "form.saveChanges" : "form.save");
    $("#cancel-edit").hidden = !editing && !duplicateOf;
    var p = editing && products.filter(function (x) { return x.id === form.elements.id.value; })[0];
    $("#detected-lang").textContent = p ? "· " + T("list.registeredIn") + ": " + langName(p.source.lang) : "";
  }

  function resetForm() {
    duplicateOf = null;
    form.reset();
    form.elements.id.value = "";
    pendingImage = null;
    showPreview(null);
    updateFormMode();
    $("#translations").hidden = true;
    $("#translations").open = false;
    form.querySelectorAll(".is-invalid").forEach(function (el) { el.classList.remove("is-invalid"); });
    selectedSuppliers = new Map();
    $("#supplier-search").value = "";
    renderPicker();
    attrState = [];
    refState = {};
    renderAttrs();
    renderList();
  }

  function editProduct(p) {
    resetForm();
    form.elements.id.value = p.id;
    form.elements.name.value = p.source.name;
    form.elements.description.value = p.source.description || "";
    form.elements.category.value = p.category || "";
    showPreview(p.image);
    trFields("name").forEach(function (el) { el.value = p.name[el.dataset.lang] || ""; });
    trFields("description").forEach(function (el) { el.value = (p.description || {})[el.dataset.lang] || ""; });
    $("#translations").hidden = false;
    selectedSuppliers = new Map((p.supplierLinks || []).map(function (l) {
      var variants = {};
      Object.keys(l.variantCosts || {}).forEach(function (k) { variants[k] = String(l.variantCosts[k]); });
      return [l.supplierId, { cost: l.cost == null ? "" : String(l.cost), variants: variants, open: Object.keys(variants).length > 0 }];
    }));
    renderPicker();
    refState = JSON.parse(JSON.stringify(p.clientRefs || {}));
    // Characteristics are edited in the language they were written in.
    attrState = (p.attributes || []).map(function (a) {
      return {
        id: a.id,
        name: a.source,
        options: a.options.map(function (o) { return { id: o.id, label: o.source }; })
      };
    });
    renderAttrs();
    updateFormMode();
    setStatus("");
    renderList();
    document.getElementById("form-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Duplicate: the form is filled as a NEW product with everything from the
  // original (photo, category, description, characteristics, suppliers and
  // their prices). Nothing is created until "Save product" is clicked.
  function duplicateProduct(p) {
    resetForm();
    duplicateOf = p;
    form.elements.name.value = (p.source.name + T("form.copySuffix")).slice(0, 120);
    form.elements.description.value = p.source.description || "";
    form.elements.category.value = p.category || "";
    showPreview(p.image);
    selectedSuppliers = new Map((p.supplierLinks || []).map(function (l) {
      return [l.supplierId, { cost: l.cost == null ? "" : String(l.cost), variants: {}, open: false }];
    }));
    renderPicker();
    // Without ids: the copy gets its own characteristics and options.
    attrState = (p.attributes || []).map(function (a) {
      return { name: a.source, options: a.options.map(function (o) { return { label: o.source }; }) };
    });
    renderAttrs();
    updateFormMode();
    setStatus(T("status.duplicating"), "ok");
    renderList();
    document.getElementById("form-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    form.elements.name.focus();
    form.elements.name.select();
  }

  $("#cancel-edit").addEventListener("click", function () { resetForm(); setStatus(""); });

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = form.elements.id.value;
    var name = form.elements.name.value.trim();
    var category = form.elements.category.value;
    var ok = true;
    form.elements.name.classList.toggle("is-invalid", !name);
    form.elements.category.classList.toggle("is-invalid", !category);
    if (!name || !category) ok = false;
    if (!id && !pendingImage && !duplicateOf) { drop.classList.add("is-invalid"); ok = false; }
    if (!ok) return setStatus(T("status.required"), "error");
    commitPendingOptions();
    var attrsOk = attrState.every(function (a) {
      var empty = !a.name.trim() && !a.options.length;
      return empty || (a.name.trim() && a.options.length);
    });
    if (!attrsOk) return setStatus(T("status.attrNoOptions"), "error");
    var badPrice = null;
    selectedSuppliers.forEach(function (entry) {
      [entry.cost].concat(Object.keys(entry.variants).map(function (k) { return entry.variants[k]; })).forEach(function (v) {
        if (String(v || "").trim() && parseDecimal(v) == null && badPrice == null) badPrice = v;
      });
    });
    if (badPrice != null) return setStatus(T("status.badPrice", { value: badPrice }), "error");

    var body = {
      name: name,
      category: category,
      description: form.elements.description.value,
      clientRefs: refState,
      supplierLinks: Array.from(selectedSuppliers, function (entry) {
        return { supplierId: entry[0], cost: entry[1].cost, variantCosts: entry[1].variants };
      }),
      attributes: attrState.filter(function (a) { return a.name.trim(); })
    };
    if (pendingImage) body.image = pendingImage;
    else if (!id && duplicateOf) body.copyImageFrom = duplicateOf.id;
    if (id) {
      body.retranslate = form.elements.retranslate.checked;
      body.translations = { name: {}, description: {} };
      trFields("name").forEach(function (el) { body.translations.name[el.dataset.lang] = el.value; });
      trFields("description").forEach(function (el) { body.translations.description[el.dataset.lang] = el.value; });
    }

    var btn = $("#save-btn");
    btn.disabled = true;
    setStatus(T("status.saving"));
    api(id ? "/api/products?id=" + encodeURIComponent(id) : "/api/products", { method: id ? "PUT" : "POST", body: body })
      .then(function (data) {
        var p = data.product;
        var before = id && products.filter(function (x) { return x.id === id; })[0];
        var newVariants = Object.keys(p.variantSkus || {}).filter(function (k) {
          return !(before && before.variantSkus && k in before.variantSkus);
        }).length;
        if (id) products = products.map(function (x) { return x.id === id ? p : x; });
        else products.unshift(p);
        resetForm();
        loadSuppliers(); // linked-product lists changed
        if (newVariants) {
          // The variants only now have codes: reopen so their prices and photos can be entered.
          editProduct(p);
          selectedSuppliers.forEach(function (entry) { entry.open = true; });
          renderPicker();
          setStatus(T("status.variantsCreated", { n: newVariants }), "ok");
          return;
        }
        setStatus(p.translationOk === false
          ? T("status.savedNoTr")
          : T("status.saved", { lang: langName(p.source.lang) }), p.translationOk === false ? "error" : "ok");
      })
      .catch(function (e2) { setStatus(/Server error|Erro \d/.test(e2.message) ? T("status.error") : e2.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- List ---------- */
  function loadProducts() {
    api("/api/products?admin=1").then(function (data) {
      products = data.products || [];
      renderList();
      document.dispatchEvent(new CustomEvent("admin:data"));
    }).catch(function (e) { setStatus(e.message, "error"); });
  }

  function renderList() {
    var q = $("#search").value.trim().toLowerCase();
    var cat = $("#cat-filter").value;
    var editing = form.elements.id.value;
    var shown = products.filter(function (p) {
      if (cat && p.category !== cat) return false;
      if (!q) return true;
      if (p.sku && (String(p.sku).indexOf(q) === 0 || variantCodes(p).some(function (v) { return v.code.indexOf(q) === 0; }))) return true;
      return LANGS.some(function (l) { return String(p.name[l] || "").toLowerCase().indexOf(q) > -1; });
    });
    $("#count").textContent = products.length;
    $("#tab-count-products").textContent = products.length;
    $("#empty").hidden = products.length > 0;
    listEl.innerHTML = shown.map(function (p) {
      var chips = LANGS.map(function (l) {
        return "<span><b>" + l.toUpperCase() + "</b>" + escapeHtml(p.name[l]) + "</span>";
      }).join("");
      return '<li class="pitem' + (p.id === editing ? " is-editing" : "") + '" data-id="' + escapeHtml(p.id) + '">' +
        '<img src="' + escapeHtml(p.image) + '" alt="" loading="lazy" />' +
        "<div><h3>" + (p.sku ? '<span class="sku">' + escapeHtml(p.sku) + "</span> " : "") + escapeHtml(p.name[current] || p.source.name) + "</h3>" +
        '<p class="pitem__lang">' + (p.category ? '<span class="pitem__cat">' + escapeHtml(T("cat." + p.category)) + "</span> · " : "") +
        escapeHtml(T("list.registeredIn") + ": " + langName(p.source.lang)) + "</p>" +
        '<div class="pitem__tr">' + chips + "</div>" +
        attributeLine(p.attributes) +
        variantLine(p) +
        supplierLine(p.supplierLinks) +
        refLine(p.clientRefs) +
        (p.translationOk === false ? '<p class="pitem__warn">' + escapeHtml(T("list.pending")) + "</p>" : "") + "</div>" +
        '<div class="pitem__actions"><button type="button" data-act="edit">' + escapeHtml(T("list.edit")) + "</button>" +
        '<button type="button" data-act="duplicate">' + escapeHtml(T("list.duplicate")) + "</button>" +
        '<button type="button" class="danger" data-act="delete">' + escapeHtml(T("list.delete")) + "</button></div></li>";
    }).join("");
  }

  $("#search").addEventListener("input", renderList);
  $("#cat-filter").addEventListener("change", renderList);

  listEl.addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var id = btn.closest(".pitem").dataset.id;
    var p = products.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    if (btn.dataset.act === "edit") return editProduct(p);
    if (btn.dataset.act === "duplicate") return duplicateProduct(p);
    if (!confirm(T("list.confirmDelete", { name: p.name[current] || p.source.name }))) return;
    btn.disabled = true;
    api("/api/products?id=" + encodeURIComponent(id), { method: "DELETE" })
      .then(function () {
        products = products.filter(function (x) { return x.id !== id; });
        if (form.elements.id.value === id) resetForm();
        renderList();
        loadSuppliers();
        setStatus(T("status.deleted"), "ok");
      })
      .catch(function (e2) { btn.disabled = false; setStatus(e2.message, "error"); });
  });

  /* ---------- SKU codes ---------- */
  // Variant codes of a product ("1001-1"), each with its option labels, in suffix order.
  function variantCodes(p) {
    var map = p.variantSkus || {};
    return Object.keys(map).sort(function (a, b) { return map[a] - map[b]; }).map(function (key) {
      var ids = key.split(",");
      // Labels in the order of the characteristics (e.g. "75° / 3/4"").
      var label = (p.attributes || []).map(function (a) {
        var o = a.options.filter(function (x) { return ids.indexOf(x.id) > -1; })[0];
        return o ? (o.label && o.label[current]) || o.source : "";
      }).filter(Boolean).join(" / ");
      return { key: key, code: p.sku + "-" + map[key], label: label };
    });
  }

  function variantLine(p) {
    var list = variantCodes(p);
    if (!list.length) return "";
    var shown = list.slice(0, 12).map(function (v) {
      var img = p.variantImages && p.variantImages[v.key];
      return "<span>" + (img ? '<img src="' + escapeHtml(img) + '" alt="" loading="lazy" />' : "") + "<b>" + escapeHtml(v.code) + "</b> " + escapeHtml(v.label) + "</span>";
    }).join("");
    return '<div class="pitem__skus">' + shown + (list.length > 12 ? "<span>+" + (list.length - 12) + "</span>" : "") + "</div>";
  }

  /* ---------- Client references (per variant) ---------- */
  // "Client refs: CLARA INOX (12)" under a product in the list.
  function refLine(refs) {
    var names = Object.keys(refs || {}).map(function (cid) {
      return clientName(cid) + " (" + Object.keys(refs[cid]).length + ")";
    });
    return names.length ? '<p class="pitem__sup"><span class="lock" aria-hidden="true"></span>' + escapeHtml(T("list.clientRefs") + ": " + names.join(", ")) + "</p>" : "";
  }

  // Rows to fill for each client: one per variant code, or a single one when
  // the product has no variants. New variants get codes when the product is saved.
  function refRows() {
    var p = form.elements.id.value && products.filter(function (x) { return x.id === form.elements.id.value; })[0];
    if (attrState.length) return p ? variantCodes(p) : [];
    return [{ key: "", code: p && p.sku ? String(p.sku) : "", label: "" }];
  }

  function clientName(id) {
    var c = clients.filter(function (x) { return x.id === id; })[0];
    return c ? c.name : "?";
  }

  function renderClientRefs() {
    if (typeof clients === "undefined") return;
    var rows = refRows();
    var ids = Object.keys(refState);
    $("#crefs-hint").textContent = T(attrState.length && !rows.length ? "cref.saveFirst" : "cref.hint");
    $("#crefs-list").innerHTML = rows.length ? ids.map(function (cid) {
      return '<div class="cref" data-client="' + escapeHtml(cid) + '"><div class="cref__head"><b>' + escapeHtml(clientName(cid)) + "</b>" +
        '<button type="button" class="linkbtn" data-cref-remove="' + escapeHtml(cid) + '">' + escapeHtml(T("list.delete")) + "</button></div>" +
        rows.map(function (r) {
          return '<label class="vcosts__row"><span class="vcosts__code">' + escapeHtml(r.code || "—") + '</span><span class="vcosts__label">' + escapeHtml(r.label) + "</span>" +
            '<input type="text" maxlength="60" autocomplete="off" data-cref="' + escapeHtml(cid) + '" data-key="' + escapeHtml(r.key) + '" value="' +
            escapeHtml((refState[cid] || {})[r.key] || "") + '" placeholder="' + escapeHtml(T("cref.placeholder")) + '" /></label>';
        }).join("") + "</div>";
    }).join("") : "";
    var add = $("#crefs-add");
    var free = clients.filter(function (c) { return !(c.id in refState); });
    add.hidden = !rows.length || !free.length;
    add.innerHTML = '<option value="">' + escapeHtml(T(clients.length ? "cref.add" : "cref.noClients")) + "</option>" +
      free.map(function (c) { return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + "</option>"; }).join("");
  }

  $("#crefs-add").addEventListener("change", function (e) {
    if (!e.target.value) return;
    refState[e.target.value] = refState[e.target.value] || {};
    var cid = e.target.value;
    renderClientRefs();
    var first = $("#crefs-list").querySelector('[data-cref="' + cid + '"]');
    if (first) first.focus();
  });
  $("#crefs-list").addEventListener("input", function (e) {
    var cid = e.target.getAttribute("data-cref");
    if (cid) refState[cid][e.target.getAttribute("data-key")] = e.target.value;
  });
  $("#crefs-list").addEventListener("click", function (e) {
    var cid = e.target.getAttribute("data-cref-remove");
    if (!cid) return;
    delete refState[cid];
    renderClientRefs();
  });

  /* ---------- Photos per variant ---------- */
  // Shown for a saved product with variants; each photo is uploaded right away.
  function renderVariantPhotos() {
    var box = $("#vphotos");
    var p = form.elements.id.value && products.filter(function (x) { return x.id === form.elements.id.value; })[0];
    var list = p ? variantCodes(p) : [];
    box.hidden = !list.length && !attrState.length;
    if (box.hidden) return;
    $("#vphotos-hint").textContent = T(list.length ? "form.variantPhotosHint" : "form.variantPhotosSaveFirst");
    $("#vphotos-grid").innerHTML = list.map(function (v) {
      var own = p.variantImages && p.variantImages[v.key];
      return '<div class="vphoto' + (own ? " has-own" : "") + '">' +
        '<label class="vphoto__img" title="' + escapeHtml(T("form.variantPhotoPick")) + '">' +
          '<img src="' + escapeHtml(own || p.image) + '" alt="" loading="lazy" />' +
          '<input type="file" accept="image/jpeg,image/png,image/webp" data-vphoto="' + escapeHtml(v.key) + '" data-code="' + escapeHtml(v.code) + '" />' +
        "</label>" +
        '<div class="vphoto__meta"><b>' + escapeHtml(v.code) + "</b><span>" + escapeHtml(v.label) + "</span></div>" +
        (own ? '<button type="button" class="vphoto__remove" data-vremove="' + escapeHtml(v.key) + '" data-code="' + escapeHtml(v.code) + '" aria-label="' + escapeHtml(T("form.variantPhotoRemove")) + '" title="' + escapeHtml(T("form.variantPhotoRemove")) + '">×</button>' : "") +
        "</div>";
    }).join("");
  }

  function sendVariantPhoto(body, code, done) {
    var id = form.elements.id.value;
    setStatus(T("status.saving"));
    api("/api/products?id=" + encodeURIComponent(id) + "&action=variantImage", { method: "POST", body: body })
      .then(function (data) {
        products = products.map(function (x) { return x.id === id ? data.product : x; });
        renderVariantPhotos();
        renderList();
        setStatus(T(done, { code: code }), "ok");
      })
      .catch(function (e) { setStatus(e.message, "error"); renderVariantPhotos(); });
  }

  $("#vphotos-grid").addEventListener("change", function (e) {
    var key = e.target.getAttribute("data-vphoto");
    var file = e.target.files && e.target.files[0];
    if (!key || !file) return;
    var code = e.target.getAttribute("data-code");
    e.target.closest(".vphoto").classList.add("is-busy");
    resizeImage(file).then(function (dataUrl) {
      sendVariantPhoto({ key: key, image: dataUrl }, code, "status.variantPhotoSaved");
    }, function (err) { setStatus(err.message, "error"); renderVariantPhotos(); });
  });

  $("#vphotos-grid").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-vremove]");
    if (!btn) return;
    sendVariantPhoto({ key: btn.getAttribute("data-vremove"), remove: true }, btn.getAttribute("data-code"), "status.variantPhotoRemoved");
  });

  /* ---------- Characteristics in the product form ---------- */
  function attributeLine(attrs) {
    if (!attrs || !attrs.length) return "";
    return attrs.map(function (a) {
      var opts = a.options.map(function (o) { return (o.label && o.label[current]) || o.source; });
      return '<p class="pitem__attr"><b>' + escapeHtml((a.name && a.name[current]) || a.source) + ":</b> " + escapeHtml(opts.join(", ")) + "</p>";
    }).join("");
  }

  // Re-renders the editor; `focus` = { attr: index, field: "name" | "option" } to keep typing there.
  function renderAttrs(focus) {
    renderVariantPhotos();
    renderClientRefs();
    if (typeof suppliers !== "undefined") renderPicker();
    $("#attr-list").innerHTML = attrState.map(function (a, i) {
      var chips = a.options.map(function (o, j) {
        return '<span class="tag">' + escapeHtml(o.label) +
          '<button type="button" class="tag__x" data-opt="' + j + '" aria-label="' + escapeHtml(T("attr.removeOption")) + '">×</button></span>';
      }).join("");
      return '<div class="attr" data-index="' + i + '">' +
        '<div class="attr__row"><input class="attr__name" maxlength="60" value="' + escapeHtml(a.name) + '" placeholder="' + escapeHtml(T("attr.namePh")) + '" />' +
        '<button type="button" class="attr__remove" aria-label="' + escapeHtml(T("attr.remove")) + '" title="' + escapeHtml(T("attr.remove")) + '">×</button></div>' +
        '<div class="tags">' + chips + '<input class="tags__input" maxlength="60" placeholder="' + escapeHtml(T("attr.optionPh")) + '" /></div></div>';
    }).join("");
    if (focus) {
      var box = $("#attr-list").querySelector('.attr[data-index="' + focus.attr + '"]');
      if (box) box.querySelector(focus.field === "name" ? ".attr__name" : ".tags__input").focus();
    }
  }

  function addOption(i, value) {
    var label = String(value || "").trim().slice(0, 60);
    if (!label) return false;
    var exists = attrState[i].options.some(function (o) { return o.label.toLowerCase() === label.toLowerCase(); });
    if (!exists) attrState[i].options.push({ label: label });
    return true;
  }

  // Text typed in an option box but not yet confirmed with Enter is kept on save.
  function commitPendingOptions() {
    $("#attr-list").querySelectorAll(".attr").forEach(function (box) {
      var input = box.querySelector(".tags__input");
      if (input.value.trim()) addOption(Number(box.dataset.index), input.value);
    });
  }

  $("#attr-add").addEventListener("click", function () {
    commitPendingOptions();
    attrState.push({ name: "", options: [] });
    renderAttrs({ attr: attrState.length - 1, field: "name" });
  });

  $("#attr-list").addEventListener("input", function (e) {
    if (!e.target.classList.contains("attr__name")) return;
    attrState[Number(e.target.closest(".attr").dataset.index)].name = e.target.value;
  });

  $("#attr-list").addEventListener("keydown", function (e) {
    if (!e.target.classList.contains("tags__input")) return;
    var i = Number(e.target.closest(".attr").dataset.index);
    if (e.key === "Enter" || e.key === "," || e.key === "，") {
      e.preventDefault(); // Enter must not submit the product form
      if (addOption(i, e.target.value)) renderAttrs({ attr: i, field: "option" });
    } else if (e.key === "Backspace" && !e.target.value && attrState[i].options.length) {
      attrState[i].options.pop();
      renderAttrs({ attr: i, field: "option" });
    }
  });

  // Pasting "PVC, Silicone; Rubber" adds several options at once.
  $("#attr-list").addEventListener("paste", function (e) {
    if (!e.target.classList.contains("tags__input")) return;
    var text = (e.clipboardData || window.clipboardData).getData("text");
    if (!/[,;\n，；]/.test(text)) return;
    e.preventDefault();
    var i = Number(e.target.closest(".attr").dataset.index);
    text.split(/[,;\n，；]/).forEach(function (part) { addOption(i, part); });
    renderAttrs({ attr: i, field: "option" });
  });

  $("#attr-list").addEventListener("click", function (e) {
    var box = e.target.closest(".attr");
    if (!box) return;
    var i = Number(box.dataset.index);
    if (e.target.classList.contains("attr__remove")) {
      attrState.splice(i, 1);
      renderAttrs();
    } else if (e.target.classList.contains("tag__x")) {
      attrState[i].options.splice(Number(e.target.dataset.opt), 1);
      renderAttrs({ attr: i, field: "option" });
    } else if (e.target.classList.contains("tags")) {
      box.querySelector(".tags__input").focus();
    }
  });

  /* ---------- Supplier picker in the product form ---------- */
  function supplierById(id) {
    return suppliers.filter(function (s) { return s.id === id; })[0];
  }

  // "🔒 Suppliers: A, B" line under a product in the list (admin only).
  function supplierLine(links) {
    var names = (links || []).map(function (l) {
      var s = supplierById(l.supplierId);
      if (!s) return null;
      var prices = [l.cost].concat(Object.keys(l.variantCosts || {}).map(function (k) { return l.variantCosts[k]; }))
        .filter(function (v) { return v != null; });
      if (!prices.length) return s.company;
      var lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices);
      return s.company + " (" + money(lo, defaultCurrency) + (hi > lo ? " – " + money(hi, defaultCurrency) : "") + ")";
    }).filter(Boolean);
    if (!names.length) return "";
    return '<p class="pitem__sup"><span class="lock" aria-hidden="true"></span>' +
      escapeHtml(T("list.suppliers") + ": " + names.join(", ")) + "</p>";
  }

  function renderPicker() {
    var picker = $("#supplier-picker");
    var q = $("#supplier-search").value.trim().toLowerCase();
    // Only product suppliers (not expense ones such as rent), plus any already linked to this product.
    var candidates = suppliers.filter(function (s) { return s.productSupplier !== false || selectedSuppliers.has(s.id); });
    $("#supplier-picker-empty").hidden = candidates.length > 0;
    $("#supplier-search").hidden = candidates.length === 0;
    picker.hidden = candidates.length === 0;
    $("#supplier-selected").textContent = selectedSuppliers.size ? T("form.suppliersSelected", { n: selectedSuppliers.size }) : "";
    var shown = candidates.filter(function (s) {
      return !q || (s.company + " " + s.city + " " + s.contact).toLowerCase().indexOf(q) > -1;
    });
    // Ticked suppliers first, so the choice stays visible.
    shown.sort(function (a, b) { return selectedSuppliers.has(b.id) - selectedSuppliers.has(a.id); });
    // Variants of the product as saved (new options get their code when the product is saved).
    var editingProduct = form.elements.id.value && products.filter(function (x) { return x.id === form.elements.id.value; })[0];
    var variants = editingProduct ? variantCodes(editingProduct) : [];
    picker.innerHTML = shown.length ? shown.map(function (s) {
      var on = selectedSuppliers.has(s.id);
      var entry = selectedSuppliers.get(s.id);
      var cur = escapeHtml((CURRENCIES[defaultCurrency] || CURRENCIES.CNY).label);
      // A ticked supplier gets a field for its purchase price of this product…
      var cost = on ? '<span class="picker__cost"><span>' + escapeHtml(T(variants.length ? "form.costDefault" : "form.cost")) + "</span>" +
        '<input type="text" inputmode="decimal" autocomplete="off" data-cost="' + escapeHtml(s.id) + '" value="' +
        escapeHtml(entry.cost) + '" placeholder="0,00" /><em>' + cur + "</em></span>" : "";
      // …and, for a product with variants, a price per configuration.
      var filled = on ? Object.keys(entry.variants).filter(function (k) { return entry.variants[k] !== ""; }).length : 0;
      var toggle = on && (variants.length || attrState.length) ? '<button type="button" class="linkbtn picker__vtoggle" data-vtoggle="' + escapeHtml(s.id) + '">' +
        escapeHtml(T("form.variantCosts")) + (filled ? " (" + filled + ")" : "") + (entry.open ? " ▴" : " ▾") + "</button>" : "";
      var table = on && entry.open ? '<div class="vcosts">' + (variants.length ? variants.map(function (v) {
        return '<label class="vcosts__row"><span class="vcosts__code">' + escapeHtml(v.code) + '</span><span class="vcosts__label">' + escapeHtml(v.label) + "</span>" +
          '<input type="text" inputmode="decimal" autocomplete="off" data-vcost="' + escapeHtml(s.id) + '" data-key="' + escapeHtml(v.key) + '" value="' +
          escapeHtml(entry.variants[v.key] || "") + '" placeholder="' + escapeHtml(entry.cost || "0,00") + '" /><em>' + cur + "</em></label>";
      }).join("") : "") + '<p class="vcosts__hint">' + escapeHtml(T(variants.length ? "form.variantCostsHint" : "form.variantCostsSaveFirst")) + "</p></div>" : "";
      return '<div class="picker__item' + (on ? " is-on" : "") + '"><label><input type="checkbox" value="' + escapeHtml(s.id) + '"' +
        (on ? " checked" : "") + " /><span><b>" + escapeHtml(s.company) + "</b>" +
        (s.city ? "<small>" + escapeHtml(s.city) + "</small>" : "") + "</span></label>" + cost + toggle + table + "</div>";
    }).join("") : '<p class="picker__none">' + escapeHtml(T("form.noMatch")) + "</p>";
  }

  $("#supplier-picker").addEventListener("change", function (e) {
    if (e.target.type !== "checkbox") return;
    var id = e.target.value;
    if (e.target.checked) selectedSuppliers.set(id, selectedSuppliers.get(id) || { cost: "", variants: {}, open: false });
    else selectedSuppliers.delete(id);
    renderPicker();
    var costInput = $("#supplier-picker").querySelector('[data-cost="' + id + '"]');
    if (costInput) costInput.focus();
  });
  $("#supplier-picker").addEventListener("input", function (e) {
    var id = e.target.getAttribute("data-cost");
    if (id) {
      selectedSuppliers.get(id).cost = e.target.value;
      // Empty variant fields show the default price as their placeholder.
      $("#supplier-picker").querySelectorAll('[data-vcost="' + id + '"]').forEach(function (el) { el.placeholder = e.target.value || "0,00"; });
    }
    var vid = e.target.getAttribute("data-vcost");
    if (vid) selectedSuppliers.get(vid).variants[e.target.getAttribute("data-key")] = e.target.value;
  });
  $("#supplier-picker").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-vtoggle]");
    if (!btn) return;
    var entry = selectedSuppliers.get(btn.getAttribute("data-vtoggle"));
    entry.open = !entry.open;
    renderPicker();
  });
  $("#supplier-search").addEventListener("input", renderPicker);

  /* ---------- Suppliers tab ---------- */
  var supForm = $("#supplier-form");
  var supStatus = $("#supplier-status");
  var SUP_FIELDS = ["company", "contact", "phone", "wechat", "email", "city", "website", "notes"];

  function setSupplierStatus(msg, kind) {
    supStatus.textContent = msg || "";
    supStatus.className = "status" + (kind ? " is-" + kind : "");
  }

  function loadSuppliers() {
    api("/api/suppliers").then(function (data) {
      suppliers = data.suppliers || [];
      renderSuppliers();
      renderPicker();
      renderList();
      document.dispatchEvent(new CustomEvent("admin:data"));
    }).catch(function (e) { setSupplierStatus(e.message, "error"); });
  }

  function updateSupplierMode() {
    var editing = Boolean(supForm.elements.id.value);
    $("#supplier-title").textContent = T(editing ? "sup.edit" : "sup.new");
    $("#supplier-save").textContent = T(editing ? "sup.saveChanges" : "sup.save");
    $("#supplier-cancel").hidden = !editing;
  }

  function resetSupplierForm() {
    supForm.reset();
    supForm.elements.id.value = "";
    supForm.elements.company.classList.remove("is-invalid");
    updateSupplierMode();
    renderSuppliers();
  }

  function editSupplier(s) {
    resetSupplierForm();
    supForm.elements.id.value = s.id;
    SUP_FIELDS.forEach(function (f) { supForm.elements[f].value = s[f] || ""; });
    supForm.elements.productSupplier.checked = s.productSupplier !== false;
    updateSupplierMode();
    setSupplierStatus("");
    renderSuppliers();
    $("#supplier-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("#supplier-cancel").addEventListener("click", function () { resetSupplierForm(); setSupplierStatus(""); });

  supForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = supForm.elements.id.value;
    var body = {};
    SUP_FIELDS.forEach(function (f) { body[f] = supForm.elements[f].value; });
    body.productSupplier = supForm.elements.productSupplier.checked;
    var ok = body.company.trim() !== "";
    supForm.elements.company.classList.toggle("is-invalid", !ok);
    if (!ok) return setSupplierStatus(T("sup.required"), "error");
    var btn = $("#supplier-save");
    btn.disabled = true;
    api(id ? "/api/suppliers?id=" + encodeURIComponent(id) : "/api/suppliers", { method: id ? "PUT" : "POST", body: body })
      .then(function (data) {
        if (id) suppliers = suppliers.map(function (x) { return x.id === id ? data.supplier : x; });
        else suppliers.unshift(data.supplier);
        resetSupplierForm();
        renderPicker();
        renderList();
        setSupplierStatus(T("sup.saved"), "ok");
      })
      .catch(function (e2) { setSupplierStatus(/Server error|Erro \d/.test(e2.message) ? T("status.error") : e2.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  function productName(id) {
    var p = products.filter(function (x) { return x.id === id; })[0];
    return p ? p.name[current] || p.source.name : null;
  }

  function safeUrl(url) {
    var u = String(url || "").trim();
    if (!u) return "";
    return /^https?:\/\//i.test(u) ? u : "https://" + u;
  }

  function renderSuppliers() {
    var q = $("#supplier-list-search").value.trim().toLowerCase();
    var editing = supForm.elements.id.value;
    $("#supplier-count").textContent = suppliers.length;
    $("#tab-count-suppliers").textContent = suppliers.length;
    $("#supplier-empty").hidden = suppliers.length > 0;
    var kind = $("#supplier-kind").value;
    var shown = suppliers.filter(function (s) {
      var forProducts = s.productSupplier !== false;
      if ((kind === "products" && !forProducts) || (kind === "other" && forProducts)) return false;
      return !q || SUP_FIELDS.some(function (f) { return String(s[f] || "").toLowerCase().indexOf(q) > -1; });
    });
    $("#supplier-list").innerHTML = shown.map(function (s) {
      var contact = [];
      if (s.contact) contact.push(escapeHtml(s.contact));
      if (s.phone) contact.push("☎ " + escapeHtml(s.phone));
      if (s.wechat) contact.push("WeChat: " + escapeHtml(s.wechat));
      if (s.email) contact.push('<a href="mailto:' + escapeHtml(s.email) + '">' + escapeHtml(s.email) + "</a>");
      if (s.website) contact.push('<a href="' + escapeHtml(safeUrl(s.website)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(s.website) + "</a>");
      var linked = (s.productIds || []).map(productName).filter(Boolean);
      return '<li class="pitem sitem' + (s.id === editing ? " is-editing" : "") + '" data-id="' + escapeHtml(s.id) + '">' +
        "<div><h3>" + escapeHtml(s.company) + ' <span class="sup-tag' + (s.productSupplier === false ? " sup-tag--other" : "") + '">' +
          escapeHtml(T(s.productSupplier === false ? "sup.tagOther" : "sup.tagProducts")) + "</span></h3>" +
        (s.city ? '<p class="pitem__lang">' + escapeHtml(s.city) + "</p>" : "") +
        (contact.length ? '<p class="sitem__contact">' + contact.join(" · ") + "</p>" : "") +
        (s.notes ? '<p class="sitem__notes">' + escapeHtml(s.notes) + "</p>" : "") +
        '<div class="pitem__tr"><span class="sitem__label">' + escapeHtml(T("sup.products")) + "</span>" +
        (linked.length ? linked.map(function (n) { return "<span>" + escapeHtml(n) + "</span>"; }).join("")
          : '<span class="muted">' + escapeHtml(T("sup.noProducts")) + "</span>") + "</div></div>" +
        '<div class="pitem__actions"><button type="button" data-act="edit">' + escapeHtml(T("list.edit")) + "</button>" +
        '<button type="button" class="danger" data-act="delete">' + escapeHtml(T("list.delete")) + "</button></div></li>";
    }).join("");
  }

  $("#supplier-list-search").addEventListener("input", renderSuppliers);
  $("#supplier-kind").addEventListener("change", renderSuppliers);

  $("#supplier-list").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var id = btn.closest(".sitem").dataset.id;
    var s = supplierById(id);
    if (!s) return;
    if (btn.dataset.act === "edit") return editSupplier(s);
    if (!confirm(T("sup.confirmDelete", { name: s.company }))) return;
    btn.disabled = true;
    api("/api/suppliers?id=" + encodeURIComponent(id), { method: "DELETE" })
      .then(function () {
        suppliers = suppliers.filter(function (x) { return x.id !== id; });
        selectedSuppliers.delete(id);
        products.forEach(function (p) {
          p.supplierLinks = (p.supplierLinks || []).filter(function (l) { return l.supplierId !== id; });
          p.supplierIds = p.supplierLinks.map(function (l) { return l.supplierId; });
        });
        if (supForm.elements.id.value === id) resetSupplierForm();
        renderSuppliers();
        renderPicker();
        renderList();
        setSupplierStatus(T("sup.deleted"), "ok");
      })
      .catch(function (e2) { btn.disabled = false; setSupplierStatus(e2.message, "error"); });
  });

  /* ---------- Clients tab ---------- */
  var clients = [];
  var cliForm = $("#client-form");
  var CLI_FIELDS = ["name", "address", "phone", "taxId"];

  function setClientStatus(msg, kind) {
    var el = $("#client-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }

  function loadClients() {
    api("/api/clients").then(function (data) {
      clients = data.clients || [];
      renderClients();
      renderClientRefs();
      document.dispatchEvent(new CustomEvent("admin:data"));
    }).catch(function (e) { setClientStatus(e.message, "error"); });
  }

  function updateClientMode() {
    var editing = Boolean(cliForm.elements.id.value);
    $("#client-title").textContent = T(editing ? "cli.edit" : "cli.new");
    $("#client-save").textContent = T(editing ? "cli.saveChanges" : "cli.save");
    $("#client-cancel").hidden = !editing;
  }

  function resetClientForm() {
    cliForm.reset();
    cliForm.elements.id.value = "";
    cliForm.elements.name.classList.remove("is-invalid");
    updateClientMode();
    renderClients();
  }

  function renderClients() {
    var q = $("#client-search").value.trim().toLowerCase();
    var editing = cliForm.elements.id.value;
    $("#client-count").textContent = clients.length;
    $("#tab-count-clients").textContent = clients.length;
    $("#client-empty").hidden = clients.length > 0;
    var shown = clients.filter(function (c) {
      return !q || CLI_FIELDS.some(function (f) { return String(c[f] || "").toLowerCase().indexOf(q) > -1; });
    });
    $("#client-list").innerHTML = shown.map(function (c) {
      var details = [];
      if (c.phone) details.push("☎ " + escapeHtml(c.phone));
      if (c.taxId) details.push(escapeHtml(T("cli.taxId") + ": " + c.taxId));
      return '<li class="pitem sitem' + (c.id === editing ? " is-editing" : "") + '" data-id="' + escapeHtml(c.id) + '">' +
        "<div><h3>" + escapeHtml(c.name) + "</h3>" +
        (c.address ? '<p class="sitem__notes">' + escapeHtml(c.address) + "</p>" : "") +
        (details.length ? '<p class="sitem__contact">' + details.join(" · ") + "</p>" : "") + "</div>" +
        '<div class="pitem__actions"><button type="button" data-act="edit">' + escapeHtml(T("list.edit")) + "</button>" +
        '<button type="button" class="danger" data-act="delete">' + escapeHtml(T("list.delete")) + "</button></div></li>";
    }).join("");
  }

  $("#client-search").addEventListener("input", renderClients);
  $("#client-cancel").addEventListener("click", function () { resetClientForm(); setClientStatus(""); });

  cliForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = cliForm.elements.id.value;
    var body = {};
    CLI_FIELDS.forEach(function (f) { body[f] = cliForm.elements[f].value; });
    var ok = body.name.trim() !== "";
    cliForm.elements.name.classList.toggle("is-invalid", !ok);
    if (!ok) return setClientStatus(T("cli.required"), "error");
    var btn = $("#client-save");
    btn.disabled = true;
    api(id ? "/api/clients?id=" + encodeURIComponent(id) : "/api/clients", { method: id ? "PUT" : "POST", body: body })
      .then(function (data) {
        if (id) clients = clients.map(function (x) { return x.id === id ? data.client : x; });
        else clients.unshift(data.client);
        resetClientForm();
        setClientStatus(T("cli.saved"), "ok");
      })
      .catch(function (e2) { setClientStatus(/Server error|Erro \d/.test(e2.message) ? T("status.error") : e2.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  $("#client-list").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var id = btn.closest(".sitem").dataset.id;
    var c = clients.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    if (btn.dataset.act === "edit") {
      resetClientForm();
      cliForm.elements.id.value = c.id;
      CLI_FIELDS.forEach(function (f) { cliForm.elements[f].value = c[f] || ""; });
      updateClientMode();
      setClientStatus("");
      renderClients();
      $("#client-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (!confirm(T("cli.confirmDelete", { name: c.name }))) return;
    btn.disabled = true;
    api("/api/clients?id=" + encodeURIComponent(id), { method: "DELETE" })
      .then(function () {
        clients = clients.filter(function (x) { return x.id !== id; });
        // Their references were removed from the products too.
        products.forEach(function (p) { if (p.clientRefs) delete p.clientRefs[id]; });
        delete refState[id];
        renderClientRefs();
        renderList();
        if (cliForm.elements.id.value === id) resetClientForm();
        renderClients();
        setClientStatus(T("cli.deleted"), "ok");
      })
      .catch(function (e2) { btn.disabled = false; setClientStatus(e2.message, "error"); });
  });

  /* ---------- Settings tab (company details for proformas) ---------- */
  var setForm = $("#settings-form");
  var SET_FIELDS = ["currency", "companyName", "address", "phone", "email", "website",
    "bankBeneficiary", "bankName", "bankAccount", "bankSwift", "bankAddress", "bankNotes"];
  var settingsUpdatedAt = null;
  var companySettings = {};

  function setSettingsStatus(msg, kind) {
    var el = $("#settings-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }

  function renderSettingsUpdated() {
    $("#settings-updated").textContent = settingsUpdatedAt
      ? T("set.updated", { date: new Date(settingsUpdatedAt).toLocaleString(HTML_LANG[current]) })
      : "";
  }

  function fillSettings(settings) {
    SET_FIELDS.forEach(function (f) { setForm.elements[f].value = (settings && settings[f]) || ""; });
    defaultCurrency = (settings && CURRENCIES[settings.currency]) ? settings.currency : "CNY";
    setForm.elements.currency.value = defaultCurrency;
    renderPicker();
    renderList();
    settingsUpdatedAt = settings && settings.updatedAt;
    companySettings = settings || {};
    renderSettingsUpdated();
    document.dispatchEvent(new CustomEvent("admin:data"));
  }

  function loadSettings() {
    api("/api/settings").then(function (data) { fillSettings(data.settings); })
      .catch(function (e) { setSettingsStatus(e.message, "error"); });
  }

  setForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = {};
    SET_FIELDS.forEach(function (f) { body[f] = setForm.elements[f].value; });
    var btn = $("#settings-save");
    btn.disabled = true;
    api("/api/settings", { method: "PUT", body: body })
      .then(function (data) {
        fillSettings(data.settings);
        setSettingsStatus(T("set.saved"), "ok");
      })
      .catch(function (e2) { setSettingsStatus(/Server error|Erro \d/.test(e2.message) ? T("status.error") : e2.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Shared with admin-proformas.js ---------- */
  window.Admin = {
    api: api,
    T: T,
    money: money,
    escapeHtml: escapeHtml,
    CURRENCIES: CURRENCIES,
    lang: function () { return current; },
    locale: function () { return HTML_LANG[current]; },
    products: function () { return products; },
    suppliers: function () { return suppliers; },
    clients: function () { return clients; },
    settings: function () { return companySettings; },
    defaultCurrency: function () { return defaultCurrency; },
    variantCodes: variantCodes,
    reloadProducts: loadProducts,
    parseDecimal: parseDecimal,
    showTab: showTab
  };

  /* ---------- Start ---------- */
  setLang(detectPanelLang());
  api("/api/session").then(function (s) { s.authenticated ? showApp() : showLogin(); }, showLogin);
})();
