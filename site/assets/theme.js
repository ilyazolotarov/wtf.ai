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
      if (el.getAttribute("src") !== next) {
        // The demo's light and dark cuts are the same drive: the new one goes on from where the old one was. The seek
        // waits for the new src (setting it resets the video), so the old one's place is taken first.
        var time = el.currentTime;
        var paused = el.paused;
        el.setAttribute("src", next);
        if (el.tagName === "VIDEO" && time > 0) resume(el, time, paused);
      }
      var poster = el.getAttribute(theme === "light" ? "data-light-poster" : "data-dark-poster");
      if (poster && el.getAttribute("poster") !== poster) el.setAttribute("poster", poster);
    }
    if (button) {
      // The button names the theme it switches to.
      button.textContent = button.getAttribute(theme === "light" ? "data-to-dark" : "data-to-light");
      button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    }
  }

  // Seeks once the video knows its length; with `paused` given (a theme switch), it also keeps the old src's state, as
  // a new src starts over, playing or not by autoplay.
  function resume(video, time, paused) {
    function seek() {
      video.removeEventListener("loadedmetadata", seek);
      video.currentTime = isFinite(video.duration) ? Math.min(time, video.duration) : time;
      if (paused === true) video.pause();
      else if (paused === false) {
        var playing = video.play();
        if (playing && playing.catch) playing.catch(function () {});
      }
    }
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek);
  }

  // The hero's demo plays by itself, unless the reader asked the system for less motion: then it waits, with controls.
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    var videos = document.querySelectorAll("video[autoplay]");
    for (var v = 0; v < videos.length; v++) {
      videos[v].removeAttribute("autoplay");
      videos[v].setAttribute("controls", "");
      videos[v].pause();
    }
  }

  var stored = null;
  try {
    stored = localStorage.getItem("theme");
  } catch (e) {}
  apply(stored);

  // The demo goes on from where this browser left it, after a reload or on the other language's page: all four cuts
  // are the same drive. After the stored theme picked its src, so the seek lands on that one.
  var demo = document.querySelector("video[data-dark]");
  if (demo) {
    var saved = NaN;
    try {
      saved = parseFloat(localStorage.getItem("demoTime"));
    } catch (e) {}
    if (saved > 0) resume(demo, saved);
    demo.addEventListener("timeupdate", function () {
      if (demo.currentTime <= 0) return;
      try {
        localStorage.setItem("demoTime", demo.currentTime.toFixed(1));
      } catch (e) {}
    });
  }

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
