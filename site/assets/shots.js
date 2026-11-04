// The app's screenshots: an endless strip, the first shot coming again after the last. A hidden copy of the set goes on
// each side of it; the strip starts on the set itself, and once it settles more than half a set into a copy it moves
// by one set, at once, to the same picture. It moves on by itself, a shot every few seconds, while it is on screen. A
// reader's hand stops it: it waits while the mouse is over it and for a while after a touch, a scroll, a key or an
// arrow. Not for readers who asked the system for less motion. The arrows (previous, next) show where there is a mouse;
// a touch screen swipes.
(function () {
  var strip = document.querySelector(".shots");
  if (!strip) return;
  var frame = strip.parentNode;
  var arrows = document.querySelectorAll(".shots-arrow");
  var EVERY = 3500;
  var IDLE = 8000;

  var shots = Array.prototype.slice.call(strip.children);
  if (!shots.length) return;
  for (var c = 0; c < shots.length; c++) {
    var before = shots[c].cloneNode(true);
    var after = shots[c].cloneNode(true);
    before.setAttribute("aria-hidden", "true");
    after.setAttribute("aria-hidden", "true");
    strip.insertBefore(before, shots[0]);
    strip.appendChild(after);
  }

  // The captions under the strip: a row of their own, kept at the strip's scroll. The figures' own are hidden; each
  // shot's alt says the same.
  var row = document.createElement("div");
  row.className = "shots-captions";
  row.setAttribute("aria-hidden", "true");
  for (var t = 0; t < strip.children.length; t++) {
    var caption = strip.children[t].querySelector("figcaption");
    var span = document.createElement("span");
    span.textContent = caption ? caption.textContent : "";
    row.appendChild(span);
  }
  frame.insertBefore(row, strip.nextSibling);
  frame.classList.add("split");

  // One set's width (from the first copy's first shot to the set's), and one shot's with the gap after it.
  function setWidth() {
    return shots[0].offsetLeft - strip.children[0].offsetLeft;
  }
  function stepWidth() {
    return shots.length > 1 ? shots[1].offsetLeft - shots[0].offsetLeft : setWidth();
  }

  function wrap() {
    var set = setWidth();
    if (set <= 0) return;
    if (strip.scrollLeft < set / 2) strip.scrollLeft += set;
    else if (strip.scrollLeft >= set * 1.5) strip.scrollLeft -= set;
    row.scrollLeft = strip.scrollLeft;
  }
  var settle;
  strip.addEventListener("scroll", function () {
    row.scrollLeft = strip.scrollLeft;
    clearTimeout(settle);
    settle = setTimeout(wrap, 150);
  }, { passive: true });
  strip.scrollLeft = setWidth();
  row.scrollLeft = strip.scrollLeft;

  function step(direction) {
    if (strip.scrollWidth - strip.clientWidth <= 1) return;
    strip.scrollTo({ left: strip.scrollLeft + direction * stepWidth(), behavior: "smooth" });
  }

  var heldUntil = 0;
  function hold() {
    heldUntil = Date.now() + IDLE;
  }

  // The arrows where there is a mouse (the stylesheet hides them on a phone's width too).
  var mouse = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)");
  function showArrows() {
    for (var a = 0; a < arrows.length; a++) arrows[a].hidden = !(mouse && mouse.matches);
  }
  for (var a = 0; a < arrows.length; a++) {
    arrows[a].addEventListener("click", function () {
      hold();
      step(Number(this.getAttribute("data-step")));
    });
  }
  showArrows();
  if (mouse && mouse.addEventListener) mouse.addEventListener("change", showArrows);

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var hovered = false;
  var visible = false;
  // The frame, not the strip: the arrows over it count.
  frame.addEventListener("mouseenter", function () {
    hovered = true;
  });
  frame.addEventListener("mouseleave", function () {
    hovered = false;
  });
  var events = ["pointerdown", "touchstart", "wheel", "keydown", "focusin"];
  for (var i = 0; i < events.length; i++) strip.addEventListener(events[i], hold, { passive: true });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].isIntersecting;
    }, { threshold: 0.5 }).observe(strip);
  } else visible = true;

  setInterval(function () {
    if (!visible || hovered || document.hidden || Date.now() < heldUntil) return;
    step(1);
  }, EVERY);
})();
