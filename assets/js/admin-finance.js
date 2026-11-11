/* Finance tab: bank accounts, receivables and payables, and the bank statement
   of each account (running balance, reconciliation and comparison with the
   balance shown by the bank). Data comes from /api/finance (admin-only). */
(function () {
  "use strict";

  var A = window.Admin;
  var $ = function (sel) { return document.querySelector(sel); };
  var T = function (k, v) { return A.T(k, v); };
  var esc = function (s) { return A.escapeHtml(s); };

  var accounts = [];
  var entries = [];
  var proformas = null; // loaded when the entry form needs them
  var loaded = false;
  var mode = "all"; // all | in | out | statement
  var REPEATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 18, 24, 36, 48, 60];

  /* ---------- Helpers ---------- */
  function today() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function dayBefore(iso) {
    var d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() - 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtDate(iso) { return iso ? new Date(iso + "T00:00:00").toLocaleDateString(A.locale()) : ""; }
  function daysBetween(a, b) { return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000); }
  function money(n, cur) { return A.money(n, cur); }
  function signed(n, cur) { return (n < 0 ? "− " : "") + money(Math.abs(n), cur); }
  function r2(n) { return Math.round(n * 100) / 100; }
  function accountById(id) { return accounts.filter(function (a) { return a.id === id; })[0]; }
  function accountLabel(a) { return a ? a.name + " · " + (A.CURRENCIES[a.currency] || A.CURRENCIES.CNY).label : "—"; }

  // open | overdue | paid
  function stateOf(e) {
    if (e.status === "paid") return "paid";
    return e.dueDate < today() ? "overdue" : "open";
  }
  // Date the entry is listed under: when it was paid, otherwise when it is due.
  function refDate(e) { return e.status === "paid" ? e.paidDate : e.dueDate; }

  // Paid entries of an account that count for its balance (on or after the opening date).
  function moves(account) {
    return entries.filter(function (e) {
      return e.status === "paid" && e.accountId === account.id && e.paidDate >= account.openingDate;
    }).sort(function (a, b) {
      return a.paidDate.localeCompare(b.paidDate) || String(a.createdAt).localeCompare(String(b.createdAt));
    });
  }
  function balanceAt(account, date) {
    var b = account.openingBalance || 0;
    moves(account).forEach(function (e) {
      if (!date || e.paidDate <= date) b += e.type === "in" ? e.amount : -e.amount;
    });
    return r2(b);
  }

  function setStatus(sel, msg, kind) {
    var el = $(sel);
    el.textContent = msg || "";
    el.className = "status" + (kind ? " is-" + kind : "");
  }
  function errorText(e) {
    var map = {
      "Account has entries": "fin.err.accountUsed",
      "Account currency cannot change: it has entries": "fin.err.currencyLocked",
      "Choose the bank account of the payment": "fin.err.account",
      "Payment date is required": "fin.err.paidDate",
      "Amount must be greater than zero": "fin.err.amount",
      "Due date is required": "fin.err.dueDate",
      "Description is required": "fin.err.description",
      "Account name is required": "fin.err.accName",
      "The account's currency is different from the entry's": "fin.err.currency"
    };
    return map[e.message] ? T(map[e.message]) : /Server error|Erro \d/.test(e.message) ? T("status.error") : e.message;
  }

  /* ---------- Load ---------- */
  function load() {
    if ($("#app-view").hidden) return;
    return A.api("/api/finance").then(function (data) {
      accounts = data.accounts || [];
      entries = data.entries || [];
      loaded = true;
      render();
    }).catch(function (e) { setStatus("#fin-status-msg", errorText(e), "error"); });
  }

  function loadProformas() {
    if (proformas) return Promise.resolve(proformas);
    return A.api("/api/proformas").then(function (d) { proformas = d.proformas || []; return proformas; }).catch(function () { return []; });
  }

  /* ---------- Render ---------- */
  function render() {
    renderAccountFilter();
    renderCards();
    var overdue = entries.filter(function (e) { return stateOf(e) === "overdue"; }).length;
    var badge = $("#tab-count-finance");
    badge.textContent = overdue;
    badge.hidden = overdue === 0;
    badge.title = T("fin.overdueBadge", { n: overdue });
    document.querySelectorAll("#fin-modes .seg__btn").forEach(function (b) { b.classList.toggle("is-active", b.dataset.mode === mode); });
    $("#fin-status").hidden = mode === "statement";
    if (mode === "statement") renderStatement(); else renderList();
  }

  function renderAccountFilter() {
    var sel = $("#fin-account");
    var value = sel.value;
    var opts = (mode === "statement" ? "" : '<option value="">' + esc(T("fin.allAccounts")) + "</option>") +
      accounts.map(function (a) { return '<option value="' + esc(a.id) + '">' + esc(accountLabel(a)) + "</option>"; }).join("");
    sel.innerHTML = opts;
    if (value && accountById(value)) sel.value = value;
    else if (mode === "statement" && accounts.length) sel.value = accounts[0].id;
  }

  // Totals by currency: { CNY: n, USD: n }
  function byCurrency(list) {
    var out = {};
    list.forEach(function (e) { out[e.currency] = r2((out[e.currency] || 0) + e.amount); });
    return out;
  }
  function currencyLines(map, cls) {
    var keys = Object.keys(map);
    if (!keys.length) return '<b class="' + (cls || "") + '">' + esc(money(0, A.defaultCurrency())) + "</b>";
    return keys.map(function (c) { return '<b class="' + (cls || "") + '">' + esc(money(map[c], c)) + "</b>"; }).join("");
  }

  function renderCards() {
    var open = entries.filter(function (e) { return e.status !== "paid"; });
    var t = today();
    function card(type) {
      var list = open.filter(function (e) { return e.type === type; });
      var late = list.filter(function (e) { return e.dueDate < t; });
      var soon = list.filter(function (e) { return e.dueDate >= t && daysBetween(t, e.dueDate) <= 7; });
      return '<button type="button" class="fin-card fin-card--' + type + '" data-goto-mode="' + type + '">' +
        "<span>" + esc(T(type === "in" ? "fin.toReceive" : "fin.toPay")) + "</span>" + currencyLines(byCurrency(list)) +
        "<small>" + esc(T("fin.countOpen", { n: list.length })) + "</small>" +
        (late.length ? '<small class="is-neg">' + esc(T("fin.countOverdue", { n: late.length })) + " · " +
          Object.keys(byCurrency(late)).map(function (c) { return money(byCurrency(late)[c], c); }).join(" + ") + "</small>" : "") +
        (soon.length ? '<small class="is-low">' + esc(T("fin.countSoon", { n: soon.length })) + "</small>" : "") +
        "</button>";
    }
    var accCards = accounts.map(function (a) {
      var bal = balanceAt(a);
      var pending = moves(a).filter(function (e) { return !e.reconciled; }).length;
      return '<button type="button" class="fin-card fin-card--acc" data-statement="' + esc(a.id) + '">' +
        "<span>" + esc(a.name) + (a.bank ? " · " + esc(a.bank) : "") + "</span>" +
        '<b class="' + (bal < 0 ? "is-neg" : "") + '">' + esc(signed(bal, a.currency)) + "</b>" +
        "<small>" + esc(pending ? T("fin.toReconcile", { n: pending }) : T("fin.allReconciled")) + "</small></button>";
    }).join("");
    if (!accounts.length) {
      accCards = '<button type="button" class="fin-card fin-card--empty" data-open-accounts><span>' + esc(T("fin.noAccounts")) + "</span><b>+ " + esc(T("fin.accNew")) + "</b></button>";
    }
    $("#fin-cards").innerHTML = card("in") + card("out") + accCards;
  }

  /* ----- Receivables / payables list ----- */
  function filtered() {
    var q = $("#fin-search").value.trim().toLowerCase();
    var acc = $("#fin-account").value;
    var st = $("#fin-status").value;
    var from = $("#fin-from").value, to = $("#fin-to").value;
    return entries.filter(function (e) {
      if (mode === "in" && e.type !== "in") return false;
      if (mode === "out" && e.type !== "out") return false;
      if (acc && e.accountId !== acc) return false;
      var s = stateOf(e);
      if (st === "open" && s === "paid") return false;
      if (st && st !== "open" && s !== st) return false;
      var d = refDate(e);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (q) {
        var hay = [e.description, e.category, e.document, e.notes, e.proformaNumber, e.party && e.party.name].join(" ").toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) {
      // Open first, oldest due date first; then paid, most recent first.
      var pa = a.status === "paid", pb = b.status === "paid";
      if (pa !== pb) return pa ? 1 : -1;
      return pa ? b.paidDate.localeCompare(a.paidDate) : a.dueDate.localeCompare(b.dueDate);
    });
  }

  function stateBadge(e) {
    var s = stateOf(e);
    if (s === "paid") {
      return '<span class="badge badge--closed">' + esc(T(e.type === "in" ? "fin.received" : "fin.paid")) + "</span> <small>" + esc(fmtDate(e.paidDate)) +
        (e.reconciled ? ' · <span class="fin-ok" title="' + esc(T("fin.reconciled")) + '">✓ ' + esc(T("fin.reconciledShort")) + "</span>" : "") + "</small>";
    }
    if (s === "overdue") return '<span class="badge badge--late">' + esc(T("fin.overdue")) + "</span> <small>" + esc(T("fin.daysLate", { n: daysBetween(e.dueDate, today()) })) + "</small>";
    var d = daysBetween(today(), e.dueDate);
    return '<span class="badge badge--draft">' + esc(T("fin.open")) + "</span> <small>" + esc(d === 0 ? T("fin.dueToday") : T("fin.dueIn", { n: d })) + "</small>";
  }

  function renderList() {
    $("#fin-statement-box").hidden = true;
    var list = filtered();
    var head = "<thead><tr><th>" + esc(T("fin.dueDate").replace(" *", "")) + "</th><th>" + esc(T("fin.description").replace(" *", "")) + "</th><th>" +
      esc(T("fin.account")) + '</th><th class="num">' + esc(T("fin.amount").replace(" *", "")) + "</th><th>" + esc(T("fin.situation")) + "</th><th></th></tr></thead>";
    var rows = list.map(function (e) {
      var acc = accountById(e.accountId);
      var meta = [e.party && e.party.name, e.category, e.proformaNumber, e.document, e.installment ? e.installment.n + "/" + e.installment.of : ""].filter(Boolean);
      var action = e.status === "paid"
        ? ""
        : '<button type="button" class="btn btn--outline btn--sm" data-pay="' + esc(e.id) + '">' + esc(T(e.type === "in" ? "fin.receive" : "fin.pay")) + "</button>";
      return '<tr data-entry="' + esc(e.id) + '" class="fin-row fin-row--' + stateOf(e) + '">' +
        "<td>" + esc(fmtDate(e.dueDate)) + "</td>" +
        '<td class="fin-desc"><b><span class="fin-type fin-type--' + e.type + '">' + (e.type === "in" ? "↓" : "↑") + "</span> " + esc(e.description) + "</b>" +
          (meta.length ? "<small>" + esc(meta.join(" · ")) + "</small>" : "") + "</td>" +
        "<td><small>" + esc(acc ? acc.name : "—") + "</small></td>" +
        '<td class="num"><b class="' + (e.type === "in" ? "is-ok" : "is-neg") + '">' + esc((e.type === "in" ? "+ " : "− ") + money(e.amount, e.currency)) + "</b></td>" +
        "<td>" + stateBadge(e) + "</td>" +
        '<td class="num">' + action + "</td></tr>";
    }).join("");
    // Totals of what is listed, by currency.
    var ins = byCurrency(list.filter(function (e) { return e.type === "in"; }));
    var outs = byCurrency(list.filter(function (e) { return e.type === "out"; }));
    var curs = Object.keys(ins).concat(Object.keys(outs)).filter(function (c, i, all) { return all.indexOf(c) === i; });
    var foot = list.length ? "<tfoot>" + curs.map(function (c) {
      var net = r2((ins[c] || 0) - (outs[c] || 0));
      return '<tr><td colspan="3">' + esc(T("fin.totalListed", { cur: (A.CURRENCIES[c] || A.CURRENCIES.CNY).label })) + '</td><td class="num" colspan="2">' +
        (mode !== "out" ? '<span class="is-ok">+ ' + esc(money(ins[c] || 0, c)) + "</span> " : "") +
        (mode !== "in" ? '<span class="is-neg">− ' + esc(money(outs[c] || 0, c)) + "</span> " : "") +
        (mode === "all" ? "= <b>" + esc(signed(net, c)) + "</b>" : "") + "</td><td></td></tr>";
    }).join("") + "</tfoot>" : "";
    $("#fin-table").innerHTML = list.length ? head + "<tbody>" + rows + "</tbody>" + foot : "";
    $("#fin-empty").hidden = list.length > 0;
    $("#fin-empty").textContent = entries.length ? T("fin.noMatch") : T("fin.empty");
  }

  /* ----- Bank statement of one account ----- */
  function renderStatement() {
    var box = $("#fin-statement-box");
    var a = accountById($("#fin-account").value);
    box.hidden = false;
    if (!a) {
      box.innerHTML = '<p class="empty">' + esc(T("fin.noAccounts")) + ' <button type="button" class="linkbtn" data-open-accounts>' + esc(T("fin.accNew")) + "</button></p>";
      $("#fin-table").innerHTML = "";
      $("#fin-empty").hidden = true;
      return;
    }
    var from = $("#fin-from").value, to = $("#fin-to").value;
    var q = $("#fin-search").value.trim().toLowerCase();
    var all = moves(a);
    var start = from ? balanceAt(a, dayBefore(from)) : a.openingBalance || 0;
    var running = start;
    var totalIn = 0, totalOut = 0, shown = 0, rec = 0;
    var rows = [];
    all.forEach(function (e) {
      if (from && e.paidDate < from) return;
      if (to && e.paidDate > to) return;
      var v = e.type === "in" ? e.amount : -e.amount;
      running = r2(running + v);
      if (e.type === "in") totalIn += e.amount; else totalOut += e.amount;
      if (e.reconciled) rec += 1;
      var hay = [e.description, e.category, e.document, e.proformaNumber, e.party && e.party.name].join(" ").toLowerCase();
      if (q && hay.indexOf(q) < 0) return;
      shown += 1;
      rows.push('<tr data-entry="' + esc(e.id) + '" class="' + (e.reconciled ? "is-reconciled" : "") + '">' +
        "<td>" + esc(fmtDate(e.paidDate)) + "</td>" +
        '<td class="fin-desc"><b>' + esc(e.description) + "</b><small>" + esc([e.party && e.party.name, e.category, e.proformaNumber, e.document].filter(Boolean).join(" · ")) + "</small></td>" +
        '<td class="num is-ok">' + (e.type === "in" ? esc(money(e.amount, a.currency)) : "") + "</td>" +
        '<td class="num is-neg">' + (e.type === "out" ? esc(money(e.amount, a.currency)) : "") + "</td>" +
        '<td class="num"><b class="' + (running < 0 ? "is-neg" : "") + '">' + esc(signed(running, a.currency)) + "</b></td>" +
        '<td class="fin-rec"><label class="check" title="' + esc(T("fin.reconcileHint")) + '"><input type="checkbox" data-reconcile="' + esc(e.id) + '"' + (e.reconciled ? " checked" : "") + " /> " + esc(T("fin.reconciledShort")) + "</label></td></tr>");
    });
    var end = to ? balanceAt(a, to) : balanceAt(a);
    var periodCount = all.filter(function (e) { return (!from || e.paidDate >= from) && (!to || e.paidDate <= to); }).length;

    // Comparison with the balance the bank shows.
    var checks = (a.checks || []).slice().reverse().slice(0, 5);
    var checkRows = checks.map(function (c) {
      var ours = balanceAt(a, c.date);
      var diff = r2(c.balance - ours);
      return "<li><span>" + esc(fmtDate(c.date)) + "</span><span>" + esc(T("fin.bankSays")) + " <b>" + esc(signed(c.balance, a.currency)) + "</b></span><span>" +
        esc(T("fin.systemSays")) + " <b>" + esc(signed(ours, a.currency)) + "</b></span>" +
        (Math.abs(diff) < 0.005 ? '<span class="fin-ok">✓ ' + esc(T("fin.matches")) + "</span>" : '<span class="is-neg">' + esc(T("fin.difference")) + " " + esc(signed(diff, a.currency)) + "</span>") + "</li>";
    }).join("");

    box.innerHTML =
      '<div class="fin-st-head">' +
        '<div class="fin-st-acc"><b>' + esc(a.name) + "</b><small>" + esc([a.bank, a.number, (A.CURRENCIES[a.currency] || A.CURRENCIES.CNY).label].filter(Boolean).join(" · ")) + "</small></div>" +
        '<div class="fin-st-nums">' +
          "<div><span>" + esc(T(from ? "fin.balanceBefore" : "fin.openingBalance")) + "</span><b>" + esc(signed(start, a.currency)) + "</b></div>" +
          '<div><span>' + esc(T("fin.inflows")) + '</span><b class="is-ok">+ ' + esc(money(totalIn, a.currency)) + "</b></div>" +
          '<div><span>' + esc(T("fin.outflows")) + '</span><b class="is-neg">− ' + esc(money(totalOut, a.currency)) + "</b></div>" +
          "<div><span>" + esc(T(to ? "fin.balanceAt" : "fin.currentBalance", { date: fmtDate(to) })) + "</span><b class=\"" + (end < 0 ? "is-neg" : "") + '">' + esc(signed(end, a.currency)) + "</b></div>" +
          "<div><span>" + esc(T("fin.reconciled")) + "</span><b>" + rec + " / " + periodCount + "</b></div>" +
        "</div>" +
      "</div>" +
      '<form class="fin-check" id="fin-check-form">' +
        "<p><b>" + esc(T("fin.checkTitle")) + "</b> " + esc(T("fin.checkHint")) + "</p>" +
        '<div class="fin-check__row"><label><span>' + esc(T("fin.date")) + '</span><input type="date" name="date" value="' + esc(to || today()) + '" /></label>' +
        "<label><span>" + esc(T("fin.bankBalance")) + '</span><input type="text" name="balance" inputmode="decimal" autocomplete="off" placeholder="0,00" /></label>' +
        '<button type="submit" class="btn btn--primary">' + esc(T("fin.compare")) + "</button></div>" +
        (checkRows ? '<ul class="fin-checks">' + checkRows + "</ul>" : "") +
      "</form>";

    var head = "<thead><tr><th>" + esc(T("fin.date")) + "</th><th>" + esc(T("fin.description").replace(" *", "")) + '</th><th class="num">' + esc(T("fin.inflow")) +
      '</th><th class="num">' + esc(T("fin.outflow")) + '</th><th class="num">' + esc(T("fin.balance")) + "</th><th>" + esc(T("fin.reconciledShort")) + "</th></tr></thead>";
    var first = '<tr class="fin-st-start"><td>' + esc(from ? fmtDate(dayBefore(from)) : fmtDate(a.openingDate)) + "</td><td><b>" + esc(T(from ? "fin.balanceBefore" : "fin.openingBalance")) +
      '</b></td><td></td><td></td><td class="num"><b>' + esc(signed(start, a.currency)) + "</b></td><td></td></tr>";
    $("#fin-table").innerHTML = head + "<tbody>" + first + rows.join("") + "</tbody>";
    $("#fin-empty").hidden = shown > 0;
    $("#fin-empty").textContent = T("fin.noMoves");
  }

  /* ---------- Events: toolbar, list, statement ---------- */
  $("#fin-modes").addEventListener("click", function (e) {
    var b = e.target.closest("[data-mode]");
    if (!b) return;
    mode = b.dataset.mode;
    render();
  });
  ["#fin-search", "#fin-from", "#fin-to"].forEach(function (s) { $(s).addEventListener("input", render); });
  ["#fin-account", "#fin-status"].forEach(function (s) { $(s).addEventListener("change", render); });

  $("#fin-cards").addEventListener("click", function (e) {
    var m = e.target.closest("[data-goto-mode]");
    var st = e.target.closest("[data-statement]");
    if (e.target.closest("[data-open-accounts]")) return openAccounts();
    if (m) { mode = m.dataset.gotoMode; $("#fin-status").value = "open"; render(); }
    if (st) { mode = "statement"; renderAccountFilter(); $("#fin-account").value = st.dataset.statement; render(); }
  });

  $("#fin-table").addEventListener("click", function (e) {
    var pay = e.target.closest("[data-pay]");
    if (pay) return openPay(pay.dataset.pay);
    if (e.target.closest("[data-reconcile], .fin-rec")) return;
    var row = e.target.closest("[data-entry]");
    if (row) openEntry(null, entries.filter(function (x) { return x.id === row.dataset.entry; })[0]);
  });

  $("#fin-table").addEventListener("change", function (e) {
    var id = e.target.getAttribute("data-reconcile");
    if (!id) return;
    var on = e.target.checked;
    A.api("/api/finance?kind=entry&id=" + encodeURIComponent(id) + "&action=reconcile", { method: "POST", body: { reconciled: on } })
      .then(function (d) { replaceEntry(d.entry); render(); })
      .catch(function (err) { e.target.checked = !on; setStatus("#fin-status-msg", errorText(err), "error"); });
  });

  $("#fin-statement-box").addEventListener("click", function (e) {
    if (e.target.closest("[data-open-accounts]")) openAccounts();
  });
  $("#fin-statement-box").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var a = accountById($("#fin-account").value);
    if (!a) return;
    if (!f.date.value || !String(f.balance.value).trim()) return setStatus("#fin-status-msg", T("fin.err.check"), "error");
    A.api("/api/finance?kind=account&id=" + encodeURIComponent(a.id) + "&action=check", { method: "POST", body: { date: f.date.value, balance: f.balance.value } })
      .then(function (d) { replaceAccount(d.account); render(); setStatus("#fin-status-msg", ""); })
      .catch(function (err) { setStatus("#fin-status-msg", errorText(err), "error"); });
  });

  function replaceEntry(entry) {
    var i = entries.findIndex(function (x) { return x.id === entry.id; });
    if (i > -1) entries[i] = entry; else entries.push(entry);
  }
  function replaceAccount(acc) {
    var i = accounts.findIndex(function (x) { return x.id === acc.id; });
    if (i > -1) accounts[i] = acc; else accounts.push(acc);
  }

  /* ---------- Dialog helpers ---------- */
  function openDialog(d) { if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", ""); }
  function closeDialog(d) { if (d.open) d.close(); }
  document.querySelectorAll(".mdl").forEach(function (d) {
    d.addEventListener("click", function (e) {
      if (e.target === d || e.target.closest("[data-close]")) closeDialog(d);
    });
  });

  function accountOptions(currency, selected) {
    var list = accounts.filter(function (a) { return !currency || a.currency === currency; });
    if (!list.length) return '<option value="">' + esc(T("fin.noAccountFor", { cur: (A.CURRENCIES[currency] || A.CURRENCIES.CNY).label })) + "</option>";
    return list.map(function (a) { return '<option value="' + esc(a.id) + '"' + (a.id === selected ? " selected" : "") + ">" + esc(accountLabel(a)) + "</option>"; }).join("");
  }

  /* ---------- Entry form (new / edit) ---------- */
  var ef = $("#fin-entry-form");
  var editingEntry = null;

  function categories(type) {
    var base = T(type === "in" ? "fin.catsIn" : "fin.catsOut").split("|");
    entries.forEach(function (e) { if (e.type === type && e.category && base.indexOf(e.category) < 0) base.push(e.category); });
    return base;
  }

  function fillParty(type, entry) {
    var list = type === "in" ? A.clients().map(function (c) { return ["c:" + c.id, c.name]; }) : A.suppliers().map(function (s) { return ["s:" + s.id, s.company]; });
    var sel = ef.elements.party;
    sel.innerHTML = '<option value="">—</option>' + list.map(function (x) { return '<option value="' + esc(x[0]) + '">' + esc(x[1]) + "</option>"; }).join("") +
      '<option value="other">' + esc(T("fin.otherParty")) + "</option>";
    var p = entry && entry.party;
    sel.value = !p ? "" : p.kind === "client" ? "c:" + p.id : p.kind === "supplier" ? "s:" + p.id : "other";
    if (p && p.kind !== "other" && !sel.value) sel.value = "other"; // deleted client/supplier: keep the name
    ef.elements.partyName.value = p && (p.kind === "other" || sel.value === "other") ? p.name : "";
    $("#fin-partyname-wrap").hidden = sel.value !== "other";
    $("#fin-party-label").textContent = T(type === "in" ? "fin.client" : "fin.supplier");
  }

  function fillProformas(entry) {
    var wrap = $("#fin-proforma-wrap");
    wrap.hidden = ef.elements.type.value !== "in";
    if (wrap.hidden) return;
    var sel = ef.elements.proformaId;
    var party = ef.elements.party.value;
    var clientId = party.indexOf("c:") === 0 ? party.slice(2) : "";
    var selected = sel.value || (entry && entry.proformaId) || "";
    sel.innerHTML = '<option value="">' + esc(T("fin.noProforma")) + "</option>";
    loadProformas().then(function (list) {
      sel.innerHTML = '<option value="">' + esc(T("fin.noProforma")) + "</option>" + list.filter(function (p) {
        return !clientId || p.clientId === clientId || p.id === selected;
      }).map(function (p) {
        return '<option value="' + esc(p.id) + '">' + esc(p.number + " — " + (p.client ? p.client.name : "") + " — " + money(p.totals.sale, p.currency)) + "</option>";
      }).join("");
      sel.value = selected;
    });
  }

  function syncPaid() {
    var paid = ef.elements.paid.checked;
    $("#fin-paid-fields").hidden = !paid;
    if (paid && !ef.elements.paidDate.value) ef.elements.paidDate.value = today();
    var cur = ef.elements.currency.value;
    var selected = ef.elements.accountId.value || (editingEntry && editingEntry.accountId);
    ef.elements.accountId.innerHTML = accountOptions(cur, selected);
  }

  function openEntry(type, entry) {
    editingEntry = entry || null;
    type = entry ? entry.type : type;
    ef.reset();
    setStatus("#fin-entry-status", "");
    ef.elements.id.value = entry ? entry.id : "";
    ef.elements.type.value = type;
    $("#fin-entry-title").textContent = T(entry ? (type === "in" ? "fin.editIn" : "fin.editOut") : (type === "in" ? "fin.newInTitle" : "fin.newOutTitle")) +
      (entry && entry.installment ? " (" + entry.installment.n + "/" + entry.installment.of + ")" : "");
    $("#fin-paid-label").textContent = T(type === "in" ? "fin.alreadyReceived" : "fin.alreadyPaid");
    $("#fin-paiddate-label").textContent = T(type === "in" ? "fin.receivedOn" : "fin.paidOn");
    fillParty(type, entry);
    ef.elements.description.value = entry ? entry.description : "";
    ef.elements.amount.value = entry ? String(entry.amount).replace(".", ",") : "";
    ef.elements.currency.value = entry ? entry.currency : A.defaultCurrency();
    ef.elements.dueDate.value = entry ? entry.dueDate : today();
    ef.elements.category.value = entry ? entry.category || "" : "";
    ef.elements.document.value = entry ? entry.document || "" : "";
    ef.elements.notes.value = entry ? entry.notes || "" : "";
    $("#fin-categories").innerHTML = categories(type).map(function (c) { return '<option value="' + esc(c) + '"></option>'; }).join("");
    ef.elements.repeat.innerHTML = REPEATS.map(function (n) { return '<option value="' + n + '">' + esc(n === 1 ? T("fin.noRepeat") : T("fin.repeatN", { n: n })) + "</option>"; }).join("");
    $("#fin-repeat-wrap").hidden = Boolean(entry);
    ef.elements.paid.checked = Boolean(entry && entry.status === "paid");
    ef.elements.paidDate.value = entry && entry.paidDate ? entry.paidDate : "";
    ef.elements.accountId.innerHTML = "";
    ef.elements.proformaId.innerHTML = "";
    syncPaid();
    fillProformas(entry);
    $("#fin-entry-delete").hidden = !entry;
    openDialog($("#fin-entry-dlg"));
    ef.elements.description.focus();
  }

  ef.elements.party.addEventListener("change", function () {
    $("#fin-partyname-wrap").hidden = ef.elements.party.value !== "other";
    ef.elements.proformaId.value = "";
    fillProformas(null);
  });
  ef.elements.currency.addEventListener("change", syncPaid);
  ef.elements.paid.addEventListener("change", syncPaid);
  ef.elements.accountId.addEventListener("change", function () {
    var a = accountById(ef.elements.accountId.value);
    if (a) ef.elements.currency.value = a.currency;
  });
  // Choosing a proforma fills the client, amount, currency and description.
  ef.elements.proformaId.addEventListener("change", function () {
    var pf = (proformas || []).filter(function (p) { return p.id === ef.elements.proformaId.value; })[0];
    if (!pf) return;
    if (pf.clientId && ef.elements.party.querySelector('option[value="c:' + pf.clientId + '"]')) ef.elements.party.value = "c:" + pf.clientId;
    if (!ef.elements.amount.value) ef.elements.amount.value = String(pf.totals.sale).replace(".", ",");
    ef.elements.currency.value = pf.currency;
    if (!ef.elements.description.value) ef.elements.description.value = T("fin.pfDescription", { number: pf.number });
    if (!ef.elements.category.value) ef.elements.category.value = categories("in")[0];
    syncPaid();
  });

  ef.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = ef.elements.id.value;
    var party = ef.elements.party.value;
    var body = {
      type: ef.elements.type.value,
      description: ef.elements.description.value,
      amount: ef.elements.amount.value,
      currency: ef.elements.currency.value,
      dueDate: ef.elements.dueDate.value,
      category: ef.elements.category.value,
      document: ef.elements.document.value,
      notes: ef.elements.notes.value,
      clientId: party.indexOf("c:") === 0 ? party.slice(2) : "",
      supplierId: party.indexOf("s:") === 0 ? party.slice(2) : "",
      partyName: party === "other" ? ef.elements.partyName.value : "",
      proformaId: ef.elements.type.value === "in" ? ef.elements.proformaId.value : "",
      status: ef.elements.paid.checked ? "paid" : "open",
      paidDate: ef.elements.paid.checked ? ef.elements.paidDate.value : "",
      accountId: ef.elements.paid.checked ? ef.elements.accountId.value : (editingEntry && editingEntry.accountId) || "",
      repeat: id ? 1 : ef.elements.repeat.value
    };
    var bad = [];
    ef.elements.description.classList.toggle("is-invalid", !body.description.trim()); if (!body.description.trim()) bad.push("description");
    var amt = A.parseDecimal(body.amount);
    ef.elements.amount.classList.toggle("is-invalid", !(amt > 0)); if (!(amt > 0)) bad.push("amount");
    ef.elements.dueDate.classList.toggle("is-invalid", !body.dueDate); if (!body.dueDate) bad.push("due");
    if (bad.length) return setStatus("#fin-entry-status", T("fin.err.required"), "error");
    if (body.status === "paid" && !body.accountId) return setStatus("#fin-entry-status", T("fin.err.account"), "error");
    var btn = $("#fin-entry-save");
    btn.disabled = true;
    A.api(id ? "/api/finance?kind=entry&id=" + encodeURIComponent(id) : "/api/finance?kind=entry", { method: id ? "PUT" : "POST", body: body })
      .then(function (d) {
        (d.entries || [d.entry]).forEach(replaceEntry);
        closeDialog($("#fin-entry-dlg"));
        render();
        setStatus("#fin-status-msg", T(d.entries && d.entries.length > 1 ? "fin.savedMany" : "fin.saved", { n: d.entries ? d.entries.length : 1 }), "ok");
      })
      .catch(function (err) { setStatus("#fin-entry-status", errorText(err), "error"); })
      .then(function () { btn.disabled = false; });
  });

  $("#fin-entry-delete").addEventListener("click", function () {
    var e = editingEntry;
    if (!e || !confirm(T("fin.confirmDelete", { name: e.description }))) return;
    A.api("/api/finance?kind=entry&id=" + encodeURIComponent(e.id), { method: "DELETE" }).then(function () {
      entries = entries.filter(function (x) { return x.id !== e.id; });
      closeDialog($("#fin-entry-dlg"));
      render();
      setStatus("#fin-status-msg", T("fin.deleted"), "ok");
    }).catch(function (err) { setStatus("#fin-entry-status", errorText(err), "error"); });
  });

  $("#fin-new-in").addEventListener("click", function () { openEntry("in"); });
  $("#fin-new-out").addEventListener("click", function () { openEntry("out"); });

  /* ---------- Mark as paid / received ---------- */
  var pf = $("#fin-pay-form");
  var payingEntry = null;

  function openPay(id) {
    var e = entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    payingEntry = e;
    setStatus("#fin-pay-status", "");
    $("#fin-pay-title").textContent = T(e.type === "in" ? "fin.receiveTitle" : "fin.payTitle");
    $("#fin-pay-what").textContent = e.description + (e.party ? " · " + e.party.name : "") + " · " + money(e.amount, e.currency) + " · " + T("fin.dueOn", { date: fmtDate(e.dueDate) });
    pf.elements.paidDate.value = today();
    pf.elements.amount.value = String(e.amount).replace(".", ",");
    pf.elements.accountId.innerHTML = accountOptions(e.currency, e.accountId);
    $("#fin-pay-save").disabled = !accounts.some(function (a) { return a.currency === e.currency; });
    if ($("#fin-pay-save").disabled) setStatus("#fin-pay-status", T("fin.noAccountFor", { cur: (A.CURRENCIES[e.currency] || A.CURRENCIES.CNY).label }), "error");
    openDialog($("#fin-pay-dlg"));
  }

  pf.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var e = payingEntry;
    if (!e) return;
    var btn = $("#fin-pay-save");
    btn.disabled = true;
    A.api("/api/finance?kind=entry&id=" + encodeURIComponent(e.id) + "&action=pay", { method: "POST",
      body: { paidDate: pf.elements.paidDate.value, accountId: pf.elements.accountId.value, amount: pf.elements.amount.value } })
      .then(function (d) {
        replaceEntry(d.entry);
        closeDialog($("#fin-pay-dlg"));
        render();
        setStatus("#fin-status-msg", T(e.type === "in" ? "fin.receivedOk" : "fin.paidOk"), "ok");
      })
      .catch(function (err) { setStatus("#fin-pay-status", errorText(err), "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Bank accounts ---------- */
  var af = $("#fin-acc-form");

  function renderAccounts() {
    $("#fin-acc-list").innerHTML = accounts.length ? accounts.map(function (a) {
      var used = entries.some(function (e) { return e.accountId === a.id; });
      return '<li data-acc="' + esc(a.id) + '"><div><b>' + esc(a.name) + "</b><small>" + esc([a.bank, a.number, (A.CURRENCIES[a.currency] || A.CURRENCIES.CNY).label].filter(Boolean).join(" · ")) + "</small></div>" +
        '<b class="' + (balanceAt(a) < 0 ? "is-neg" : "") + '">' + esc(signed(balanceAt(a), a.currency)) + "</b>" +
        '<div class="fin-acc-actions"><button type="button" class="linkbtn" data-acc-edit>' + esc(T("list.edit")) + "</button>" +
        (used ? "" : '<button type="button" class="linkbtn danger" data-acc-del>' + esc(T("list.delete")) + "</button>") + "</div></li>";
    }).join("") : '<li class="muted">' + esc(T("fin.noAccounts")) + "</li>";
  }

  function resetAccountForm() {
    af.reset();
    af.elements.id.value = "";
    af.elements.currency.value = A.defaultCurrency();
    af.elements.currency.disabled = false;
    af.elements.openingDate.value = today();
    $("#fin-acc-title").textContent = T("fin.accNew");
    $("#fin-acc-cancel").hidden = true;
    setStatus("#fin-acc-status", "");
  }

  function openAccounts() {
    renderAccounts();
    resetAccountForm();
    openDialog($("#fin-acc-dlg"));
  }
  $("#fin-accounts-btn").addEventListener("click", openAccounts);
  $("#fin-acc-cancel").addEventListener("click", resetAccountForm);

  $("#fin-acc-list").addEventListener("click", function (e) {
    var li = e.target.closest("[data-acc]");
    if (!li) return;
    var a = accountById(li.dataset.acc);
    if (e.target.closest("[data-acc-edit]")) {
      af.elements.id.value = a.id;
      af.elements.name.value = a.name;
      af.elements.bank.value = a.bank || "";
      af.elements.number.value = a.number || "";
      af.elements.currency.value = a.currency;
      af.elements.currency.disabled = entries.some(function (x) { return x.accountId === a.id; });
      af.elements.openingBalance.value = String(a.openingBalance || 0).replace(".", ",");
      af.elements.openingDate.value = a.openingDate;
      $("#fin-acc-title").textContent = T("fin.accEdit");
      $("#fin-acc-cancel").hidden = false;
      af.elements.name.focus();
    } else if (e.target.closest("[data-acc-del]")) {
      if (!confirm(T("fin.confirmDeleteAcc", { name: a.name }))) return;
      A.api("/api/finance?kind=account&id=" + encodeURIComponent(a.id), { method: "DELETE" }).then(function () {
        accounts = accounts.filter(function (x) { return x.id !== a.id; });
        renderAccounts();
        resetAccountForm();
        render();
      }).catch(function (err) { setStatus("#fin-acc-status", errorText(err), "error"); });
    }
  });

  af.addEventListener("submit", function (e) {
    e.preventDefault();
    var id = af.elements.id.value;
    if (!af.elements.name.value.trim()) { af.elements.name.classList.add("is-invalid"); return setStatus("#fin-acc-status", T("fin.err.accName"), "error"); }
    af.elements.name.classList.remove("is-invalid");
    var body = { name: af.elements.name.value, bank: af.elements.bank.value, number: af.elements.number.value, currency: af.elements.currency.value,
      openingBalance: af.elements.openingBalance.value, openingDate: af.elements.openingDate.value };
    var btn = $("#fin-acc-save");
    btn.disabled = true;
    A.api(id ? "/api/finance?kind=account&id=" + encodeURIComponent(id) : "/api/finance?kind=account", { method: id ? "PUT" : "POST", body: body })
      .then(function (d) {
        replaceAccount(d.account);
        renderAccounts();
        resetAccountForm();
        setStatus("#fin-acc-status", T("fin.accSaved"), "ok");
        render();
      })
      .catch(function (err) { setStatus("#fin-acc-status", errorText(err), "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Excel of what is on screen ---------- */
  $("#fin-xlsx").addEventListener("click", function () {
    var btn = this;
    btn.disabled = true;
    window.ProformaDoc.loadScript("https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js").then(function () {
      var wb = new window.ExcelJS.Workbook();
      var ws = wb.addWorksheet(T("fin.title"));
      var navy = "FF0B2A4F";
      var a = accountById($("#fin-account").value);
      var rows, headers, widths, title;
      if (mode === "statement" && a) {
        title = T("fin.modeStatement") + " — " + a.name;
        headers = [T("fin.date"), T("fin.description").replace(" *", ""), T("fin.inflow"), T("fin.outflow"), T("fin.balance"), T("fin.reconciledShort")];
        widths = [12, 50, 16, 16, 16, 12];
        var from = $("#fin-from").value, to = $("#fin-to").value;
        var run = from ? balanceAt(a, dayBefore(from)) : a.openingBalance || 0;
        rows = [[from ? dayBefore(from) : a.openingDate, T(from ? "fin.balanceBefore" : "fin.openingBalance"), null, null, run, ""]];
        moves(a).forEach(function (e) {
          if ((from && e.paidDate < from) || (to && e.paidDate > to)) return;
          run = r2(run + (e.type === "in" ? e.amount : -e.amount));
          rows.push([e.paidDate, e.description + (e.party ? " · " + e.party.name : ""), e.type === "in" ? e.amount : null, e.type === "out" ? e.amount : null, run, e.reconciled ? "✓" : ""]);
        });
      } else {
        title = T(mode === "in" ? "fin.modeIn" : mode === "out" ? "fin.modeOut" : "fin.modeAll");
        headers = [T("fin.dueDate").replace(" *", ""), T("fin.typeCol"), T("fin.description").replace(" *", ""), T("fin.partyCol"), T("fin.category"), T("fin.document"),
          T("fin.currency"), T("fin.amount").replace(" *", ""), T("fin.situation"), T("fin.paidDateCol"), T("fin.account"), T("fin.reconciledShort")];
        widths = [12, 10, 40, 26, 18, 16, 8, 14, 12, 12, 22, 10];
        rows = filtered().map(function (e) {
          var s = stateOf(e);
          return [e.dueDate, T(e.type === "in" ? "fin.typeIn" : "fin.typeOut"), e.description, e.party ? e.party.name : "", e.category || "", e.document || "",
            (A.CURRENCIES[e.currency] || A.CURRENCIES.CNY).label, e.type === "in" ? e.amount : -e.amount,
            T(s === "paid" ? (e.type === "in" ? "fin.received" : "fin.paid") : s === "overdue" ? "fin.overdue" : "fin.open"),
            e.paidDate || "", e.accountId ? (accountById(e.accountId) || {}).name || "" : "", e.reconciled ? "✓" : ""];
        });
      }
      ws.addRow([title]).font = { bold: true, size: 13, color: { argb: navy } };
      ws.addRow([]);
      var h = ws.addRow(headers);
      h.eachCell(function (c) { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: navy } }; });
      rows.forEach(function (r) {
        var row = ws.addRow(r.map(function (v, i) { return i === 0 && v ? new Date(v + "T00:00:00Z") : v; }));
        row.getCell(1).numFmt = "dd/mm/yyyy";
      });
      ws.columns.forEach(function (col, i) { col.width = widths[i] || 14; });
      var moneyCols = mode === "statement" ? [3, 4, 5] : [8];
      moneyCols.forEach(function (k) { ws.getColumn(k).numFmt = "#,##0.00"; });
      if (mode !== "statement") ws.getColumn(10).numFmt = "dd/mm/yyyy";
      return wb.xlsx.writeBuffer().then(function (buf) {
        var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        var link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = (T("fin.title") + " - " + title + " - " + today()).replace(/[\\/:*?"<>|]+/g, " ") + ".xlsx";
        document.body.appendChild(link);
        link.click();
        setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
      });
    }).catch(function (e) { setStatus("#fin-status-msg", e.message, "error"); })
      .then(function () { btn.disabled = false; });
  });

  /* ---------- Wiring ---------- */
  var started = false;
  document.addEventListener("admin:data", function () {
    if (!started) { started = true; load(); } // first data after login: shows the overdue badge
  });
  document.addEventListener("admin:lang", function () { if (loaded) render(); });
  document.querySelector('.tab[data-tab="finance"]').addEventListener("click", function () {
    proformas = null; // proformas may have changed since
    load();
  });
})();
