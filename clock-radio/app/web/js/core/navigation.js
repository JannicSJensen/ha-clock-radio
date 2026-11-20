export const NAVIGATION_CONTROLS = "input,textarea,select,[contenteditable],[role=dialog],[role=slider],[role=spinbutton],[role=combobox],.slider";

export function navigationKey(event) {
  if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || event.target?.closest?.(NAVIGATION_CONTROLS)) return null;
  if (["ArrowLeft", "PageUp"].includes(event.key)) return { axis: "horizontal", step: -1 };
  if (["ArrowRight", "PageDown"].includes(event.key)) return { axis: "horizontal", step: 1 };
  if (event.key === "ArrowUp") return { axis: "vertical", step: -1 };
  if (event.key === "ArrowDown") return { axis: "vertical", step: 1 };
  return null;
}
