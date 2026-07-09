// ui_nav.js — sticky-nav scroll-spy + back-to-top. Self-contained, no dependencies.
(function () {
  "use strict";
  const nav = document.getElementById("topnav");
  const toTop = document.getElementById("to-top");

  if (toTop) {
    toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    const onScroll = () => toTop.classList.toggle("show", window.scrollY > 400);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  if (nav && "IntersectionObserver" in window) {
    const links = Array.from(nav.querySelectorAll("a"));
    const byId = {};
    for (const a of links) {
      const el = document.getElementById(a.getAttribute("href").slice(1));
      if (el) byId[el.id] = a;
    }
    // Highlight the section whose top is nearest just below the sticky nav.
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          links.forEach((l) => l.classList.remove("active"));
          if (byId[e.target.id]) byId[e.target.id].classList.add("active");
        }
      }
    }, { rootMargin: "-54px 0px -72% 0px", threshold: 0 });
    Object.keys(byId).forEach((id) => io.observe(document.getElementById(id)));
  }
})();
