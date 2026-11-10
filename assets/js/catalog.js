/* Public product catalog: lists the products registered in the admin area,
   showing each name and description in the visitor's current language,
   with a filter by category. */
(function () {
  "use strict";

  var PAGE = 8;
  // Category ids used by the admin panel -> site text keys.
  var CATEGORY_KEYS = { building: "prod.1.t", sanitary: "prod.2.t", fitness: "prod.3.t", general: "prod.4.t" };
  var CATEGORY_ORDER = ["building", "sanitary", "fitness", "general"];

  var section = document.getElementById("catalog");
  var grid = document.getElementById("catalog-grid");
  var moreBtn = document.getElementById("catalog-more");
  var filters = document.getElementById("catalog-filters");
  var modal = document.getElementById("product-modal");
  var products = [];
  var filter = "";
  var visible = PAGE;
  var openProduct = null;

  function lang() { return window.Site ? window.Site.lang() : "en"; }
  function t(key) { return window.Site ? window.Site.t(key) : ""; }
  function pick(obj) {
    obj = obj || {};
    return obj[lang()] || obj.en || obj.pt || obj.es || obj.zh || "";
  }
  function categoryName(id) { return CATEGORY_KEYS[id] ? t(CATEGORY_KEYS[id]) : ""; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function shown() {
    return products.filter(function (p) { return !filter || p.category === filter; });
  }

  function render() {
    section.hidden = products.length === 0;
    filters.querySelectorAll(".chip").forEach(function (chip) {
      var id = chip.dataset.filter;
      chip.classList.toggle("is-active", id === filter);
      chip.setAttribute("aria-pressed", id === filter ? "true" : "false");
      chip.disabled = Boolean(id) && !products.some(function (p) { return p.category === id; });
    });
    var list = shown();
    grid.innerHTML = list.slice(0, visible).map(function (p) {
      var desc = pick(p.description);
      var cat = categoryName(p.category);
      return '<button type="button" class="card pcard" data-id="' + escapeHtml(p.id) + '">' +
        '<div class="card__img"><img src="' + escapeHtml(p.image) + '" alt="' + escapeHtml(pick(p.name)) + '" loading="lazy" /></div>' +
        '<div class="card__body">' + (cat ? '<span class="pcard__cat">' + escapeHtml(cat) + "</span>" : "") +
        "<h3><span>" + escapeHtml(pick(p.name)) + '</span> <span class="arrow">→</span></h3>' +
        (desc ? "<p>" + escapeHtml(desc) + "</p>" : "") + "</div></button>";
    }).join("");
    moreBtn.hidden = list.length <= visible;
    if (openProduct) fillModal(openProduct);
  }

  function setFilter(id) {
    filter = id || "";
    visible = PAGE;
    render();
  }

  function fillModal(p) {
    document.getElementById("pmodal-img").src = p.image;
    document.getElementById("pmodal-img").alt = pick(p.name);
    document.getElementById("pmodal-cat").textContent = categoryName(p.category);
    document.getElementById("pmodal-title").textContent = pick(p.name);
    document.getElementById("pmodal-desc").textContent = pick(p.description);
  }

  function closeModal() {
    openProduct = null;
    if (modal.open) modal.close();
  }

  // Pre-selects a category in the contact form's "Product category" select.
  function selectContactCategory(id) {
    var select = document.querySelector('#quote-form select[name="category"]');
    var index = CATEGORY_ORDER.indexOf(id);
    if (select && index > -1) select.selectedIndex = index;
  }

  filters.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip");
    if (chip && !chip.disabled) setFilter(chip.dataset.filter);
  });

  // Category cards on the home page: show that category's products when there
  // are any, otherwise go to the contact form with the category selected.
  document.querySelectorAll(".cards .card[data-category]").forEach(function (card) {
    card.addEventListener("click", function (e) {
      var id = card.dataset.category;
      selectContactCategory(id);
      if (!products.some(function (p) { return p.category === id; })) return;
      e.preventDefault();
      setFilter(id);
      section.scrollIntoView({ behavior: "smooth" });
    });
  });

  grid.addEventListener("click", function (e) {
    var card = e.target.closest(".pcard");
    if (!card) return;
    openProduct = products.filter(function (p) { return p.id === card.dataset.id; })[0];
    if (!openProduct) return;
    fillModal(openProduct);
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", "");
  });

  document.getElementById("pmodal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  modal.addEventListener("close", function () { openProduct = null; });

  // "Get a quote" fills the contact form with the product name and category.
  document.getElementById("pmodal-quote").addEventListener("click", function () {
    var p = openProduct;
    closeModal();
    if (p) {
      selectContactCategory(p.category);
      var msg = document.querySelector('#quote-form textarea[name="message"]');
      if (msg) msg.value = t("catalog.ask") + pick(p.name) + "\n\n" + msg.value;
    }
    document.getElementById("contact").scrollIntoView({ behavior: "smooth" });
  });

  moreBtn.addEventListener("click", function () {
    visible += PAGE;
    render();
  });

  document.addEventListener("langchange", render);

  fetch("/api/products", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : { products: [] }; })
    .then(function (data) {
      products = data.products || [];
      render();
    })
    .catch(function () { /* catalog stays hidden if the API is unavailable */ });
})();
