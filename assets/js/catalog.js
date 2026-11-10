/* Public product catalog: lists the products registered in the admin area,
   showing each name and description in the visitor's current language. */
(function () {
  "use strict";

  var PAGE = 8;
  var section = document.getElementById("catalog");
  var grid = document.getElementById("catalog-grid");
  var moreBtn = document.getElementById("catalog-more");
  var modal = document.getElementById("product-modal");
  var products = [];
  var visible = PAGE;
  var openProduct = null;

  function lang() { return window.Site ? window.Site.lang() : "en"; }
  function t(key) { return window.Site ? window.Site.t(key) : ""; }
  function pick(obj) {
    obj = obj || {};
    return obj[lang()] || obj.en || obj.pt || obj.es || obj.zh || "";
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render() {
    section.hidden = products.length === 0;
    grid.innerHTML = products.slice(0, visible).map(function (p, i) {
      var desc = pick(p.description);
      return '<button type="button" class="card pcard" data-index="' + i + '">' +
        '<div class="card__img"><img src="' + escapeHtml(p.image) + '" alt="' + escapeHtml(pick(p.name)) + '" loading="lazy" /></div>' +
        '<div class="card__body"><h3><span>' + escapeHtml(pick(p.name)) + '</span> <span class="arrow">→</span></h3>' +
        (desc ? "<p>" + escapeHtml(desc) + "</p>" : "") + "</div></button>";
    }).join("");
    moreBtn.hidden = products.length <= visible;
    if (openProduct) fillModal(openProduct);
  }

  function fillModal(p) {
    document.getElementById("pmodal-img").src = p.image;
    document.getElementById("pmodal-img").alt = pick(p.name);
    document.getElementById("pmodal-title").textContent = pick(p.name);
    document.getElementById("pmodal-desc").textContent = pick(p.description);
  }

  function closeModal() {
    openProduct = null;
    if (modal.open) modal.close();
  }

  grid.addEventListener("click", function (e) {
    var card = e.target.closest(".pcard");
    if (!card) return;
    openProduct = products[Number(card.dataset.index)];
    fillModal(openProduct);
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", "");
  });

  document.getElementById("pmodal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  modal.addEventListener("close", function () { openProduct = null; });

  // "Get a quote" fills the contact form with the product name.
  document.getElementById("pmodal-quote").addEventListener("click", function () {
    var name = openProduct ? pick(openProduct.name) : "";
    closeModal();
    var msg = document.querySelector('#quote-form textarea[name="message"]');
    if (msg && name) msg.value = t("catalog.ask") + name + "\n\n" + msg.value;
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
