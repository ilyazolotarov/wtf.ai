// Dark by default; the switch picks light and the choice is kept in this browser. Screenshots carry both sources
// (data-dark, data-light): the theme picks one. The head applies the stored theme before the page draws.
(function () {
  var root = document.documentElement;
  var button = document.querySelector(".theme-toggle");

  function apply(theme) {
    if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    var images = document.querySelectorAll("img[data-dark]");
    for (var i = 0; i < images.length; i++) {
      var next = images[i].getAttribute(theme === "light" ? "data-light" : "data-dark");
      if (images[i].getAttribute("src") !== next) images[i].setAttribute("src", next);
    }
    if (button) {
      // The button names the theme it switches to.
      button.textContent = button.getAttribute(theme === "light" ? "data-to-dark" : "data-to-light");
      button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    }
  }

  var stored = null;
  try {
    stored = localStorage.getItem("theme");
  } catch (e) {}
  apply(stored);

  if (button) {
    button.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      try {
        localStorage.setItem("theme", next);
      } catch (e) {}
      apply(next);
    });
  }
})();
