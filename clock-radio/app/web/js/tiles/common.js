export function pressable(el, { onTap }) {
  const activate = (event) => {
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return;
    event.stopPropagation();
    onTap(event);
  };
  el.addEventListener("click", activate);
  if (el.tagName !== "BUTTON") {
    el.addEventListener("keydown", (event) => {
      if (event.target !== el || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      activate(event);
    });
  }
}
