/* شكراً معالي الوزير — front-end logic
 * Wall + counter read from GET /api/wall; the join form posts multipart
 * data to POST /api/join (stored as 'pending' until approved in /admin).
 */
(function () {
  "use strict";

  var MAX_LOGO_BYTES = 2 * 1024 * 1024;
  var ALLOWED_TYPES = ["image/png", "image/jpeg", "image/svg+xml"];
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Share buttons ---------- */
  var shareText = "انضممت إلى مبادرة «شكراً معالي الوزير» تأييداً للقرار الوزاري رقم 10 لسنة 2026 بشأن تنظيم عمولات منصات التوصيل. انضموا معنا:";
  var pageUrl = location.origin + location.pathname.replace(/[^/]*$/, "");
  var shareX = document.getElementById("shareX");
  var shareWa = document.getElementById("shareWa");
  if (shareX) shareX.href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(shareText) + "&url=" + encodeURIComponent(pageUrl);
  if (shareWa) shareWa.href = "https://wa.me/?text=" + encodeURIComponent(shareText + " " + pageUrl);

  /* ---------- Wall + counter ---------- */
  var wallGrid = document.getElementById("wallGrid");
  var wallEmpty = document.getElementById("wallEmpty");
  var counterEl = document.getElementById("counter");

  var PAGE_SIZE = 10;
  var wallRows = [];
  var wallPage = 0;

  function renderWall(rows) {
    wallRows = rows;
    wallPage = 0;
    renderWallPage();
  }

  function renderWallPage() {
    var rows = wallRows.slice(wallPage * PAGE_SIZE, (wallPage + 1) * PAGE_SIZE);
    wallGrid.innerHTML = "";
    renderPager();
    if (!rows.length) {
      wallEmpty.hidden = false;
      return;
    }
    wallEmpty.hidden = true;

    var observer = null;
    if (!reducedMotion && "IntersectionObserver" in window) {
      observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            observer.unobserve(e.target);
          }
        });
      }, { threshold: 0.15 });
    }

    rows.forEach(function (row) {
      var tile = document.createElement("div");
      tile.className = "tile" + (observer ? " reveal" : "");
      var img = document.createElement("img");
      img.src = row.logo_url;
      img.alt = "شعار " + row.name_ar;
      img.loading = "lazy";
      var name = document.createElement("div");
      name.className = "tile-name";
      name.textContent = row.name_ar;
      if (row.message) tile.title = row.message;
      tile.appendChild(img);
      tile.appendChild(name);
      wallGrid.appendChild(tile);
      if (observer) observer.observe(tile);
    });
  }

  function renderPager() {
    var pager = document.getElementById("wallPager");
    var totalPages = Math.ceil(wallRows.length / PAGE_SIZE);
    if (!pager) {
      pager = document.createElement("nav");
      pager.id = "wallPager";
      pager.className = "wall-pager";
      pager.setAttribute("aria-label", "تصفح صفحات الجدار");
      wallGrid.insertAdjacentElement("afterend", pager);
    }
    pager.innerHTML = "";
    pager.hidden = totalPages <= 1;
    if (totalPages <= 1) return;

    function makeBtn(label, disabled, onClick) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener("click", onClick);
      return b;
    }

    pager.appendChild(makeBtn("السابق", wallPage === 0, function () {
      wallPage--; renderWallPage();
    }));
    var info = document.createElement("span");
    info.className = "pager-info";
    info.textContent = "صفحة " + (wallPage + 1) + " من " + totalPages;
    pager.appendChild(info);
    pager.appendChild(makeBtn("التالي", wallPage >= totalPages - 1, function () {
      wallPage++; renderWallPage();
    }));
  }

  function animateCounter(target) {
    if (reducedMotion || target === 0 || document.hidden) {
      counterEl.textContent = String(target);
      return;
    }
    var start = null;
    var duration = 900;
    function step(ts) {
      if (!start) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      counterEl.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function loadWall() {
    fetch("/api/wall")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        renderWall(data.rows || []);
        animateCounter(data.count || 0);
      })
      .catch(function (err) {
        console.error("wall load failed:", err);
        renderWall([]);
        counterEl.textContent = "0";
      });
  }

  if (wallGrid) loadWall();

  /* ---------- Contact / removal request modal ---------- */
  var contactBtn = document.getElementById("contactBtn");
  var contactModal = document.getElementById("contactModal");
  if (contactBtn && contactModal) {
    var contactForm = document.getElementById("contactForm");
    var contactError = document.getElementById("contactError");
    var contactSuccess = document.getElementById("contactSuccess");
    var contactSubmit = document.getElementById("contactSubmit");

    var openModal = function () {
      contactModal.hidden = false;
      document.body.style.overflow = "hidden";
      document.getElementById("crRestaurant").focus();
    };
    var closeModal = function () {
      contactModal.hidden = true;
      document.body.style.overflow = "";
    };

    contactBtn.addEventListener("click", openModal);
    document.getElementById("contactClose").addEventListener("click", closeModal);
    contactModal.addEventListener("click", function (e) {
      if (e.target === contactModal) closeModal();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !contactModal.hidden) closeModal();
    });

    contactForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      contactError.hidden = true;
      if (!contactForm.reportValidity()) return;

      contactSubmit.disabled = true;
      contactSubmit.textContent = "جارٍ الإرسال…";

      fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          restaurant_name: document.getElementById("crRestaurant").value.trim(),
          contact_name: document.getElementById("crName").value.trim(),
          contact_info: document.getElementById("crInfo").value.trim(),
          message: document.getElementById("crMsg").value.trim(),
        }),
      })
        .then(function (r) {
          if (r.status === 429) throw new Error("rate");
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function () {
          contactForm.hidden = true;
          contactSuccess.hidden = false;
        })
        .catch(function (err) {
          contactError.textContent = err.message === "rate"
            ? "عدد كبير من الطلبات — الرجاء المحاولة لاحقاً."
            : "تعذّر الإرسال — الرجاء المحاولة مرة أخرى.";
          contactError.hidden = false;
          contactSubmit.disabled = false;
          contactSubmit.textContent = "إرسال الطلب";
        });
    });
  }

  /* ---------- Join form ---------- */
  var form = document.getElementById("joinForm");
  if (!form) return;

  var messageEl = document.getElementById("message");
  var charCount = document.getElementById("charCount");
  messageEl.addEventListener("input", function () {
    charCount.textContent = String(messageEl.value.length);
  });

  var logoInput = document.getElementById("logo");
  var logoError = document.getElementById("logoError");

  function validateLogo(file) {
    if (!file) return "الرجاء اختيار ملف الشعار.";
    if (ALLOWED_TYPES.indexOf(file.type) === -1) return "نوع الملف غير مدعوم — المسموح: PNG أو JPG أو SVG.";
    if (file.size > MAX_LOGO_BYTES) return "حجم الملف يتجاوز 2 م.ب.";
    return null;
  }

  logoInput.addEventListener("change", function () {
    var err = validateLogo(logoInput.files[0]);
    logoError.textContent = err || "";
    logoError.hidden = !err;
    if (err) logoInput.value = "";
  });

  var formError = document.getElementById("formError");
  var submitBtn = document.getElementById("submitBtn");
  var formSuccess = document.getElementById("formSuccess");

  function showError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "سجّل مطعمك";
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    formError.hidden = true;

    if (!form.reportValidity()) return;

    var file = logoInput.files[0];
    var logoErr = validateLogo(file);
    if (logoErr) { showError(logoErr); return; }

    submitBtn.disabled = true;
    submitBtn.textContent = "جارٍ الإرسال…";

    fetch("/api/join", { method: "POST", body: new FormData(form) })
      .then(function (r) {
        if (r.status === 429) throw new Error("rate");
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function () {
        form.hidden = true;
        formSuccess.hidden = false;
        formSuccess.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
      })
      .catch(function (err) {
        console.error("submit failed:", err);
        showError(err.message === "rate"
          ? "عدد كبير من المحاولات — الرجاء المحاولة لاحقاً."
          : "تعذّر الإرسال — الرجاء المحاولة مرة أخرى.");
      });
  });
})();
