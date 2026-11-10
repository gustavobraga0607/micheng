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
  var selectedSuppliers = new Set(); // supplier ids ticked in the product form
  var pendingImage = null; // data URL of the resized photo

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
    renderSuppliers();
    setStatus("");
    setSupplierStatus("");
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
  }

  /* ---------- Tabs ---------- */
  function showTab(name) {
    document.querySelectorAll(".tab").forEach(function (tab) {
      var active = tab.dataset.tab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    $("#products-view").hidden = name !== "products";
    $("#suppliers-view").hidden = name !== "suppliers";
    window.scrollTo(0, 0);
  }
  document.querySelectorAll(".tab").forEach(function (tab) {
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
    $("#form-title").textContent = T(editing ? "form.edit" : "form.new");
    $("#save-btn").textContent = T(editing ? "form.saveChanges" : "form.save");
    $("#cancel-edit").hidden = !editing;
    var p = editing && products.filter(function (x) { return x.id === form.elements.id.value; })[0];
    $("#detected-lang").textContent = p ? "· " + T("list.registeredIn") + ": " + langName(p.source.lang) : "";
  }

  function resetForm() {
    form.reset();
    form.elements.id.value = "";
    pendingImage = null;
    showPreview(null);
    updateFormMode();
    $("#translations").hidden = true;
    $("#translations").open = false;
    form.querySelectorAll(".is-invalid").forEach(function (el) { el.classList.remove("is-invalid"); });
    selectedSuppliers = new Set();
    $("#supplier-search").value = "";
    renderPicker();
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
    selectedSuppliers = new Set(p.supplierIds || []);
    renderPicker();
    updateFormMode();
    setStatus("");
    renderList();
    document.getElementById("form-panel").scrollIntoView({ behavior: "smooth", block: "start" });
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
    if (!id && !pendingImage) { drop.classList.add("is-invalid"); ok = false; }
    if (!ok) return setStatus(T("status.required"), "error");

    var body = {
      name: name,
      category: category,
      description: form.elements.description.value,
      supplierIds: Array.from(selectedSuppliers)
    };
    if (pendingImage) body.image = pendingImage;
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
        if (id) products = products.map(function (x) { return x.id === id ? p : x; });
        else products.unshift(p);
        resetForm();
        loadSuppliers(); // linked-product lists changed
        setStatus(p.translationOk === false
          ? T("status.savedNoTr")
          : T("status.saved", { lang: langName(p.source.lang) }), p.translationOk === false ? "error" : "ok");
      })
      .catch(function (e2) { setStatus(/Server error|Erro \d/.test(e2.message) ? T("status.error") : e2.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- List ---------- */
  function loadProducts() {
    api("/api/products").then(function (data) {
      products = data.products || [];
      renderList();
    }).catch(function (e) { setStatus(e.message, "error"); });
  }

  function renderList() {
    var q = $("#search").value.trim().toLowerCase();
    var cat = $("#cat-filter").value;
    var editing = form.elements.id.value;
    var shown = products.filter(function (p) {
      if (cat && p.category !== cat) return false;
      if (!q) return true;
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
        "<div><h3>" + escapeHtml(p.name[current] || p.source.name) + "</h3>" +
        '<p class="pitem__lang">' + (p.category ? '<span class="pitem__cat">' + escapeHtml(T("cat." + p.category)) + "</span> · " : "") +
        escapeHtml(T("list.registeredIn") + ": " + langName(p.source.lang)) + "</p>" +
        '<div class="pitem__tr">' + chips + "</div>" +
        supplierLine(p.supplierIds) +
        (p.translationOk === false ? '<p class="pitem__warn">' + escapeHtml(T("list.pending")) + "</p>" : "") + "</div>" +
        '<div class="pitem__actions"><button type="button" data-act="edit">' + escapeHtml(T("list.edit")) + "</button>" +
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

  /* ---------- Supplier picker in the product form ---------- */
  function supplierById(id) {
    return suppliers.filter(function (s) { return s.id === id; })[0];
  }

  // "🔒 Suppliers: A, B" line under a product in the list (admin only).
  function supplierLine(ids) {
    var names = (ids || []).map(supplierById).filter(Boolean).map(function (s) { return s.company; });
    if (!names.length) return "";
    return '<p class="pitem__sup"><span class="lock" aria-hidden="true"></span>' +
      escapeHtml(T("list.suppliers") + ": " + names.join(", ")) + "</p>";
  }

  function renderPicker() {
    var picker = $("#supplier-picker");
    var q = $("#supplier-search").value.trim().toLowerCase();
    $("#supplier-picker-empty").hidden = suppliers.length > 0;
    $("#supplier-search").hidden = suppliers.length === 0;
    picker.hidden = suppliers.length === 0;
    $("#supplier-selected").textContent = selectedSuppliers.size ? T("form.suppliersSelected", { n: selectedSuppliers.size }) : "";
    var shown = suppliers.filter(function (s) {
      return !q || (s.company + " " + s.city + " " + s.contact).toLowerCase().indexOf(q) > -1;
    });
    // Ticked suppliers first, so the choice stays visible.
    shown.sort(function (a, b) { return selectedSuppliers.has(b.id) - selectedSuppliers.has(a.id); });
    picker.innerHTML = shown.length ? shown.map(function (s) {
      return '<label class="picker__item"><input type="checkbox" value="' + escapeHtml(s.id) + '"' +
        (selectedSuppliers.has(s.id) ? " checked" : "") + " /><span><b>" + escapeHtml(s.company) + "</b>" +
        (s.city ? "<small>" + escapeHtml(s.city) + "</small>" : "") + "</span></label>";
    }).join("") : '<p class="picker__none">' + escapeHtml(T("form.noMatch")) + "</p>";
  }

  $("#supplier-picker").addEventListener("change", function (e) {
    if (e.target.type !== "checkbox") return;
    if (e.target.checked) selectedSuppliers.add(e.target.value);
    else selectedSuppliers.delete(e.target.value);
    $("#supplier-selected").textContent = selectedSuppliers.size ? T("form.suppliersSelected", { n: selectedSuppliers.size }) : "";
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
    var shown = suppliers.filter(function (s) {
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
        "<div><h3>" + escapeHtml(s.company) + "</h3>" +
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
          p.supplierIds = (p.supplierIds || []).filter(function (sid) { return sid !== id; });
        });
        if (supForm.elements.id.value === id) resetSupplierForm();
        renderSuppliers();
        renderPicker();
        renderList();
        setSupplierStatus(T("sup.deleted"), "ok");
      })
      .catch(function (e2) { btn.disabled = false; setSupplierStatus(e2.message, "error"); });
  });

  /* ---------- Start ---------- */
  setLang(detectPanelLang());
  api("/api/session").then(function (s) { s.authenticated ? showApp() : showLogin(); }, showLogin);
})();
