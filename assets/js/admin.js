(function () {
  "use strict";

  /* ---------- Unexpected errors: shown on screen instead of failing silently ---------- */
  var ERR_TEXT = {
    pt: ["Algo deu errado nesta tela.", "Recarregar"], en: ["Something went wrong on this screen.", "Reload"],
    es: ["Algo salió mal en esta pantalla.", "Recargar"], zh: ["此页面出现错误。", "重新加载"]
  };
  function showError(msg) {
    var lang = (document.documentElement.lang || "pt").slice(0, 2);
    var tx = ERR_TEXT[lang] || ERR_TEXT.pt;
    var bar = document.getElementById("app-error");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "app-error";
      bar.className = "app-error";
      bar.setAttribute("role", "alert");
      document.body.appendChild(bar);
    }
    bar.innerHTML = "";
    var t = document.createElement("span");
    t.textContent = tx[0] + " " + String(msg || "").slice(0, 160);
    var reload = document.createElement("button");
    reload.type = "button"; reload.textContent = tx[1];
    reload.addEventListener("click", function () { location.reload(); });
    var close = document.createElement("button");
    close.type = "button"; close.className = "app-error__x"; close.textContent = "×"; close.setAttribute("aria-label", "×");
    close.addEventListener("click", function () { bar.remove(); });
    bar.appendChild(t); bar.appendChild(reload); bar.appendChild(close);
  }
  window.addEventListener("error", function (e) {
    if (e.target && e.target !== window && e.target.tagName) return; // a missing image is not an app error
    showError(e.message);
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    if (r && /Login required|Failed to fetch|NetworkError|Load failed/.test(r.message || "")) return;
    showError(r && r.message ? r.message : r);
  });

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
        if (r.status === 409 && data.error === "Changed by someone else") { loadAll(); throw new Error(T("status.conflict")); }
        if (!r.ok) { var err = new Error(data.error || "Erro " + r.status); err.data = data; throw err; }
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
    loadAll();
  }

  // Everything the panel shows, in one request. Also used to refresh the data
  // when changing tabs, so each admin sees what the other one saved.
  var lastLoad = 0;
  var loadingAll = null;
  function loadAll() {
    if (loadingAll) return loadingAll;
    loadingAll = api("/api/bootstrap").then(function (data) {
      lastLoad = Date.now();
      products = data.products || [];
      suppliers = data.suppliers || [];
      clients = data.clients || [];
      renderList();
      renderSuppliers();
      renderPicker();
      renderClients();
      renderClientRefs();
      fillSettings(data.settings, true);
      document.dispatchEvent(new CustomEvent("admin:data", { detail: { proformas: data.proformas || [], finance: data.finance, pricing: data.pricing } }));
    }).catch(function (e) { setStatus(e.message, "error"); })
      .then(function () { loadingAll = null; });
    return loadingAll;
  }
  function refreshIfStale() {
    if (!appView.hidden && Date.now() - lastLoad > 20000) loadAll();
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
    ["products", "suppliers", "pricing", "clients", "proformas", "finance", "settings"].forEach(function (view) {
      $("#" + view + "-view").hidden = view !== name;
    });
    document.dispatchEvent(new CustomEvent("admin:tab", { detail: name }));
    // On a phone the tab bar scrolls sideways: bring the chosen tab into view.
    var activeTab = $('.tab[data-tab="' + name + '"]');
    var bar = $(".tabs__inner");
    if (activeTab && bar && bar.scrollWidth > bar.clientWidth) {
      bar.scrollTo({ left: activeTab.offsetLeft - (bar.clientWidth - activeTab.offsetWidth) / 2, behavior: "smooth" });
    }
    window.scrollTo(0, 0);
  }

  /* ---------- Phone layout helpers ---------- */
  // On a phone the lists come first; "+ Novo" opens an empty form below them.
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-new]");
    if (!b) return;
    var kind = b.getAttribute("data-new");
    if (kind === "products") { resetForm(); setStatus(""); return openNewPage(); }
    var target = kind === "products" ? (resetForm(), "#form-panel") : kind === "suppliers" ? (resetSupplierForm(), "#supplier-panel") : (resetClientForm(), "#client-panel");
    $(target).scrollIntoView({ behavior: "smooth", block: "start" });
    var first = $(target).querySelector("input:not([type=hidden]), textarea");
    if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 350);
  });
  // Tables turn into cards on a phone: each cell gets its column title as a label.
  var labelQueued = false;
  function labelTables() {
    labelQueued = false;
    document.querySelectorAll("table.pf-table").forEach(function (t) {
      var heads = Array.prototype.map.call(t.querySelectorAll("thead th"), function (th) { return th.textContent.trim(); });
      if (!heads.length) return;
      t.querySelectorAll("tbody tr, tfoot tr").forEach(function (tr) {
        var col = 0;
        Array.prototype.forEach.call(tr.children, function (td) {
          var label = heads[col] || "";
          if (td.getAttribute("data-label") !== label) td.setAttribute("data-label", label);
          col += td.colSpan || 1;
        });
      });
    });
  }
  new MutationObserver(function () {
    if (!labelQueued) { labelQueued = true; requestAnimationFrame(labelTables); }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  document.querySelectorAll(".tab, .tab-gear").forEach(function (tab) {
    tab.addEventListener("click", function () { showTab(tab.dataset.tab); refreshIfStale(); });
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
    renderPreview();
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

  // Product page header: photo, code, name and a few facts at a glance.
  function renderHead(p) {
    $("#phead-img").src = p.image || "";
    $("#phead-img").hidden = !p.image;
    $("#phead-sku").textContent = p.sku || "";
    $("#phead-name").textContent = productName(p.id);
    var keys = Object.keys(p.variantSkus || {}).filter(function (k) { return !((p.specs || {})[k] || {}).archived; });
    var single = !(p.attributes || []).some(function (a) { return a.options.length; });
    var clients = Object.keys(p.clientRefs || {}).concat(Object.keys(p.clientSpecs || {})).filter(function (c, i, all) { return all.indexOf(c) === i; }).length;
    var chips = [];
    if (p.category) chips.push('<span class="phead__cat">' + escapeHtml(T("cat." + p.category)) + "</span>");
    chips.push('<span class="phead__chip phead__chip--ok">' + escapeHtml(T("pp.onSite")) + "</span>");
    chips.push('<span class="phead__chip">' + escapeHtml(single ? T("spec.single") : T("pp.specs", { n: keys.length })) + "</span>");
    chips.push('<span class="phead__chip">' + escapeHtml(T("pp.clients", { n: clients })) + "</span>");
    if (p.translationOk === false) chips.push('<span class="phead__chip phead__chip--warn">' + escapeHtml(T("list.pending")) + "</span>");
    $("#phead-chips").innerHTML = chips.join("");
  }
  // "How it shows on the site": photo, category, name and the characteristics.
  function renderPreview() {
    var box = $("#pv-preview");
    if (!box) return;
    var id = form.elements.id.value;
    var p = id && products.filter(function (x) { return x.id === id; })[0];
    var name = (p && p.name[current]) || form.elements.name.value.trim();
    var cat = form.elements.category.value;
    var img = $("#photo-preview").hidden ? "" : $("#photo-preview").src;
    var attrs = attrState.filter(function (a) { return a.name.trim() && a.options.length; }).map(function (a) {
      var saved = p && (p.attributes || []).filter(function (x) { return x.id === a.id; })[0];
      var label = function (o) { var so = saved && saved.options.filter(function (x) { return x.id === o.id; })[0]; return (so && so.label && so.label[current]) || o.label; };
      return '<span class="pv-attr"><b>' + escapeHtml((saved && saved.name && saved.name[current]) || a.name) + ":</b> " + escapeHtml(a.options.map(label).join(" · ")) + "</span>";
    });
    box.innerHTML = '<small class="pv-preview__label">' + escapeHtml(T("pv.preview")) + "</small>" +
      '<div class="pv-preview__card">' + (img ? '<img src="' + escapeHtml(img) + '" alt="" />' : '<span class="pv-preview__noimg"></span>') +
      "<div>" + (cat ? '<small class="pv-preview__cat">' + escapeHtml(T("cat." + cat)) + "</small>" : "") +
      "<b>" + escapeHtml(name || T("pv.noName")) + "</b>" + attrs.join("") + "</div></div>";
  }
  form.addEventListener("input", function (e) { if (e.target.name === "name" || e.target.closest("#attr-list")) renderPreview(); });
  form.addEventListener("change", function (e) { if (e.target.name === "category") renderPreview(); });

  // Title and button labels depend on whether a product is being edited.
  function updateFormMode() {
    var editing = Boolean(form.elements.id.value);
    $("#form-title").textContent = duplicateOf
      ? T("form.duplicateTitle", { name: duplicateOf.name[current] || duplicateOf.source.name })
      : T(editing ? "form.edit" : "form.new");
    var editingProduct = editing && products.filter(function (x) { return x.id === form.elements.id.value; })[0];
    if (editingProduct && editingProduct.sku) $("#form-title").textContent += " · SKU " + editingProduct.sku;
    // On the product page: its name, photo and characteristics, always in view above the tabs.
    $("#phead").hidden = !editingProduct;
    if (editingProduct) renderHead(editingProduct);
    $("#save-btn").textContent = T(editing ? "form.saveChanges" : "form.save");
    $("#cancel-edit").hidden = !editing && !duplicateOf;
    var p = editing && products.filter(function (x) { return x.id === form.elements.id.value; })[0];
    $("#detected-lang").textContent = p ? "· " + T("list.registeredIn") + ": " + langName(p.source.lang) : "";
  }

  function resetForm() {
    if ($("#products-view").classList.contains("is-product-open")) setProductPage(false);
    duplicateOf = null;
    pendingTech = [];
    setTechStatus("");
    $("#plog-own").hidden = true;
    form.reset();
    form.elements.id.value = "";
    showAllSuppliers = false;
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
    renderGallery();
    renderList();
  }

  /* ----- Product page: tabs Geral | Especificações | Clientes | Histórico ----- */
  // The new-product form also takes the whole page (the list is a page of its own),
  // with the steps: 1 showcase, 2 characteristics (this form), 3 specifications.
  function openNewPage() {
    $("#products-view").classList.add("is-product-open", "is-new");
    $("#pback").hidden = false;
    $("#ptabs").hidden = true;
    $("#wiz").hidden = false;
    $("#form-title").hidden = false;
    renderPreview();
    window.scrollTo(0, 0);
    setTimeout(function () { form.elements.name.focus(); }, 50);
  }
  function setProductPage(on) {
    $("#products-view").classList.remove("is-new");
    $("#products-view").classList.toggle("is-product-open", on);
    $("#ptabs").hidden = !on;
    $("#pback").hidden = !on;
    $("#wiz").hidden = true;
    $("#form-title").hidden = on;
    if (!on) { showPtab("general"); $("#plog-own").hidden = true; $("#pp-menu").hidden = true; }
  }
  var currentPtab = "general";
  function showPtab(name) {
    currentPtab = name;
    document.querySelectorAll("#ptabs [data-ptab]").forEach(function (b) {
      var active = b.getAttribute("data-ptab") === name;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    form.hidden = name !== "general";
    $("#specs-pane").hidden = name !== "specs";
    document.dispatchEvent(new CustomEvent("admin:ptab", { detail: { tab: name, productId: form.elements.id.value } }));
  }
  $("#ptabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-ptab]");
    if (b) showPtab(b.getAttribute("data-ptab"));
  });
  $("#pback").addEventListener("click", function () { resetForm(); });

  function editProduct(p, tab) {
    resetForm();
    form.elements.id.value = p.id;
    form.elements.name.value = p.source.name;
    form.elements.description.value = p.source.description || "";
    form.elements.category.value = p.category || "";
    showAllSuppliers = false;
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
    loadOwnLog(p.id);
    renderTech();
    setProductPage(true);
    document.dispatchEvent(new CustomEvent("admin:product-open", { detail: p.id }));
    showPtab(tab || "general");
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
    showAllSuppliers = false;
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
    openNewPage();
    setTimeout(function () { form.elements.name.select(); }, 60);
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
      attributes: attrState.filter(function (a) { return a.name.trim(); })
    };
    // Suppliers and costs are edited per specification; the form only carries
    // them when it creates a product (a duplicate keeps the original's).
    if (!id) body.supplierLinks = Array.from(selectedSuppliers, function (entry) {
      return { supplierId: entry[0], cost: entry[1].cost, variantCosts: entry[1].variants };
    });
    if (pendingImage) body.image = pendingImage;
    else if (!id && duplicateOf) body.copyImageFrom = duplicateOf.id;
    if (id) {
      var known = products.filter(function (x) { return x.id === id; })[0];
      if (known) body.baseUpdatedAt = known.updatedAt; // refused if someone else saved it meanwhile
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
        var queuedTech = !id ? pendingTech.slice() : [];
        var stillOpen = id && form.elements.id.value === id ? currentPtab : null;
        resetForm();
        if (queuedTech.length) uploadTech(p.id, queuedTech, true);
        if (!id) {
          // A new product: next step, its specifications (or, for a single model, its suppliers and costs).
          loadSuppliers();
          editProduct(p, "specs");
          setStatus(T((p.attributes || []).some(function (a) { return a.options.length; }) ? "spec.createNow" : "spec.createNowSingle"), "ok");
          return;
        }
        loadSuppliers(); // linked-product lists changed
        if (newVariants) {
          // The variants only now have codes: reopen so their prices and photos can be entered.
          editProduct(p);
          selectedSuppliers.forEach(function (entry) { entry.open = true; });
          renderPicker();
          setStatus(T("status.variantsCreated", { n: newVariants }), "ok");
          return;
        }
        if (stillOpen) editProduct(p, stillOpen); // stays on the product page, on the tab in use
        setStatus(p.translationOk === false
          ? T("status.savedNoTr")
          : T("status.saved", { lang: langName(p.source.lang) }), p.translationOk === false ? "error" : "ok");
      })
      .catch(function (e2) { setStatus(/Server error|Erro \d/.test(e2.message) ? T("status.error") : e2.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Technical drawings (any number per product, apart from the photos) ---------- */
  var pendingTech = []; // files chosen for a product not saved yet
  var TECH_MAX_SIDE = 2400;
  function setTechStatus(msg, kind) {
    var el = $("#techimgs-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }
  /* ---------- Gallery: more photos, each one optionally linked to an option ---------- */
  function setGalleryStatus(msg, kind) { var el = $("#gallery-status"); el.textContent = msg || ""; el.className = "status" + (kind ? " is-" + kind : ""); }
  function renderGallery() {
    var id = form.elements.id.value;
    var p = id && products.filter(function (x) { return x.id === id; })[0];
    $("#gallery-new").hidden = Boolean(p);
    $("#gallery-add").hidden = !p;
    if (!p) { $("#gallery-grid").innerHTML = ""; return; }
    var attrs = (p.attributes || []).filter(function (a) { return a.options.length; });
    var name = function (o) { return (o && o[current]) || ""; };
    $("#gallery-grid").innerHTML = (p.gallery || []).map(function (g) {
      return '<div class="gallery__item"><img src="' + escapeHtml(g.url) + '" alt="" loading="lazy" />' +
        '<select data-gal-link="' + escapeHtml(g.url) + '" aria-label="' + escapeHtml(T("gal.link")) + '"><option value="">' + escapeHtml(T("gal.noLink")) + "</option>" +
        attrs.map(function (a) {
          return '<optgroup label="' + escapeHtml(name(a.name) || a.source) + '">' + a.options.map(function (o) {
            return '<option value="' + escapeHtml(o.id) + '"' + (o.id === g.optionId ? " selected" : "") + ">" + escapeHtml((name(a.name) || a.source) + ": " + (name(o.label) || o.source)) + "</option>";
          }).join("") + "</optgroup>";
        }).join("") + "</select>" +
        '<button type="button" class="gallery__del" data-gal-del="' + escapeHtml(g.url) + '" aria-label="' + escapeHtml(T("gal.remove")) + '" title="' + escapeHtml(T("gal.remove")) + '">×</button></div>';
    }).join("");
  }
  function galleryCall(body) {
    var id = form.elements.id.value;
    return api("/api/products?id=" + encodeURIComponent(id) + "&action=gallery", { method: "POST", body: body }).then(function (d) {
      products = products.map(function (x) { return x.id === d.product.id ? d.product : x; });
      renderGallery();
      document.dispatchEvent(new CustomEvent("admin:data"));
    });
  }
  $("#gallery-file").addEventListener("change", function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    var done = 0;
    setGalleryStatus(T("gal.sending", { n: 1, total: files.length }));
    files.reduce(function (chain, file) {
      return chain.then(function () {
        setGalleryStatus(T("gal.sending", { n: done + 1, total: files.length }));
        return resizeImage(file).then(function (data) { return galleryCall({ image: data }); }).then(function () { done++; });
      });
    }, Promise.resolve()).then(function () { setGalleryStatus(T("gal.sent", { n: done }), "ok"); },
      function (err) { setGalleryStatus(err.message, "error"); });
  });
  $("#gallery-grid").addEventListener("change", function (e) {
    var url = e.target.getAttribute("data-gal-link");
    if (!url) return;
    setGalleryStatus("…");
    galleryCall({ url: url, optionId: e.target.value || null }).then(function () { setGalleryStatus(T("gal.linked"), "ok"); }, function (err) { setGalleryStatus(err.message, "error"); });
  });
  $("#gallery-grid").addEventListener("click", function (e) {
    var url = e.target.getAttribute("data-gal-del");
    if (!url || !confirm(T("gal.removeConfirm"))) return;
    galleryCall({ remove: url }).then(function () { setGalleryStatus(T("gal.removed"), "ok"); }, function (err) { setGalleryStatus(err.message, "error"); });
  });

  // Photo of a specification: its own, else the gallery photo of one of its options, else the main photo.
  function photoFor(p, key) {
    if (!p) return null;
    if (p.variantImages && p.variantImages[key]) return p.variantImages[key];
    var ids = String(key || "").split(",").filter(Boolean);
    var hit = (p.gallery || []).filter(function (g) { return g.optionId && ids.indexOf(g.optionId) > -1; })[0];
    return hit ? hit.url : p.image;
  }

  function renderTech() {
    renderGallery();
    var id = form.elements.id.value;
    var p = id && products.filter(function (x) { return x.id === id; })[0];
    var saved = (p && p.techImages) || [];
    $("#tech-count").textContent = saved.length + pendingTech.length ? "(" + (saved.length + pendingTech.length) + ")" : "";
    $("#techimgs-grid").innerHTML = saved.map(function (t) {
      return '<figure class="techimg"><a href="' + escapeHtml(t.url) + '" target="_blank" rel="noopener" title="' + escapeHtml(T("tech.open")) + '"><img src="' + escapeHtml(t.url) + '" alt="' + escapeHtml(t.name || "") + '" loading="lazy" /></a>' +
        '<figcaption>' + escapeHtml(t.name || "") + '</figcaption><button type="button" class="techimg__x" data-tech-del="' + escapeHtml(t.url) + '" aria-label="' + escapeHtml(T("tech.remove")) + '" title="' + escapeHtml(T("tech.remove")) + '">×</button></figure>';
    }).join("") + (pendingTech || []).map(function (f, k) {
      return '<figure class="techimg is-pending"><span class="techimg__wait">' + escapeHtml(T("tech.pending")) + "</span><figcaption>" + escapeHtml(f.name) + '</figcaption><button type="button" class="techimg__x" data-tech-unq="' + k + '" aria-label="' + escapeHtml(T("tech.remove")) + '">×</button></figure>';
    }).join("");
  }
  // Keeps the drawing's own shape (no square crop, unlike the photos); only very large ones are reduced.
  function prepareTech(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error(T("status.imageType")));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, TECH_MAX_SIDE / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        var ctx = c.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        // Line drawings stay sharp as PNG when that is small enough; otherwise JPEG.
        var data = file.type === "image/png" ? c.toDataURL("image/png") : "";
        if (!data || data.length * 0.75 > 2.5 * 1048576) data = c.toDataURL("image/jpeg", 0.9);
        if (data.length * 0.75 > 2.8 * 1048576) data = c.toDataURL("image/jpeg", 0.75);
        resolve(data);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(T("status.imageRead"))); };
      img.src = url;
    });
  }
  function uploadTech(productId, files, afterCreate) {
    var errors = [], done = 0;
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        setTechStatus(T("tech.uploading", { n: done + 1, total: files.length }));
        return prepareTech(f).then(function (data) {
          return api("/api/products?id=" + encodeURIComponent(productId) + "&action=techImage", { method: "POST", body: { image: data, name: f.name } });
        }).then(function (d) {
          done += 1;
          products = products.map(function (x) { return x.id === productId ? d.product : x; });
        }).catch(function (e) { errors.push(f.name + ": " + e.message); });
      });
    });
    return chain.then(function () {
      renderList();
      if (form.elements.id.value === productId) renderTech();
      var msg = done ? T("tech.added", { n: done }) : "";
      if (errors.length) msg += (msg ? " " : "") + errors.join(" · ");
      if (afterCreate) setStatus(($("#form-status").textContent + " " + msg).trim(), errors.length ? "error" : "ok");
      else setTechStatus(msg, errors.length ? "error" : "ok");
    });
  }
  $("#techimgs-file").addEventListener("change", function (e) {
    var files = Array.prototype.slice.call(e.target.files);
    e.target.value = "";
    if (!files.length) return;
    var id = form.elements.id.value;
    if (!id) { pendingTech = pendingTech.concat(files); renderTech(); setTechStatus(T("tech.queued")); return; }
    uploadTech(id, files, false);
  });
  $("#techimgs-grid").addEventListener("click", function (e) {
    var unq = e.target.closest("[data-tech-unq]");
    if (unq) { pendingTech.splice(Number(unq.getAttribute("data-tech-unq")), 1); renderTech(); return; }
    var del = e.target.closest("[data-tech-del]");
    if (!del || !confirm(T("tech.confirmRemove"))) return;
    var id = form.elements.id.value;
    api("/api/products?id=" + encodeURIComponent(id) + "&action=techImage", { method: "POST", body: { remove: del.getAttribute("data-tech-del") } })
      .then(function (d) {
        products = products.map(function (x) { return x.id === id ? d.product : x; });
        renderTech(); renderList(); setTechStatus(T("tech.removed"), "ok");
      }, function (err) { setTechStatus(err.message, "error"); });
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
    var period = datePeriod();
    var cli = $("#client-filter").value;
    var bought = cli ? clientProductIds(cli) : null;
    var shown = products.filter(function (p) {
      if (cat && p.category !== cat) return false;
      if (cli && !(hasClient(p, cli) || bought[p.id])) return false;
      if (period) {
        var day = localDay(p.createdAt);
        if (!day || (period.from && day < period.from) || (period.to && day > period.to)) return false;
      }
      if (onlyPending && !pendingOf(p).length) return false;
      if (!q) return true;
      if (p.sku && (String(p.sku).indexOf(q) === 0 || variantCodes(p).some(function (v) { return v.code.indexOf(q) === 0; }))) return true;
      return LANGS.some(function (l) { return String(p.name[l] || "").toLowerCase().indexOf(q) > -1; });
    });
    $("#count").textContent = products.length;
    renderListChips(products.length, products.filter(function (p) { return pendingOf(p).length; }).length);
    $("#tab-count-products").textContent = products.length;
    $("#empty").hidden = products.length > 0;
    var filtered = Boolean(q || cat || period || cli);
    $("#shown-count").textContent = filtered ? T("list.shownOf", { n: shown.length, total: products.length }) : "";
    $("#filters-clear").hidden = !filtered;
    $("#no-match").hidden = !(products.length && filtered && !shown.length);
    listEl.innerHTML = shown.map(function (p) {
      var pend = pendingOf(p);
      var attrs = (p.attributes || []).filter(function (a) { return a.options.length; }).map(function (a) {
        return ((a.name && a.name[current]) || a.source) + ": " + a.options.map(function (o) { return (o.label && o.label[current]) || o.source; }).join(", ");
      }).join(" · ");
      return '<button type="button" class="plt-row' + (pend.length ? " has-pend" : "") + '" data-open-product="' + escapeHtml(p.id) + '">' +
        '<span class="plt-img"><img src="' + escapeHtml(p.image) + '" alt="" loading="lazy" /></span>' +
        '<span class="plt-sku">' + escapeHtml(p.sku || "") + "</span>" +
        '<span class="plt-name"><b>' + escapeHtml(p.name[current] || p.source.name) + "</b><small>" + escapeHtml(p.category ? T("cat." + p.category) : "") +
          (p.createdAt ? " · " + escapeHtml(new Date(p.createdAt).toLocaleDateString(HTML_LANG[current])) : "") + "</small></span>" +
        '<span class="plt-attrs">' + escapeHtml(attrs || "—") + "</span>" +
        '<span class="plt-n" data-label="' + escapeHtml(T("ptab.specs")) + '">' + escapeHtml(pend.single ? T("spec.single") : String(pend.specs)) + "</span>" +
        '<span class="plt-n" data-label="' + escapeHtml(T("ptab.clients")) + '">' + (pend.clients || "—") + "</span>" +
        '<span class="plt-pend">' + (pend.length ? pend.map(function (x) { return '<em class="' + (x.bad ? "is-bad" : "") + '">' + escapeHtml(x.text) + "</em>"; }).join("") : '<span class="plt-ok">✓</span>') + "</span></button>";
    }).join("");
  }

  // What a product still lacks: specifications without the category's mandatory
  // fields or without a list price, no supplier, translation pending.
  function pendingOf(p) {
    var attrs = (p.attributes || []).filter(function (a) { return a.options.length; });
    var single = !attrs.length;
    var keys = single ? [""] : Object.keys(p.variantSkus || {}).filter(function (k) { return !((p.specs || {})[k] || {}).archived; });
    var cl = (companySettings && companySettings.checklist) || null;
    var need = cl && Array.isArray(cl[p.category]) ? cl[p.category] : ["details"];
    var out = [];
    if (!single) {
      if (!keys.length) out.push({ text: T("plt.noSpecs"), bad: true });
      var inc = keys.filter(function (k) {
        var info = (p.specs || {})[k] || {};
        return need.some(function (f) { return f === "photo" ? photoFor(p, k) === p.image : !String(info[f] || "").trim(); });
      }).length;
      if (inc) out.push({ text: T("plt.incomplete", { n: inc }) });
    }
    if (!(p.supplierLinks || []).length) out.push({ text: T("plt.noSupplier"), bad: true });
    var noPrice = keys.filter(function (k) { return !p.listPrices || p.listPrices[k] == null; }).length;
    if (keys.length && noPrice) out.push({ text: T("plt.noPrice", { n: noPrice }) });
    if (p.translationOk === false) out.push({ text: T("list.pending") });
    out.single = single;
    out.specs = keys.length;
    out.clients = Object.keys(p.clientRefs || {}).concat(Object.keys(p.clientSpecs || {})).filter(function (c, i, all) { return all.indexOf(c) === i; }).length;
    return out;
  }
  var onlyPending = false;
  function renderListChips(total, pendCount) {
    $("#plt-chips").innerHTML = '<button type="button" class="st-filter' + (onlyPending ? "" : " is-active") + '" data-pend="0">' + escapeHtml(T("plt.all")) + " <b>" + total + "</b></button>" +
      '<button type="button" class="st-filter st-filter--warn' + (onlyPending ? " is-active" : "") + '" data-pend="1">' + escapeHtml(T("plt.withPend")) + " <b>" + pendCount + "</b></button>";
  }
  $("#plt-chips").addEventListener("click", function (e) {
    var b = e.target.closest("[data-pend]");
    if (!b) return;
    onlyPending = b.getAttribute("data-pend") === "1";
    renderList();
  });

  $("#search").addEventListener("input", renderList);
  $("#cat-filter").addEventListener("change", renderList);

  /* ----- Change log of the products (who changed what, and when) ----- */
  var productLog = [];
  function logMoney(v) { return v == null || v === "" ? "—" : money(v, defaultCurrency); }
  function quoted(v) { return v ? "\u201c" + v + "\u201d" : "—"; }
  function catLabel(k) { return k ? T("cat." + k) : "—"; }
  function logChange(c) {
    switch (c.t) {
      case "name": return T("plog.c.name", { from: quoted(c.from), to: quoted(c.to) });
      case "nameTr": return T("plog.c.nameTr", { lang: c.lang.toUpperCase(), from: quoted(c.from), to: quoted(c.to) });
      case "description": return T("plog.c.description", { from: quoted(c.from), to: quoted(c.to) });
      case "descriptionTr": return T("plog.c.descriptionTr", { lang: c.lang.toUpperCase(), from: quoted(c.from), to: quoted(c.to) });
      case "category": return T("plog.c.category", { from: catLabel(c.from), to: catLabel(c.to) });
      case "attrAdded": return T("plog.c.attrAdded", { attr: c.attr, options: (c.options || []).join(", ") });
      case "attrRemoved": return T("plog.c.attrRemoved", { attr: c.attr });
      case "attrRenamed": return T("plog.c.attrRenamed", { from: quoted(c.from), to: quoted(c.to) });
      case "optAdded": return T("plog.c.optAdded", { attr: c.attr, option: c.option });
      case "optRemoved": return T("plog.c.optRemoved", { attr: c.attr, option: c.option });
      case "optRenamed": return T("plog.c.optRenamed", { attr: c.attr, from: quoted(c.from), to: quoted(c.to) });
      case "photo": return T("plog.c.photo");
      case "variantPhoto": return T("plog.c.variantPhoto", { code: c.code });
      case "variantPhotoRemoved": return T("plog.c.variantPhotoRemoved", { code: c.code });
      case "supAdded": return T("plog.c.supAdded", { supplier: c.supplier }) + (c.cost != null ? " (" + T("plog.c.costIs", { cost: logMoney(c.cost) }) + ")" : "");
      case "supRemoved": return T("plog.c.supRemoved", { supplier: c.supplier });
      case "cost": return T("plog.c.cost", { supplier: c.supplier, from: logMoney(c.from), to: logMoney(c.to) });
      case "variantCost": return T("plog.c.variantCost", { code: c.code, supplier: c.supplier, from: logMoney(c.from), to: logMoney(c.to) });
      case "techAdded": return T("plog.c.techAdded", { n: c.n });
      case "galleryAdded": return c.to ? T("plog.c.galleryAddedLinked", { to: c.to }) : T("plog.c.galleryAdded");
      case "galleryRemoved": return T("plog.c.galleryRemoved");
      case "galleryLink": return T("plog.c.galleryLink", { from: c.from || T("gal.noLink"), to: c.to || T("gal.noLink") });
      case "techRemoved": return T("plog.c.techRemoved", { n: c.n });
      case "specAdded": return T("plog.c.specAdded", { code: c.code });
      case "specRemoved": return T("plog.c.specRemoved", { code: c.code });
      case "specArchived": return T("plog.c.specArchived", { code: c.code });
      case "specRestored": return T("plog.c.specRestored", { code: c.code });
      case "specField": return T("plog.c.specField", { code: c.code, field: T("spec.f." + c.field), from: quoted(c.from), to: quoted(c.to) });
      case "clientSpec": return T("plog.c.clientSpec", { client: c.client, code: c.code, field: T("cs." + (["sampleDate", "sample", "name", "supplier", "cost"].indexOf(c.field) > -1 ? c.field : "requirements")), from: quoted(c.from), to: quoted(c.to) });
      case "price": return T("plog.c.price", { code: c.code, from: logMoney(c.from), to: logMoney(c.to) });
      case "clientRef": return T("plog.c.clientRef", { client: c.client + (c.code ? " · " + c.code : ""), from: quoted(c.from), to: quoted(c.to) });
      default: return c.t;
    }
  }
  function logItemHtml(e, withProduct) {
    var when = new Date(e.at).toLocaleString(HTML_LANG[current], { dateStyle: "short", timeStyle: "short" });
    var lines = (e.changes || []).map(function (c) { return "<li>" + escapeHtml(logChange(c)) + "</li>"; }).join("");
    return '<li class="plog-entry plog-entry--' + escapeHtml(e.action) + '"><div class="plog-entry__head">' +
      "<b>" + escapeHtml(T("plog.a." + e.action)) + "</b>" +
      (withProduct ? '<span class="plog-entry__prod">' + (e.sku ? '<span class="sku">' + escapeHtml(e.sku) + "</span> " : "") + escapeHtml(e.name) + "</span>" : "") +
      '<span class="plog-entry__meta">' + escapeHtml(when) + " · " + escapeHtml(e.user || "?") + "</span></div>" +
      (lines ? "<ul>" + lines + "</ul>" : "") + "</li>";
  }
  function loadOwnLog(id) {
    $("#plog-own").hidden = true;
    api("/api/products?log=1&id=" + encodeURIComponent(id)).then(function (d) {
      if (form.elements.id.value !== id) return; // another product opened meanwhile
      var list = d.log || [];
      $("#plog-own-list").innerHTML = list.length ? list.map(function (e) { return logItemHtml(e, false); }).join("") : '<li class="muted">' + escapeHtml(T("pp.noHistory")) + "</li>";
    }).catch(function () {});
  }
  function renderLogDialog() {
    var user = $("#plog-user").value, qv = $("#plog-q").value.trim().toLowerCase();
    var period = periodOf($("#plog-period").value);
    var shown = productLog.filter(function (e) {
      if (user && e.user !== user) return false;
      if (period) { var d = localDay(e.at); if (d < period.from || d > period.to) return false; }
      return !qv || (String(e.sku || "") + " " + e.name).toLowerCase().indexOf(qv) > -1;
    });
    $("#plog-count").textContent = T("list.shownOf", { n: shown.length, total: productLog.length });
    $("#plog-empty").hidden = shown.length > 0;
    $("#plog-list").innerHTML = shown.slice(0, 300).map(function (e) { return logItemHtml(e, true); }).join("");
  }
  $("#plog-open").addEventListener("click", function () {
    var dlg = $("#plog-dlg");
    $("#plog-list").innerHTML = "<li class=\"muted\">…</li>";
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    api("/api/products?log=1").then(function (d) {
      productLog = d.log || [];
      var users = productLog.map(function (e) { return e.user; }).filter(function (u, i, a) { return u && a.indexOf(u) === i; }).sort();
      var sel = $("#plog-user"), keep = sel.value;
      sel.innerHTML = '<option value="">' + escapeHtml(T("plog.allUsers")) + "</option>" + users.map(function (u) { return '<option value="' + escapeHtml(u) + '">' + escapeHtml(u) + "</option>"; }).join("");
      sel.value = users.indexOf(keep) > -1 ? keep : "";
      renderLogDialog();
    }).catch(function (err) { $("#plog-list").innerHTML = '<li class="status is-error">' + escapeHtml(err.message) + "</li>"; });
  });
  ["#plog-user", "#plog-period"].forEach(function (s) { $(s).addEventListener("change", renderLogDialog); });
  $("#plog-q").addEventListener("input", renderLogDialog);
  $("#plog-dlg").addEventListener("click", function (e) { if (e.target === this || e.target.closest("[data-close]")) this.close(); });

  /* ----- Filter by registration date ----- */
  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  // The day (in this computer's time zone) a product was registered: "2026-11-17".
  function localDay(iso) { return iso ? ymd(new Date(iso)) : ""; }
  // { from, to } as "YYYY-MM-DD" (both included), or null for any date.
  function datePeriod() { return periodOf($("#date-filter").value); }
  function periodOf(v) {
    var now = new Date();
    if (!v) return null;
    if (v === "today") return { from: ymd(now), to: ymd(now) };
    if (v === "month") return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(now) };
    if (v === "range") {
      var from = $("#date-from").value, to = $("#date-to").value;
      if (from && to && from > to) { var t = from; from = to; to = t; }
      return from || to ? { from: from, to: to } : null;
    }
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (Number(v) - 1));
    return { from: ymd(start), to: ymd(now) };
  }
  $("#date-filter").addEventListener("change", function () {
    var range = this.value === "range";
    document.querySelectorAll("#date-filters .date-range").forEach(function (el) { el.hidden = !range; });
    if (range && !$("#date-from").value) $("#date-from").focus();
    renderList();
  });
  $("#date-from").addEventListener("change", renderList);
  $("#date-to").addEventListener("change", renderList);
  // Products of a client: linked to it (its code or data on a specification) or on its proformas.
  function hasClient(p, cid) {
    return Boolean((p.clientRefs && p.clientRefs[cid] && Object.keys(p.clientRefs[cid]).length) || (p.clientSpecs && p.clientSpecs[cid] && Object.keys(p.clientSpecs[cid]).length));
  }
  function clientProductIds(cid) {
    var out = {};
    var pfs = window.Proformas && window.Proformas.list ? window.Proformas.list() : [];
    pfs.forEach(function (pf) { if (pf.clientId === cid) (pf.items || []).forEach(function (i) { out[i.productId] = true; }); });
    return out;
  }
  function fillClientFilter() {
    var sel = $("#client-filter"), keep = sel.value;
    sel.innerHTML = '<option value="">' + escapeHtml(T("list.allClients")) + "</option>" +
      clients.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
        .map(function (c) { return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + "</option>"; }).join("");
    sel.value = keep;
  }
  $("#client-filter").addEventListener("change", renderList);
  document.addEventListener("admin:data", fillClientFilter);
  document.addEventListener("admin:lang", fillClientFilter);
  $("#filters-clear").addEventListener("click", function () {
    $("#client-filter").value = "";
    $("#search").value = "";
    $("#cat-filter").value = "";
    $("#date-filter").value = "";
    $("#date-from").value = ""; $("#date-to").value = "";
    document.querySelectorAll("#date-filters .date-range").forEach(function (el) { el.hidden = true; });
    renderList();
  });

  listEl.addEventListener("click", function (e) {
    var row = e.target.closest("[data-open-product]");
    if (!row) return;
    var p = products.filter(function (x) { return x.id === row.getAttribute("data-open-product"); })[0];
    if (p) editProduct(p);
  });
  function deleteProduct(p, btn) {
    if (!confirm(T("list.confirmDelete", { name: p.name[current] || p.source.name }))) return;
    if (btn) btn.disabled = true;
    api("/api/products?id=" + encodeURIComponent(p.id), { method: "DELETE" })
      .then(function () {
        products = products.filter(function (x) { return x.id !== p.id; });
        resetForm();
        renderList();
        loadSuppliers();
        $("#list-flash").textContent = T("status.deleted");
        $("#list-flash").hidden = false;
      })
      .catch(function (e2) { if (btn) btn.disabled = false; alert(e2.message); });
  }
  // Product page header: history, duplicate, more (delete)
  function openProduct() { var id = form.elements.id.value; return id && products.filter(function (x) { return x.id === id; })[0]; }
  $("#pp-history").addEventListener("click", function () {
    var own = $("#plog-own"), show = own.hidden;
    own.hidden = !show; own.open = true;
    this.setAttribute("aria-expanded", show ? "true" : "false");
  });
  $("#pp-dup").addEventListener("click", function () { var p = openProduct(); if (p) duplicateProduct(p); });
  $("#pp-more").addEventListener("click", function (e) {
    e.stopPropagation();
    var m = $("#pp-menu"); m.hidden = !m.hidden;
    this.setAttribute("aria-expanded", m.hidden ? "false" : "true");
  });
  document.addEventListener("click", function (e) { if (!e.target.closest(".pp-more")) $("#pp-menu").hidden = true; });
  $("#pp-delete").addEventListener("click", function () { var p = openProduct(); $("#pp-menu").hidden = true; if (p) deleteProduct(p, this); });

  /* ---------- SKU codes ---------- */
  // Variant codes of a product ("1001-1"), each with its option labels, in suffix order.
  // Specifications of a product (archived ones only when asked).
  function variantCodes(p, withArchived) {
    var map = p.variantSkus || {};
    var specs = p.specs || {};
    return Object.keys(map).filter(function (key) { return withArchived || !(specs[key] && specs[key].archived); })
      .sort(function (a, b) { return map[a] - map[b]; }).map(function (key) {
      var ids = key.split(",");
      // "Name: value" in the order of the characteristics (e.g. "Ângulo: 75° · Rosca: 3/4"").
      var label = (p.attributes || []).map(function (a) {
        var o = a.options.filter(function (x) { return ids.indexOf(x.id) > -1; })[0];
        if (!o) return "";
        var value = (o.label && o.label[current]) || o.source;
        var name = (a.name && a.name[current]) || a.source;
        return name ? name + ": " + value : value;
      }).filter(Boolean).join(" · ");
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
    setTimeout(renderPreview, 0);
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
    // Only suppliers of the product's category (plus those without a category yet
    // and the ones already linked), unless "show all" is on.
    var cat = form.elements.category.value;
    var hidden = 0;
    if (cat) {
      var fits = candidates.filter(function (s) {
        var cats = s.categories || [];
        return selectedSuppliers.has(s.id) || !cats.length || cats.indexOf(cat) > -1;
      });
      hidden = candidates.length - fits.length;
      if (!showAllSuppliers) candidates = fits;
    }
    var filterEl = $("#supplier-filter");
    filterEl.hidden = !cat || !hidden;
    if (cat && hidden) {
      filterEl.innerHTML = escapeHtml(T(showAllSuppliers ? "form.supAll" : "form.supOfCat", { cat: T("cat." + cat), n: hidden })) +
        ' <button type="button" class="linkbtn" id="supplier-filter-toggle">' + escapeHtml(T(showAllSuppliers ? "form.supShowCat" : "form.supShowAll")) + "</button>";
    }
    $("#supplier-picker-empty").hidden = candidates.length > 0;
    $("#supplier-search").hidden = candidates.length === 0;
    picker.hidden = candidates.length === 0;
    $("#supplier-selected").textContent = selectedSuppliers.size ? T("form.suppliersSelected", { n: selectedSuppliers.size }) : "";
    var shown = candidates.filter(function (s) {
      return !q || (s.company + " " + (s.companyZh || "") + " " + placeLabel(s) + " " + (s.province || "") + (s.cityZh || "") + " " + s.contact).toLowerCase().indexOf(q) > -1;
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
      var noCat = s.productSupplier !== false && !(s.categories || []).length;
      return '<div class="picker__item' + (on ? " is-on" : "") + '"><label><input type="checkbox" value="' + escapeHtml(s.id) + '"' +
        (on ? " checked" : "") + " /><span><b>" + escapeHtml(s.company) + (s.companyZh ? ' <span class="sitem__zh" lang="zh">' + escapeHtml(s.companyZh) + "</span>" : "") + "</b>" +
        (placeLabel(s) || noCat ? "<small>" + escapeHtml(placeLabel(s)) + (noCat ? '<em class="picker__nocat">' + (placeLabel(s) ? " · " : "") + escapeHtml(T("sup.noCategory")) + "</em>" : "") + "</small>" : "") +
        "</span></label>" + cost + toggle + table + "</div>";
    }).join("") : '<p class="picker__none">' + escapeHtml(T("form.noMatch")) + "</p>";
  }

  var showAllSuppliers = false;
  $("#supplier-filter").addEventListener("click", function (e) {
    if (!e.target.closest("#supplier-filter-toggle")) return;
    showAllSuppliers = !showAllSuppliers;
    renderPicker();
  });
  form.elements.category.addEventListener("change", function () { showAllSuppliers = false; renderPicker(); });

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
  var SUP_FIELDS = ["company", "companyZh", "contact", "phone", "wechat", "email", "city", "website", "notes"];

  /* ----- Province and city in China (lists; city depends on the province) ----- */
  var PLACES = window.CHINA_PLACES || [];
  function provinceOf(zh) { return PLACES.filter(function (p) { return p[1] === zh; })[0]; }
  function fillProvinces(value) {
    var sel = supForm.elements.province;
    sel.innerHTML = '<option value="">' + escapeHtml(T("sup.choose")) + "</option>" + PLACES.map(function (p) {
      return '<option value="' + escapeHtml(p[1]) + '">' + escapeHtml(p[0] + " · " + p[1]) + "</option>";
    }).join("");
    sel.value = value || "";
  }
  function fillCities(value) {
    var sel = supForm.elements.cityZh;
    var p = provinceOf(supForm.elements.province.value);
    sel.disabled = !p;
    sel.innerHTML = '<option value="">' + escapeHtml(T(p ? "sup.choose" : "sup.provinceFirst")) + "</option>" + (p ? p[2].map(function (c) {
      return '<option value="' + escapeHtml(c[1]) + '">' + escapeHtml(c[0] + " · " + c[1]) + "</option>";
    }).join("") : "");
    sel.value = value || "";
  }
  // "Foshan, Guangdong" (plus the address typed); older suppliers show the city they typed.
  function placeLabel(s) {
    var p = s.province && provinceOf(s.province);
    var c = p && p[2].filter(function (x) { return x[1] === s.cityZh; })[0];
    var where = p ? (c ? c[0] + ", " : "") + p[0] : "";
    return [where, s.city || ""].filter(Boolean).join(" · ");
  }
  supForm.elements.province.addEventListener("change", function () { fillCities(""); this.classList.remove("is-invalid"); });
  supForm.elements.cityZh.addEventListener("change", function () { this.classList.remove("is-invalid"); });
  fillProvinces("");
  fillCities("");
  document.addEventListener("admin:lang", function () { // placeholders in the new language, choice kept
    var city = supForm.elements.cityZh.value;
    fillProvinces(supForm.elements.province.value);
    fillCities(city);
  });

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
    $("#sup-cats").hidden = !supForm.elements.productSupplier.checked; // categories only for product suppliers
    $("#sup-catalogs").hidden = !supForm.elements.productSupplier.checked; // catalogs too
    renderCatalogs();
    supForm.classList.toggle("is-expense", !supForm.elements.productSupplier.checked); // hides the "*" of fields only products need
    $("#supplier-title").textContent = T(editing ? "sup.edit" : "sup.new");
    $("#supplier-save").textContent = T(editing ? "sup.saveChanges" : "sup.save");
    $("#supplier-cancel").hidden = !editing;
  }

  function resetSupplierForm() {
    pendingCatalogs = [];
    setCatalogStatus("");
    supForm.reset();
    fillProvinces("");
    fillCities("");
    supForm.elements.id.value = "";
    supForm.elements.company.classList.remove("is-invalid");
    updateSupplierMode();
    renderSuppliers();
  }

  function editSupplier(s) {
    resetSupplierForm();
    supForm.elements.id.value = s.id;
    SUP_FIELDS.forEach(function (f) { supForm.elements[f].value = s[f] || ""; });
    fillProvinces(s.province);
    fillCities(s.cityZh);
    supForm.elements.productSupplier.checked = s.productSupplier !== false;
    supForm.querySelectorAll('input[name="cat"]').forEach(function (c) { c.checked = (s.categories || []).indexOf(c.value) > -1; });
    updateSupplierMode();
    setSupplierStatus("");
    renderSuppliers();
    $("#supplier-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("#supplier-cancel").addEventListener("click", function () { resetSupplierForm(); setSupplierStatus(""); });
  supForm.elements.productSupplier.addEventListener("change", updateSupplierMode);

  supForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = supForm.elements.id.value;
    var body = {};
    SUP_FIELDS.forEach(function (f) { body[f] = supForm.elements[f].value; });
    body.province = supForm.elements.province.value;
    body.cityZh = supForm.elements.cityZh.value;
    body.productSupplier = supForm.elements.productSupplier.checked;
    body.categories = body.productSupplier ? Array.prototype.filter.call(supForm.querySelectorAll('input[name="cat"]'), function (c) { return c.checked; })
      .map(function (c) { return c.value; }) : [];
    // A product supplier needs every field except website, phone/WhatsApp and notes.
    var missing = [];
    if (!body.company.trim()) missing.push("company");
    if (body.productSupplier) {
      ["companyZh", "contact", "wechat", "email", "province", "cityZh"].forEach(function (f) { if (!String(body[f] || "").trim()) missing.push(f); });
      if (body.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) && missing.indexOf("email") < 0) missing.push("email");
      if (!body.categories.length) missing.push("categories");
    }
    if (markSupplierMissing(missing)) return;
    var btn = $("#supplier-save");
    btn.disabled = true;
    api(id ? "/api/suppliers?id=" + encodeURIComponent(id) : "/api/suppliers", { method: id ? "PUT" : "POST", body: body })
      .then(function (data) {
        if (id) suppliers = suppliers.map(function (x) { return x.id === id ? data.supplier : x; });
        else suppliers.unshift(data.supplier);
        // Catalogs chosen before the supplier existed go up now.
        var queued = data.supplier.productSupplier !== false ? pendingCatalogs.slice() : [];
        resetSupplierForm();
        renderPicker();
        renderList();
        setSupplierStatus(T("sup.saved"), "ok");
        if (queued.length) {
          return uploadCatalogs(data.supplier.id, queued, function (msg) { setSupplierStatus(msg); }).then(function (errors) {
            setSupplierStatus(errors.length ? T("sup.savedCatalogErr", { errors: errors.join(" · ") }) : T("sup.savedWithCatalogs"), errors.length ? "error" : "ok");
          });
        }
      })
      .catch(function (e2) {
        if (e2.data && e2.data.missing) return markSupplierMissing(e2.data.missing);
        setSupplierStatus(/Server error|Erro \d/.test(e2.message) ? T("status.error") : e2.message, "error");
      })
      .then(function () { btn.disabled = false; });
  });

  // Marks the missing fields and says which they are; true when something is missing.
  function markSupplierMissing(missing) {
    ["company", "companyZh", "contact", "wechat", "email", "province", "cityZh", "notes"].forEach(function (f) {
      supForm.elements[f].classList.toggle("is-invalid", missing.indexOf(f) > -1);
    });
    $("#sup-cats").classList.toggle("is-invalid", missing.indexOf("categories") > -1);
    if (!missing.length) return false;
    var names = missing.map(function (f) { return f === "categories" ? T("sup.categories") : T("sup." + f).replace(/\s*\*$/, ""); });
    setSupplierStatus(T(missing.length === 1 && missing[0] === "company" ? "sup.required" : "sup.requiredFields", { fields: names.join(", ") }), "error");
    var first = missing[0] === "categories" ? $("#sup-cats input") : supForm.elements[missing[0]];
    if (first) first.focus();
    return true;
  }
  supForm.addEventListener("input", function (e) { if (e.target.classList) e.target.classList.remove("is-invalid"); });
  $("#sup-cats").addEventListener("change", function () { this.classList.remove("is-invalid"); });

  /* ----- Supplier catalogs: uploaded in parts of 3 MB, read back and joined ----- */
  var CATALOG_PART = 3 * 1024 * 1024, CATALOG_MAX = 5 * 1024 * 1024;
  var CATALOG_TYPES = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip"
  };
  var pendingCatalogs = [];
  function catalogType(file) {
    var ext = (file.name.match(/\.([a-z0-9]+)$/i) || [])[1];
    return ext ? CATALOG_TYPES[ext.toLowerCase()] || null : null;
  }
  function sizeText(n) {
    return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toLocaleString(HTML_LANG[current], { maximumFractionDigits: 1 }) + " MB";
  }
  function setCatalogStatus(msg, kind) {
    var el = $("#sup-catalog-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }
  function catalogIcon(type) {
    return /pdf/.test(type) ? "PDF" : /image/.test(type) ? "IMG" : /sheet|excel/.test(type) ? "XLS" : /word/.test(type) ? "DOC" : /presentation|powerpoint/.test(type) ? "PPT" : "ZIP";
  }
  function renderCatalogs() {
    var id = supForm.elements.id.value;
    var s = id ? suppliers.filter(function (x) { return x.id === id; })[0] : null;
    var saved = (s && s.catalogs) || [];
    $("#sup-catalog-list").innerHTML = saved.map(function (c) {
      return '<li><button type="button" class="linkbtn" data-cat-open="' + escapeHtml(c.id) + '" data-sup="' + escapeHtml(id) + '"><span class="fin-file-ico">' + catalogIcon(c.type) + "</span>" +
        escapeHtml(c.name) + "</button><small>" + escapeHtml(sizeText(c.size)) + '</small><button type="button" class="linkbtn danger" data-cat-del="' + escapeHtml(c.id) + '">' + escapeHtml(T("sup.removeCatalog")) + "</button></li>";
    }).join("") + (pendingCatalogs || []).map(function (f, k) {
      return '<li class="is-pending"><span><span class="fin-file-ico">' + catalogIcon(catalogType(f) || "") + "</span>" + escapeHtml(f.name) + "</span><small>" +
        escapeHtml(sizeText(f.size) + " · " + T("sup.catalogPending")) + '</small><button type="button" class="linkbtn danger" data-cat-unqueue="' + k + '">' + escapeHtml(T("sup.removeCatalog")) + "</button></li>";
    }).join("");
  }
  function readPart(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).replace(/^data:[^,]*,/, "")); };
      r.onerror = function () { reject(new Error(T("sup.catalogError"))); };
      r.readAsDataURL(blob);
    });
  }
  function checkCatalog(file) {
    if (!catalogType(file)) return T("sup.catalogType", { name: file.name });
    if (file.size > CATALOG_MAX) return T("sup.catalogBig", { name: file.name, size: sizeText(file.size) });
    if (!file.size) return T("sup.catalogType", { name: file.name });
    return "";
  }
  // One file: its parts, then the catalog entry. Parts already sent are removed on failure.
  function uploadCatalog(supplierId, file, progress) {
    var base = "/api/suppliers?id=" + encodeURIComponent(supplierId);
    var count = Math.ceil(file.size / CATALOG_PART), refs = [];
    var chain = Promise.resolve();
    for (var k = 0; k < count; k++) {
      (function (k) {
        chain = chain.then(function () {
          progress(T("sup.catalogUploading", { name: file.name, pct: Math.round(k / count * 100) }));
          return readPart(file.slice(k * CATALOG_PART, (k + 1) * CATALOG_PART));
        }).then(function (data) {
          return api(base + "&kind=part", { method: "POST", body: { data: data } });
        }).then(function (d) { refs.push(d.ref); });
      })(k);
    }
    return chain.then(function () {
      return api(base + "&kind=catalog", { method: "POST", body: { name: file.name, type: catalogType(file), size: file.size, refs: refs } });
    }).then(function (d) {
      suppliers = suppliers.map(function (x) { return x.id === supplierId ? d.supplier : x; });
      return d;
    }, function (err) {
      if (refs.length) api(base + "&kind=discard", { method: "POST", body: { refs: refs } }).catch(function () {});
      throw err;
    });
  }
  function uploadCatalogs(supplierId, files, progress) {
    var errors = [];
    return files.reduce(function (chain, f) {
      return chain.then(function () {
        return uploadCatalog(supplierId, f, progress).catch(function (e) {
          errors.push(/larger than 5 MB/.test(e.message) ? T("sup.catalogBig", { name: f.name, size: sizeText(f.size) }) : f.name + ": " + e.message);
        });
      });
    }, Promise.resolve()).then(function () {
      renderSuppliers();
      renderCatalogs();
      return errors;
    });
  }
  // Reads the parts back and opens the file (PDF and images in a new tab, others downloaded).
  function openCatalog(supplierId, fileId) {
    var s = suppliers.filter(function (x) { return x.id === supplierId; })[0];
    var c = s && (s.catalogs || []).filter(function (x) { return x.id === fileId; })[0];
    if (!c) return;
    var viewable = /^(application\/pdf|image\/)/.test(c.type);
    var win = viewable ? window.open("", "_blank") : null;
    if (win) win.document.write("<p style=\"font:14px sans-serif;padding:20px\">" + escapeHtml(T("sup.catalogOpening")) + "</p>");
    var parts = [];
    var chain = Promise.resolve();
    for (var k = 0; k < c.parts; k++) {
      (function (k) {
        chain = chain.then(function () {
          return fetch("/api/suppliers?id=" + encodeURIComponent(supplierId) + "&kind=catalog&file=" + encodeURIComponent(fileId) + "&part=" + k,
            { credentials: "same-origin", cache: "no-store" });
        }).then(function (r) {
          if (!r.ok) throw new Error(T("sup.catalogError"));
          return r.arrayBuffer();
        }).then(function (b) { parts.push(b); });
      })(k);
    }
    return chain.then(function () {
      var url = URL.createObjectURL(new Blob(parts, { type: c.type }));
      if (win) win.location.href = url;
      else {
        var a = document.createElement("a");
        a.href = url; a.download = c.name;
        document.body.appendChild(a); a.click(); a.remove();
      }
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    }).catch(function (e) {
      if (win) win.close();
      alert(e.message);
    });
  }
  $("#sup-catalog-file").addEventListener("change", function (e) {
    var files = Array.prototype.slice.call(e.target.files);
    e.target.value = "";
    var problems = files.map(checkCatalog).filter(Boolean);
    files = files.filter(function (f) { return !checkCatalog(f); });
    if (problems.length) setCatalogStatus(problems.join(" · "), "error"); else setCatalogStatus("");
    if (!files.length) return;
    var id = supForm.elements.id.value;
    if (!id) {
      // New supplier: the files go up once it is saved.
      pendingCatalogs = pendingCatalogs.concat(files);
      renderCatalogs();
      if (!problems.length) setCatalogStatus(T("sup.catalogQueued"));
      return;
    }
    var input = $("#sup-catalog-file"); input.disabled = true;
    uploadCatalogs(id, files, function (msg) { setCatalogStatus(msg); }).then(function (errors) {
      input.disabled = false;
      var all = problems.concat(errors);
      setCatalogStatus(all.length ? all.join(" · ") : T("sup.catalogSaved"), all.length ? "error" : "ok");
    });
  });
  $("#sup-catalog-list").addEventListener("click", function (e) {
    var open = e.target.closest("[data-cat-open]");
    var del = e.target.closest("[data-cat-del]");
    var unq = e.target.closest("[data-cat-unqueue]");
    if (open) return openCatalog(open.getAttribute("data-sup"), open.getAttribute("data-cat-open"));
    if (unq) { pendingCatalogs.splice(Number(unq.getAttribute("data-cat-unqueue")), 1); renderCatalogs(); return; }
    if (del) {
      if (!confirm(T("sup.catalogConfirm"))) return;
      var id = supForm.elements.id.value;
      api("/api/suppliers?id=" + encodeURIComponent(id) + "&kind=catalog&file=" + encodeURIComponent(del.getAttribute("data-cat-del")), { method: "DELETE" })
        .then(function (d) {
          suppliers = suppliers.map(function (x) { return x.id === id ? d.supplier : x; });
          renderSuppliers(); renderCatalogs(); setCatalogStatus(T("sup.catalogRemoved"), "ok");
        }, function (err) { setCatalogStatus(err.message, "error"); });
    }
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
      return !q || SUP_FIELDS.concat(["province", "cityZh"]).some(function (f) { return String(s[f] || "").toLowerCase().indexOf(q) > -1; }) || placeLabel(s).toLowerCase().indexOf(q) > -1;
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
        "<div><h3>" + escapeHtml(s.company) + (s.companyZh ? ' <span class="sitem__zh" lang="zh">' + escapeHtml(s.companyZh) + "</span>" : "") + ' <span class="sup-tag' + (s.productSupplier === false ? " sup-tag--other" : "") + '">' +
          escapeHtml(T(s.productSupplier === false ? "sup.tagOther" : "sup.tagProducts")) + "</span></h3>" +
        (placeLabel(s) ? '<p class="pitem__lang">' + escapeHtml(placeLabel(s)) + "</p>" : "") +
        (s.productSupplier !== false ? '<p class="sitem__cats">' + ((s.categories || []).length ? s.categories.map(function (c) { return '<span class="pitem__cat">' + escapeHtml(T("cat." + c)) + "</span>"; }).join("")
          : '<span class="muted">' + escapeHtml(T("sup.noCategory")) + "</span>") + "</p>" : "") +
        (contact.length ? '<p class="sitem__contact">' + contact.join(" · ") + "</p>" : "") +
        (s.productSupplier !== false && (s.catalogs || []).length ? '<p class="sitem__catalogs"><span class="sitem__label">' + escapeHtml(T("sup.catalogs")) + "</span>" +
          s.catalogs.map(function (c) { return '<button type="button" class="linkbtn" data-cat-open="' + escapeHtml(c.id) + '" data-sup="' + escapeHtml(s.id) + '">' + escapeHtml(c.name) + "</button>"; }).join("") + "</p>" : "") +
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
    var cat = e.target.closest("[data-cat-open]");
    if (cat) return openCatalog(cat.getAttribute("data-sup"), cat.getAttribute("data-cat-open"));
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
  var CLI_FIELDS = ["name", "address", "country", "countryCode", "phone", "taxId"];

  // Country suggestions and the code they put in the proforma / invoice numbers.
  var COUNTRIES = [
    ["Brasil", "BR"], ["Estados Unidos", "USA"], ["China", "CN"], ["Hong Kong", "HK"], ["Argentina", "AR"], ["Chile", "CL"],
    ["Uruguai", "UY"], ["Paraguai", "PY"], ["Bolívia", "BO"], ["Peru", "PE"], ["Colômbia", "CO"], ["Equador", "EC"],
    ["Venezuela", "VE"], ["México", "MX"], ["Canadá", "CA"], ["Portugal", "PT"], ["Espanha", "ES"], ["Itália", "IT"],
    ["França", "FR"], ["Alemanha", "DE"], ["Reino Unido", "UK"], ["Angola", "AO"], ["Moçambique", "MZ"], ["Panamá", "PA"],
    ["Costa Rica", "CR"], ["República Dominicana", "DO"], ["Emirados Árabes Unidos", "UAE"], ["Austrália", "AU"]
  ];
  function plain(t) { return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase(); }
  // Any country, by its name in Portuguese, English, Spanish or Chinese (the browser's own
  // list of countries), as the server does (api/_lib/countries.js). USA, UK and UAE as the company uses them.
  var countryTable = null;
  function codeOfCountry(name) {
    var key = plain(name);
    if (!key) return "";
    if (!countryTable) {
      countryTable = {};
      COUNTRIES.forEach(function (c) { countryTable[plain(c[0])] = c[1]; });
      var own = { US: "USA", GB: "UK", AE: "UAE" };
      var skip = ["DD", "VD", "DY", "HV", "RH", "NH", "PU", "PZ", "WK", "JT", "MI", "PC", "YU", "CS", "SU", "ZR", "TP", "BU", "NT", "YD", "FX", "QO", "EU", "EZ", "UN", "XA", "XB", "ZZ", "QU", "AN", "IC", "EA", "CP", "DG", "TA", "AC", "CQ"];
      var extra = { "republica checa": "CZ", "hong kong": "HK", "macau": "MO", "macao": "MO", "taiwan": "TW", "eua": "USA", "usa": "USA", "inglaterra": "UK", "england": "UK", "holanda": "NL", "emirados arabes": "UAE", "dubai": "UAE", "coreia": "KR", "korea": "KR" };
      Object.keys(extra).forEach(function (k) { if (!countryTable[k]) countryTable[k] = extra[k]; });
      var L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      ["pt", "en", "es", "zh"].forEach(function (lang) {
        var names;
        try { names = new Intl.DisplayNames([lang], { type: "region" }); } catch (e) { return; }
        for (var i = 0; i < 26; i++) for (var j = 0; j < 26; j++) {
          var code = L[i] + L[j], n;
          try { n = names.of(code); } catch (e) { continue; }
          if (!n || n === code || skip.indexOf(code) > -1) continue;
          [plain(n), plain(n.split(/[,(（，]/)[0])].forEach(function (k) { if (k && !countryTable[k]) countryTable[k] = own[code] || code; });
        }
      });
    }
    return countryTable[key] || "";
  }
  $("#country-list").innerHTML = COUNTRIES.map(function (c) { return '<option value="' + escapeHtml(c[0]) + '"></option>'; }).join("");

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
      if (c.country || c.countryCode) details.push(escapeHtml((c.country || "") + (c.countryCode ? " (" + c.countryCode + ")" : "")));
      if (c.phone) details.push("☎ " + escapeHtml(c.phone));
      if (c.taxId) details.push(escapeHtml(T("cli.taxId") + ": " + c.taxId));
      return '<li class="pitem sitem' + (c.id === editing ? " is-editing" : "") + '" data-id="' + escapeHtml(c.id) + '">' +
        "<div><h3>" + escapeHtml(c.name) + "</h3>" +
        (c.address ? '<p class="sitem__notes">' + escapeHtml(c.address) + "</p>" : "") +
        (details.length ? '<p class="sitem__contact">' + details.join(" · ") + "</p>" : "") + "</div>" +
        '<div class="pitem__actions"><button type="button" class="crm-open" data-act="crm">' + escapeHtml(T("crm.open")) + "</button>" +
        '<button type="button" data-act="edit">' + escapeHtml(T("list.edit")) + "</button>" +
        '<button type="button" class="danger" data-act="delete">' + escapeHtml(T("list.delete")) + "</button></div></li>";
    }).join("");
  }

  $("#client-search").addEventListener("input", renderClients);
  // Choosing a known country fills its code (which can still be edited).
  // (typing, picking a suggestion, the browser's auto-complete or leaving the field)
  function fillCountryCode() {
    var code = codeOfCountry(cliForm.elements.country.value);
    if (code) cliForm.elements.countryCode.value = code;
  }
  ["input", "change", "blur"].forEach(function (ev) { cliForm.elements.country.addEventListener(ev, fillCountryCode); });
  cliForm.elements.countryCode.addEventListener("input", function () {
    this.value = this.value.toUpperCase().replace(/[^A-Z]/g, "");
  });
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

  function editClient(id) {
    var c = clients.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    resetClientForm();
    cliForm.elements.id.value = c.id;
    CLI_FIELDS.forEach(function (f) { cliForm.elements[f].value = c[f] || ""; });
    if (!cliForm.elements.countryCode.value) fillCountryCode(); // saved before the code was filled automatically
    updateClientMode();
    setClientStatus("");
    renderClients();
    $("#client-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  $("#client-list").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-act]");
    if (!btn) return;
    var id = btn.closest(".sitem").dataset.id;
    var c = clients.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    if (btn.dataset.act === "crm") { if (window.CRM) window.CRM.open(c.id); return; }
    if (btn.dataset.act === "edit") { editClient(c.id); return; }
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
  var SET_FIELDS = ["currency", "companyName", "companyTaxId", "address", "phone", "email", "website", "whatsapp", "wechatId",
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

  // refresh: data reloaded in the background — a form with unsaved typing is left alone.
  function fillSettings(settings, refresh) {
    var dirty = refresh && SET_FIELDS.some(function (f) { return setForm.elements[f].value !== ((companySettings && companySettings[f]) || (f === "currency" ? defaultCurrency : "")); });
    if (!dirty) SET_FIELDS.forEach(function (f) { setForm.elements[f].value = (settings && settings[f]) || ""; });
    defaultCurrency = (settings && CURRENCIES[settings.currency]) ? settings.currency : "CNY";
    if (!dirty) setForm.elements.currency.value = defaultCurrency;
    renderPicker();
    renderList();
    settingsUpdatedAt = settings && settings.updatedAt;
    companySettings = settings || {};
    if (!dirty) renderChecklist(companySettings.checklist);
    renderStamp();
    renderQr();
    renderSettingsUpdated();
    document.dispatchEvent(new CustomEvent("admin:data"));
  }

  /* ----- WeChat QR code shown on the public site ----- */
  var qrShown; // wechatQrAt of the image on screen
  function setQrStatus(msg, kind) {
    var el = $("#qr-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }
  function renderQr() {
    var at = companySettings.wechatQrAt || null;
    $("#qr-remove").hidden = !at;
    if (qrShown === at) return;
    qrShown = at;
    if (!at) { $("#qr-preview").innerHTML = "<span>" + escapeHtml(T("set.qrNone")) + "</span>"; return; }
    fetch("/api/settings?kind=contact&at=" + encodeURIComponent(at), { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (c) {
      $("#qr-preview").innerHTML = c.wechatQr ? '<img src="' + escapeHtml(c.wechatQr) + '" alt="" />' : "<span>" + escapeHtml(T("set.qrNone")) + "</span>";
    }).catch(function () {});
  }
  $("#qr-file").addEventListener("change", function (e) {
    var file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setQrStatus(T("set.stampType"), "error");
    if (file.size > 300 * 1024) return setQrStatus(T("set.qrBig"), "error");
    var fr = new FileReader();
    fr.onload = function () {
      setQrStatus("…");
      api("/api/settings?kind=wechatqr", { method: "POST", body: { data: fr.result } })
        .then(function (d) { companySettings = d.settings; renderQr(); setQrStatus(T("set.qrSaved"), "ok"); })
        .catch(function (err) { setQrStatus(/Unsupported/.test(err.message) ? T("set.stampType") : err.message, "error"); });
    };
    fr.readAsDataURL(file);
  });
  $("#qr-remove").addEventListener("click", function () {
    if (!confirm(T("set.qrConfirm"))) return;
    api("/api/settings?kind=wechatqr", { method: "DELETE" })
      .then(function (d) { companySettings = d.settings; renderQr(); setQrStatus(T("set.qrRemoved"), "ok"); })
      .catch(function (err) { setQrStatus(err.message, "error"); });
  });

  /* ----- Stamp and signature image (used on invoices) ----- */
  var stampShown = null; // uploadedAt of the image on screen
  function setStampStatus(msg, kind) {
    var el = $("#stamp-status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }
  // The image as a data URL (for the PDF), or null when there is none.
  function stampDataUrl() {
    if (!companySettings.stamp) return Promise.resolve(null);
    return fetch("/api/settings?kind=stamp", { credentials: "same-origin", cache: "no-store" }).then(function (r) {
      if (!r.ok) return null;
      return r.blob().then(function (b) {
        return new Promise(function (resolve) {
          var fr = new FileReader();
          fr.onload = function () { resolve(fr.result); };
          fr.onerror = function () { resolve(null); };
          fr.readAsDataURL(b);
        });
      });
    }).catch(function () { return null; });
  }
  function renderStamp() {
    var st = companySettings.stamp;
    $("#stamp-remove").hidden = !st;
    if (!st) { stampShown = null; $("#stamp-preview").innerHTML = '<span>' + escapeHtml(T("set.stampNone")) + "</span>"; return; }
    if (stampShown === st.uploadedAt) return;
    stampShown = st.uploadedAt;
    stampDataUrl().then(function (url) {
      $("#stamp-preview").innerHTML = url ? '<img src="' + escapeHtml(url) + '" alt="" />' : '<span>' + escapeHtml(T("set.stampNone")) + "</span>";
    });
  }
  $("#stamp-file").addEventListener("change", function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) return setStampStatus(T("set.stampType"), "error");
    if (file.size > 1.5 * 1048576) return setStampStatus(T("set.stampBig"), "error");
    setStampStatus(T("fin.uploading"));
    var fr = new FileReader();
    fr.onload = function () {
      api("/api/settings?kind=stamp", { method: "POST", body: { data: fr.result } })
        .then(function (d) { companySettings = d.settings; renderStamp(); setStampStatus(T("set.stampSaved"), "ok"); })
        .catch(function (err) { setStampStatus(/Unsupported/.test(err.message) ? T("set.stampType") : err.message, "error"); });
    };
    fr.readAsDataURL(file);
  });
  $("#stamp-remove").addEventListener("click", function () {
    if (!confirm(T("set.stampConfirm"))) return;
    api("/api/settings?kind=stamp", { method: "DELETE" })
      .then(function (d) { companySettings = d.settings; renderStamp(); setStampStatus(T("set.stampRemoved"), "ok"); })
      .catch(function (err) { setStampStatus(err.message, "error"); });
  });

  var CHECK_CATS = ["sanitary", "building", "fitness", "general"];
  var CHECK_FIELDS = ["details", "weight", "measures", "packaging", "photo"];
  function renderChecklist(c) {
    var box = $("#set-checklist");
    if (!box) return;
    box.innerHTML = '<table><thead><tr><th></th>' + CHECK_FIELDS.map(function (f) { return "<th>" + escapeHtml(T("spec.f." + f)) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      CHECK_CATS.map(function (cat) {
        var on = c && Array.isArray(c[cat]) ? c[cat] : ["details"];
        return "<tr><th>" + escapeHtml(T("cat." + cat)) + "</th>" + CHECK_FIELDS.map(function (f) {
          return '<td><input type="checkbox" data-cat="' + cat + '" data-field="' + f + '"' + (on.indexOf(f) > -1 ? " checked" : "") +
            ' aria-label="' + escapeHtml(T("cat." + cat) + " · " + T("spec.f." + f)) + '" /></td>';
        }).join("") + "</tr>";
      }).join("") + "</tbody></table>";
  }
  function readChecklist() {
    var out = {};
    CHECK_CATS.forEach(function (cat) { out[cat] = []; });
    Array.prototype.forEach.call(document.querySelectorAll("#set-checklist input:checked"), function (el) { out[el.getAttribute("data-cat")].push(el.getAttribute("data-field")); });
    return out;
  }
  document.addEventListener("admin:lang", function () { if (companySettings) renderChecklist(readChecklistOr()); });
  function readChecklistOr() { return document.querySelector("#set-checklist input") ? readChecklist() : companySettings.checklist; }

  function loadSettings() {
    api("/api/settings").then(function (data) { fillSettings(data.settings); })
      .catch(function (e) { setSettingsStatus(e.message, "error"); });
  }

  setForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = {};
    SET_FIELDS.forEach(function (f) { body[f] = setForm.elements[f].value; });
    if (document.querySelector("#set-checklist input")) body.checklist = readChecklist();
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
    stampDataUrl: stampDataUrl,
    defaultCurrency: function () { return defaultCurrency; },
    variantCodes: variantCodes,
    squareImage: resizeImage,
    photoFor: photoFor,
    editProduct: function (id, tab) { var p = products.filter(function (x) { return x.id === id; })[0]; if (p) { showTab("products"); editProduct(p, tab); } },
    openProductId: function () { return form.elements.id.value; },
    showTab: showTab,
    editClient: editClient,
    productName: function (p) { return (p.name && (p.name[current] || p.name.en || p.name.pt)) || (p.source && p.source.name) || ""; },
    // Products changed elsewhere (pricing screen): replaced in the list.
    replaceProducts: function (list) {
      list.forEach(function (np) {
        var i = products.findIndex(function (x) { return x.id === np.id; });
        if (i > -1) products[i] = np; else products.unshift(np);
      });
      renderList();
      renderPicker();
    },
    reloadProducts: loadProducts,
    reloadAll: loadAll,
    parseDecimal: parseDecimal,
    showTab: showTab
  };

  /* ---------- Start ---------- */
  setLang(detectPanelLang());
  api("/api/session").then(function (s) { s.authenticated ? showApp() : showLogin(); }, showLogin);
})();
