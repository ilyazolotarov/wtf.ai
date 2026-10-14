// Dark by default; the switch picks light and the choice is kept in this browser. Screenshots and the demo video carry
// both sources (data-dark, data-light; a video's posters data-dark-poster, data-light-poster): the theme picks one. The head applies the stored theme before the page draws.
(function () {
  var root = document.documentElement;
  var button = document.querySelector(".theme-toggle");

  function apply(theme) {
    if (theme === "light") root.setAttribute("data-theme", "light");
    else root.removeAttribute("data-theme");
    var media = document.querySelectorAll("img[data-dark], video[data-dark]");
    for (var i = 0; i < media.length; i++) {
      var el = media[i];
      var next = el.getAttribute(theme === "light" ? "data-light" : "data-dark");
      if (el.getAttribute("src") !== next) el.setAttribute("src", next);
      var poster = el.getAttribute(theme === "light" ? "data-light-poster" : "data-dark-poster");
      if (poster && el.getAttribute("poster") !== poster) el.setAttribute("poster", poster);
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
