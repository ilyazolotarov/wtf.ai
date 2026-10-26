(function () {
  var header = document.querySelector("header.top");
  var button = header.querySelector(".menu-toggle");
  var nav = header.querySelector("nav");
  var language = nav.querySelector("a[hreflang]");
  var theme = nav.querySelector(".theme-toggle");
  var mobile = window.matchMedia("(max-width: 1000px)");

  function placeControls() {
    if (mobile.matches) {
      header.insertBefore(language, button);
      header.insertBefore(theme, button);
    } else {
      nav.appendChild(language);
      nav.appendChild(theme);
    }
  }

  function close(restoreFocus) {
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus();
  }

  button.addEventListener("click", function () {
    button.setAttribute("aria-expanded", button.getAttribute("aria-expanded") === "true" ? "false" : "true");
  });

  nav.addEventListener("click", function (event) {
    if (mobile.matches && event.target.closest("a")) close(true);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && button.getAttribute("aria-expanded") === "true") close(true);
  });

  document.addEventListener("click", function (event) {
    if (!header.contains(event.target)) close(false);
  });

  window.addEventListener("resize", function () {
    if (mobile.matches === (theme.parentElement === header)) return;
    placeControls();
    close(mobile.matches && nav.contains(document.activeElement));
  });

  placeControls();
  header.setAttribute("data-menu", "");
  button.hidden = false;
})();
