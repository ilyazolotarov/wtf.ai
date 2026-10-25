// A left click at a screen point, posted as CGEvents from /usr/bin/osascript, which GitHub's macOS images give the
// Accessibility that posting events needs. Usage: osascript -l JavaScript click.js <x> <y>
/* global ObjC, $, delay -- JavaScript for Automation */
ObjC.import("CoreGraphics");

// eslint-disable-next-line no-unused-vars -- osascript calls it
function run(argv) {
  const point = $.CGPointMake(Number(argv[0]), Number(argv[1]));
  for (const type of [$.kCGEventMouseMoved, $.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, point, $.kCGMouseButtonLeft));
    delay(0.15);
  }
}
