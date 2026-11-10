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
    renderList();
    setStatus("");
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
  }

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
  function resizeImage(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error(T("status.imageType")));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; // transparent PNGs get a white background
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
    renderList();
  }

  function editProduct(p) {
    resetForm();
    form.elements.id.value = p.id;
    form.elements.name.value = p.source.name;
    form.elements.description.value = p.source.description || "";
    showPreview(p.image);
    trFields("name").forEach(function (el) { el.value = p.name[el.dataset.lang] || ""; });
    trFields("description").forEach(function (el) { el.value = (p.description || {})[el.dataset.lang] || ""; });
    $("#translations").hidden = false;
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
    var ok = true;
    form.elements.name.classList.toggle("is-invalid", !name);
    if (!name) ok = false;
    if (!id && !pendingImage) { drop.classList.add("is-invalid"); ok = false; }
    if (!ok) return setStatus(T("status.required"), "error");

    var body = {
      name: name,
      description: form.elements.description.value
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
    var editing = form.elements.id.value;
    var shown = products.filter(function (p) {
      if (!q) return true;
      return LANGS.some(function (l) { return String(p.name[l] || "").toLowerCase().indexOf(q) > -1; });
    });
    $("#count").textContent = products.length;
    $("#empty").hidden = products.length > 0;
    listEl.innerHTML = shown.map(function (p) {
      var chips = LANGS.map(function (l) {
        return "<span><b>" + l.toUpperCase() + "</b>" + escapeHtml(p.name[l]) + "</span>";
      }).join("");
      return '<li class="pitem' + (p.id === editing ? " is-editing" : "") + '" data-id="' + escapeHtml(p.id) + '">' +
        '<img src="' + escapeHtml(p.image) + '" alt="" loading="lazy" />' +
        "<div><h3>" + escapeHtml(p.name[current] || p.source.name) + "</h3>" +
        '<p class="pitem__lang">' + escapeHtml(T("list.registeredIn") + ": " + langName(p.source.lang)) + "</p>" +
        '<div class="pitem__tr">' + chips + "</div>" +
        (p.translationOk === false ? '<p class="pitem__warn">' + escapeHtml(T("list.pending")) + "</p>" : "") + "</div>" +
        '<div class="pitem__actions"><button type="button" data-act="edit">' + escapeHtml(T("list.edit")) + "</button>" +
        '<button type="button" class="danger" data-act="delete">' + escapeHtml(T("list.delete")) + "</button></div></li>";
    }).join("");
  }

  $("#search").addEventListener("input", renderList);

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
        setStatus(T("status.deleted"), "ok");
      })
      .catch(function (e2) { btn.disabled = false; setStatus(e2.message, "error"); });
  });

  /* ---------- Start ---------- */
  setLang(detectPanelLang());
  api("/api/session").then(function (s) { s.authenticated ? showApp() : showLogin(); }, showLogin);
})();
