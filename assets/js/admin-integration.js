/* Integration with Soulglobal, on the Settings screen: status, connection test,
   events sent and received (with retries), and shared documents.
   Also used by the proformas screen to send the commercial invoice PDF. */
(function () {
  "use strict";

  var A = window.Admin;
  var $ = function (s) { return document.querySelector(s); };
  var T = function (k, v) { return A.T(k, v); };
  var esc = function (s) { return A.escapeHtml(s); };
  var MAX_FILE = 3 * 1024 * 1024;

  var enabled = false; // from the panel's first load (bootstrap)
  var data = null;     // last GET /api/integration
  var loading = null;

  function fmtDateTime(iso) {
    if (!iso) return "—";
    var d = new Date(typeof iso === "number" ? iso : iso);
    return d.toLocaleString(A.locale(), { dateStyle: "short", timeStyle: "short" });
  }
  function fmtSize(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }
  function label(prefix, key) {
    var k = prefix + key;
    var t = T(k);
    return t === k ? key : t;
  }
  function badge(kind, text) {
    return '<span class="badge badge--' + esc(kind) + '">' + esc(text) + "</span>";
  }
  function setMsg(sel, msg, kind) {
    var el = $(sel);
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }
  function closedOrders() {
    var list = (window.Proformas && window.Proformas.list()) || [];
    return list.filter(function (p) { return p.status === "closed"; });
  }
  function orderNumber(id) {
    var p = ((window.Proformas && window.Proformas.list()) || []).filter(function (x) { return x.id === id; })[0];
    return p ? p.number : "";
  }

  /* ---------- Rendering ---------- */
  function renderStatus() {
    var box = $("#int-status");
    if (!data) { box.innerHTML = ""; return; }
    var lines = [];
    lines.push("<div>" + badge(data.enabled ? "on" : "off", T(data.enabled ? "int.on" : "int.off")) +
      (data.enabled ? " " + esc(T("int.counts", { p: data.counts.pending || 0, f: data.counts.failed || 0, d: data.counts.delivered || 0 })) : "") + "</div>");
    if (!data.enabled) lines.push('<div class="int-line">' + esc(T("int.offHint")) + "</div>");
    if (data.eventsUrlInvalid) lines.push('<div class="int-warn">' + esc(T("int.urlInvalid")) + "</div>");
    if (data.secretTooShort) lines.push('<div class="int-warn">' + esc(T("int.secretShort")) + "</div>");
    if (data.eventsUrl) lines.push('<div class="int-line">' + esc(T("int.endpoint")) + ": <code>" + esc(data.eventsUrl) + "</code></div>");
    lines.push('<div class="int-line">' + esc(T("int.inboundUrl")) + ": <code>" + esc(location.origin + "/api/integration-inbound") + "</code></div>");
    if (data.enabled) lines.push('<div class="int-line">' + esc(T("int.lastSync", { t: data.lastSync ? fmtDateTime(data.lastSync) : "—" })) +
      (data.syncPending ? " · " + esc(T("int.syncPending")) : "") + "</div>");
    if (data.enabled && !data.publicBaseUrl) lines.push('<div class="int-warn">' + esc(T("int.noBase")) + "</div>");
    if (data.enabled && !data.cronSecretSet) lines.push('<div class="int-warn">' + esc(T("int.noCron")) + "</div>");
    box.innerHTML = lines.join("");
    $("#int-on").hidden = !data.enabled;
    $("#int-retry-all").hidden = !(data.counts && data.counts.failed);
  }

  function renderDocForm() {
    var sel = $("#int-doc-order");
    var keep = sel.value;
    sel.innerHTML = '<option value="">' + esc(T("int.docNoOrder")) + "</option>" + closedOrders().map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.number + (p.client && p.client.name ? " · " + p.client.name : "")) + "</option>";
    }).join("");
    sel.value = keep;
    var types = (data && data.documentTypes) || [];
    var tsel = $("#int-doc-type");
    var tkeep = tsel.value;
    tsel.innerHTML = types.map(function (t) { return '<option value="' + esc(t) + '">' + esc(label("int.dt.", t)) + "</option>"; }).join("");
    if (tkeep) tsel.value = tkeep;
  }

  function renderDocs() {
    var docs = (data && data.documents) || [];
    $("#int-docs").innerHTML = docs.length ? docs.map(function (d) {
      var review = d.review ? badge(d.review.status, label("int.rv.", d.review.status)) + (d.review.reason ? '<span class="int-sub">' + esc(d.review.reason) + "</span>" : "") : "—";
      var name = esc(d.name) + '<span class="int-sub">' + esc(fmtSize(d.size)) + (d.version > 1 ? " · v" + d.version : "") +
        (d.supersededBy ? " · " + esc(T("int.superseded")) : "") + (d.note ? " · " + esc(d.note) : "") + "</span>";
      return "<tr><td>" + esc(T(d.direction === "in" ? "int.in" : "int.out")) + "</td><td>" + esc(label("int.dt.", d.type)) + '</td><td class="int-wrap">' + name +
        "</td><td>" + esc(d.proformaNumber || orderNumber(d.proformaId) || "—") + "</td><td>" + esc(fmtDateTime(d.at)) + "</td><td>" + review +
        '</td><td><a class="linkbtn" target="_blank" rel="noopener" href="/api/integration?file=' + encodeURIComponent(d.id) + '">' + esc(T("int.open")) + "</a></td></tr>";
    }).join("") : '<tr><td colspan="7">' + esc(T("int.noDocs")) + "</td></tr>";
  }

  function renderEvents() {
    var events = (data && data.events) || [];
    $("#int-events").innerHTML = events.length ? events.map(function (e) {
      var status = badge(e.status, label("int.st.", e.status));
      if (e.status === "pending" && e.nextAt && e.attempts) status += '<span class="int-sub">' + esc(T("int.nextAt", { t: fmtDateTime(e.nextAt) })) + "</span>";
      var action = e.status === "failed" || (e.status === "pending" && e.attempts)
        ? '<button type="button" class="linkbtn" data-int-retry="' + esc(e.id) + '">' + esc(T("int.retry")) + "</button>" : "";
      return "<tr><td>" + esc(label("int.ev.", e.type)) + "</td><td>" + esc(e.label || "—") + "</td><td>" + esc(fmtDateTime(e.createdAt)) + "</td><td>" + status +
        '</td><td class="num">' + esc(e.attempts) + '</td><td class="int-err">' + esc(e.lastError || "") + "</td><td>" + action + "</td></tr>";
    }).join("") : '<tr><td colspan="7">' + esc(T("int.noEvents")) + "</td></tr>";
  }

  function renderInbound() {
    var list = (data && data.inbound) || [];
    $("#int-inbound").innerHTML = list.length ? list.map(function (e) {
      return "<tr><td>" + esc(label("int.ev.", e.type)) + "</td><td>" + esc(fmtDateTime(e.receivedAt)) + "</td><td>" + badge(e.status, label("int.st.", e.status)) +
        '</td><td class="int-err">' + esc(e.error || "") + "</td></tr>";
    }).join("") : '<tr><td colspan="4">' + esc(T("int.noEvents")) + "</td></tr>";
  }

  function render() {
    renderStatus();
    if (!data || !data.enabled) return;
    renderDocForm();
    renderDocs();
    renderEvents();
    renderInbound();
  }

  function load() {
    if (loading) return loading;
    loading = A.api("/api/integration").then(function (d) { data = d; enabled = d.enabled; render(); })
      .catch(function (e) { setMsg("#int-msg", e.message, "error"); })
      .then(function () { loading = null; });
    return loading;
  }

  /* ---------- Actions ---------- */
  function busy(btn, on) { if (btn) btn.disabled = on; }

  $("#int-ping").addEventListener("click", function () {
    var btn = this;
    busy(btn, true);
    setMsg("#int-msg", T("int.pinging"));
    A.api("/api/integration?action=ping", { method: "POST", body: {} }).then(function (r) {
      if (r.event && r.event.status === "delivered") setMsg("#int-msg", T("int.pingOk"), "ok");
      else setMsg("#int-msg", T("int.pingFail", { error: (r.event && r.event.lastError) || "—" }), "error");
      return load();
    }).catch(function (e) { setMsg("#int-msg", e.message, "error"); }).then(function () { busy(btn, false); });
  });

  function runResult(r) {
    var run = r.run || {};
    return T("int.deliveredMsg", { n: run.delivered || 0, w: run.waiting || 0 });
  }

  $("#int-deliver").addEventListener("click", function () {
    var btn = this;
    busy(btn, true);
    A.api("/api/integration?action=deliver", { method: "POST", body: {} }).then(function (r) {
      setMsg("#int-msg", runResult(r), "ok");
      return load();
    }).catch(function (e) { setMsg("#int-msg", e.message, "error"); }).then(function () { busy(btn, false); });
  });

  function sync(all, btn) {
    busy(btn, true);
    setMsg("#int-msg", T("int.syncing"));
    return A.api("/api/integration?action=sync", { method: "POST", body: { all: all } }).then(function (r) {
      setMsg("#int-msg", T("int.syncDone", { q: (r.sync && r.sync.queued) || 0 }) + " " + runResult(r), "ok");
      return load();
    }).catch(function (e) { setMsg("#int-msg", e.message, "error"); }).then(function () { busy(btn, false); });
  }
  $("#int-sync").addEventListener("click", function () { sync(false, this); });
  $("#int-resync").addEventListener("click", function () {
    if (window.confirm(T("int.resyncConfirm"))) sync(true, this);
  });

  function retry(body, btn) {
    busy(btn, true);
    return A.api("/api/integration?action=retry", { method: "POST", body: body }).then(function (r) {
      setMsg("#int-msg", T("int.retried", { n: r.retried }) + " " + runResult(r), "ok");
      return load();
    }).catch(function (e) { setMsg("#int-msg", e.message, "error"); }).then(function () { busy(btn, false); });
  }
  $("#int-retry-all").addEventListener("click", function () { retry({ all: true }, this); });
  $("#int-events").addEventListener("click", function (e) {
    var b = e.target.closest("[data-int-retry]");
    if (b) retry({ id: b.getAttribute("data-int-retry") }, b);
  });
  $("#int-refresh").addEventListener("click", function () { setMsg("#int-msg", ""); load(); });

  function readDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }

  // Sends a document; key (optional) makes a later one with the same key a new version.
  function shareDocument(doc) {
    return A.api("/api/integration?action=document", { method: "POST", body: doc });
  }

  $("#int-doc-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = this;
    var file = f.elements.file.files[0];
    if (!file) return setMsg("#int-doc-msg", T("int.docPick"), "error");
    if (file.size > MAX_FILE) return setMsg("#int-doc-msg", T("int.docTooBig"), "error");
    var btn = $("#int-doc-submit");
    busy(btn, true);
    setMsg("#int-doc-msg", T("int.docSending"));
    readDataUrl(file).then(function (url) {
      // Some browsers give .xlsx/.docx/.zip without a type: name it from the extension.
      var ext = (file.name.split(".").pop() || "").toLowerCase();
      var byExt = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip: "application/zip", pdf: "application/pdf" };
      if (byExt[ext]) url = url.replace(/^data:[^;]*;/, "data:" + byExt[ext] + ";");
      return shareDocument({ proformaId: f.elements.proformaId.value || null, type: f.elements.type.value, name: file.name, note: f.elements.note.value, data: url });
    }).then(function () {
      setMsg("#int-doc-msg", T("int.docSent"), "ok");
      f.elements.file.value = "";
      f.elements.note.value = "";
      return load();
    }).catch(function (err) {
      setMsg("#int-doc-msg", /File too large/.test(err.message) ? T("int.docTooBig") : /Unsupported file/.test(err.message) ? T("int.docBadType") : err.message, "error");
    }).then(function () { busy(btn, false); });
  });

  /* ---------- Panel events ---------- */
  document.addEventListener("admin:data", function (e) {
    var integ = e.detail && e.detail.integration;
    enabled = Boolean(integ && integ.enabled);
    if (!$("#settings-view").hidden) load();
  });
  document.addEventListener("admin:tab", function (e) { if (e.detail === "settings") load(); });
  document.addEventListener("admin:lang", render);

  window.Integration = {
    enabled: function () { return enabled; },
    shareDocument: shareDocument,
    reload: load
  };
})();
