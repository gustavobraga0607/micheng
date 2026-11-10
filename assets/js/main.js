(function () {
  "use strict";

  var SUPPORTED = ["en", "pt", "es", "zh"];
  var HTML_LANG = { en: "en", pt: "pt-BR", es: "es", zh: "zh-CN" };
  // Address that receives the quote requests from the contact form.
  var CONTACT_EMAIL = "contact@micheng.com";
  var STORAGE_KEY = "micheng-lang";
  var current = "en";

  function storageGet() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
  }
  function storageSet(v) {
    try { localStorage.setItem(STORAGE_KEY, v); } catch (e) { /* ignore */ }
  }

  function detectLang() {
    var fromUrl = new URLSearchParams(location.search).get("lang");
    if (fromUrl && SUPPORTED.indexOf(fromUrl) > -1) return fromUrl;
    var saved = storageGet();
    if (saved && SUPPORTED.indexOf(saved) > -1) return saved;
    var langs = navigator.languages || [navigator.language || "en"];
    for (var i = 0; i < langs.length; i++) {
      var code = String(langs[i]).toLowerCase().slice(0, 2);
      if (SUPPORTED.indexOf(code) > -1) return code;
    }
    return "en";
  }

  function t(key) {
    var dict = window.I18N[current] || {};
    return dict[key] != null ? dict[key] : (window.I18N.en[key] || "");
  }

  function setLang(lang) {
    if (SUPPORTED.indexOf(lang) < 0) lang = "en";
    current = lang;
    storageSet(lang);

    document.documentElement.lang = HTML_LANG[lang];
    document.title = t("meta.title");
    var desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", t("meta.desc"));

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var value = t(el.getAttribute("data-i18n"));
      if (!value) return;
      if (el.hasAttribute("data-i18n-html")) el.innerHTML = value;
      else el.textContent = value;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
      el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    });
    document.querySelectorAll(".lang__btn").forEach(function (btn) {
      var active = btn.getAttribute("data-lang") === lang;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });

    var url = new URL(location.href);
    url.searchParams.set("lang", lang);
    history.replaceState(null, "", url);

    document.dispatchEvent(new CustomEvent("langchange", { detail: lang }));
  }

  // Used by catalog.js to render products in the current language.
  window.Site = {
    lang: function () { return current; },
    t: t
  };

  /* ---------- Language buttons ---------- */
  document.querySelectorAll(".lang__btn").forEach(function (btn) {
    btn.addEventListener("click", function () { setLang(btn.getAttribute("data-lang")); });
  });

  /* ---------- Mobile menu ---------- */
  var burger = document.getElementById("burger");
  var nav = document.getElementById("nav");
  function closeMenu() {
    nav.classList.remove("is-open");
    burger.setAttribute("aria-expanded", "false");
  }
  burger.addEventListener("click", function () {
    var open = nav.classList.toggle("is-open");
    burger.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.querySelectorAll("a").forEach(function (a) { a.addEventListener("click", closeMenu); });

  /* ---------- Active nav link on scroll ---------- */
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav__link"));
  var sections = links
    .map(function (a) { return document.querySelector(a.getAttribute("href")); })
    .filter(Boolean);

  function onScroll() {
    var y = window.scrollY + 120;
    var activeIdx = 0;
    sections.forEach(function (sec, i) {
      if (sec.id !== "top" && sec.offsetTop <= y) activeIdx = i;
    });
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) activeIdx = links.length - 1;
    links.forEach(function (a, i) { a.classList.toggle("is-active", i === activeIdx); });
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- Reveal on scroll ---------- */
  var revealEls = document.querySelectorAll(".feature, .card, .service, .step, .about > *, .contact > *");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealEls.forEach(function (el) { el.classList.add("reveal"); io.observe(el); });
  }

  /* ---------- Quote form (opens the visitor's e-mail app) ---------- */
  var form = document.getElementById("quote-form");
  var note = document.getElementById("form-note");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var required = ["name", "email", "message"];
    var ok = true;
    required.forEach(function (name) {
      var field = form.elements[name];
      var valid = field.value.trim() !== "" && (name !== "email" || /^\S+@\S+\.\S+$/.test(field.value.trim()));
      field.classList.toggle("is-invalid", !valid);
      if (!valid) ok = false;
    });
    if (!ok) { note.textContent = t("form.error"); return; }

    var subject = "Quote request — " + data.get("category") + " — " + data.get("name");
    var body = [
      t("form.name") + ": " + data.get("name"),
      t("form.company") + ": " + data.get("company"),
      t("form.email") + ": " + data.get("email"),
      t("form.country") + ": " + data.get("country"),
      t("form.category") + ": " + data.get("category"),
      "",
      data.get("message")
    ].join("\n");

    note.textContent = t("form.ok");
    location.href = "mailto:" + CONTACT_EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
  });

  document.getElementById("year").textContent = new Date().getFullYear();
  setLang(detectLang());
  onScroll();
})();
