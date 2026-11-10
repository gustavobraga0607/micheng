/* Products page: lists the products registered in the admin area, showing
   each name and description in the visitor's current language, filtered by
   the category in the URL (products?category=fitness). */
(function () {
  "use strict";

  var PAGE = 12;
  // Category ids used by the admin panel -> site text keys (title, description).
  var CATEGORIES = {
    building: ["prod.1.t", "prod.1.d"],
    sanitary: ["prod.2.t", "prod.2.d"],
    fitness: ["prod.3.t", "prod.3.d"],
    general: ["prod.4.t", "prod.4.d"]
  };

  var grid = document.getElementById("catalog-grid");
  var moreBtn = document.getElementById("catalog-more");
  var filters = document.getElementById("catalog-filters");
  var empty = document.getElementById("catalog-empty");
  var modal = document.getElementById("product-modal");
  var products = [];
  var loaded = false;
  var filter = categoryFromUrl();
  var visible = PAGE;
  var openProduct = null;

  function lang() { return window.Site ? window.Site.lang() : "en"; }
  function t(key) { return window.Site ? window.Site.t(key) : ""; }
  function pick(obj) {
    obj = obj || {};
    return obj[lang()] || obj.en || obj.pt || obj.es || obj.zh || "";
  }
  function categoryName(id) { return CATEGORIES[id] ? t(CATEGORIES[id][0]) : ""; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function categoryFromUrl() {
    var id = new URLSearchParams(location.search).get("category");
    return CATEGORIES[id] ? id : "";
  }

  // Link to the contact form on the home page, pre-filled by main.js.
  function quoteUrl(category, productName) {
    var params = new URLSearchParams();
    if (category) params.set("category", category);
    if (productName) params.set("quote", productName);
    var qs = params.toString();
    return "./" + (qs ? "?" + qs : "") + "#contact";
  }

  function renderHeading() {
    document.getElementById("page-title").textContent = filter ? categoryName(filter) : t("catalog.title");
    document.getElementById("page-text").textContent = filter ? t(CATEGORIES[filter][1]) : t("catalog.intro");
    document.getElementById("crumb-category").textContent = filter ? categoryName(filter) : "";
    document.getElementById("crumb-sep").hidden = !filter;
    document.title = (filter ? categoryName(filter) + " | " : "") + t("meta.productsTitle");
  }

  function render() {
    renderHeading();
    filters.querySelectorAll(".chip").forEach(function (chip) {
      var active = chip.dataset.filter === filter;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    });
    var list = products.filter(function (p) { return !filter || p.category === filter; });
    grid.innerHTML = list.slice(0, visible).map(function (p) {
      var desc = pick(p.description);
      var cat = categoryName(p.category);
      return '<button type="button" class="card pcard" data-id="' + escapeHtml(p.id) + '">' +
        '<div class="card__img"><img src="' + escapeHtml(p.image) + '" alt="' + escapeHtml(pick(p.name)) + '" loading="lazy" /></div>' +
        '<div class="card__body">' + (cat ? '<span class="pcard__cat">' + escapeHtml(cat) + "</span>" : "") +
        "<h3><span>" + escapeHtml(pick(p.name)) + '</span> <span class="arrow">→</span></h3>' +
        (desc ? "<p>" + escapeHtml(desc) + "</p>" : "") + "</div></button>";
    }).join("");
    empty.hidden = !loaded || list.length > 0;
    document.getElementById("catalog-empty-cta").href = quoteUrl(filter, "");
    moreBtn.hidden = list.length <= visible;
    if (openProduct) fillModal(openProduct);
  }

  function setFilter(id) {
    filter = CATEGORIES[id] ? id : "";
    visible = PAGE;
    var url = new URL(location.href);
    if (filter) url.searchParams.set("category", filter);
    else url.searchParams.delete("category");
    history.pushState(null, "", url);
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

  filters.addEventListener("click", function (e) {
    var chip = e.target.closest(".chip");
    if (chip) setFilter(chip.dataset.filter);
  });

  // Back/forward buttons move between categories.
  window.addEventListener("popstate", function () {
    filter = categoryFromUrl();
    visible = PAGE;
    render();
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

  document.getElementById("pmodal-quote").addEventListener("click", function () {
    if (openProduct) location.href = quoteUrl(openProduct.category, pick(openProduct.name));
  });

  moreBtn.addEventListener("click", function () {
    visible += PAGE;
    render();
  });

  document.addEventListener("langchange", render);
  render();

  fetch("/api/products", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : { products: [] }; })
    .catch(function () { return { products: [] }; })
    .then(function (data) {
      products = data.products || [];
      loaded = true;
      render();
    });
})();
