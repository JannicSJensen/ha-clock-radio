export function swipeStep(dx, dy, elapsed, axis) {
  const distance = axis === "horizontal" ? dx : dy;
  const cross = axis === "horizontal" ? dy : dx;
  return elapsed <= 1200 && Math.abs(distance) >= 64 && Math.abs(distance) > Math.abs(cross) * 1.5 ? distance < 0 ? 1 : -1 : 0;
}

export function canScroll(target, boundary, step, axis = "vertical") {
  const horizontal = axis === "horizontal";
  for (let el = target; el; el = el.parentElement) {
    const size = horizontal ? el.scrollWidth : el.scrollHeight;
    const client = horizontal ? el.clientWidth : el.clientHeight;
    const position = horizontal ? el.scrollLeft : el.scrollTop;
    if (size > client + 1 && /auto|scroll/.test(getComputedStyle(el)[horizontal ? "overflowX" : "overflowY"])) {
      if (step > 0 ? position + client < size - 1 : position > 1) return true;
    }
    if (el === boundary) break;
  }
  return false;
}

export function onSwipe(el, { horizontal, vertical, ignore = ".slider,input,select,textarea,[contenteditable],[role=dialog],[role=slider]" }) {
  let start = null;
  const begin = (event) => {
    const touch = event.touches[0];
    start = event.touches.length === 1 && !event.target.closest(ignore)
      ? { x: touch.clientX, y: touch.clientY, at: Date.now(), target: event.target, scrolling: false, scrollingX: false } : null;
  };
  const move = (event) => {
    if (!start || event.touches.length !== 1) { start = null; return; }
    const touch = event.touches[0], dx = touch.clientX - start.x, dy = touch.clientY - start.y;
    if (Math.abs(dy) > Math.abs(dx) * 1.5 && Math.abs(dy) > 8) {
      start.scrolling ||= canScroll(start.target, el, dy < 0 ? 1 : -1);
      if (vertical && !start.scrolling) event.preventDefault();
    } else if (horizontal && Math.abs(dx) > Math.abs(dy) * 1.5 && Math.abs(dx) > 8) {
      start.scrollingX ||= canScroll(start.target, el, dx < 0 ? 1 : -1, "horizontal");
      if (!start.scrollingX) event.preventDefault();
    }
  };
  const finish = (event) => {
    if (!start || event.touches.length) { start = null; return; }
    const touch = event.changedTouches[0], previous = start;
    start = null;
    const dx = touch.clientX - previous.x, dy = touch.clientY - previous.y, elapsed = Date.now() - previous.at;
    const x = swipeStep(dx, dy, elapsed, "horizontal"), y = swipeStep(dx, dy, elapsed, "vertical");
    if (x && horizontal && !previous.scrollingX) { event.preventDefault(); horizontal(x, previous.target); }
    else if (y && vertical && !previous.scrolling) { event.preventDefault(); vertical(y, previous.target); }
  };
  const cancel = () => { start = null; };
  el.addEventListener("touchstart", begin, { passive: true });
  el.addEventListener("touchmove", move, { passive: false });
  el.addEventListener("touchend", finish, { passive: false });
  el.addEventListener("touchcancel", cancel);
  return () => {
    el.removeEventListener("touchstart", begin);
    el.removeEventListener("touchmove", move);
    el.removeEventListener("touchend", finish);
    el.removeEventListener("touchcancel", cancel);
  };
}
