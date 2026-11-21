// Port of the endOfContent handling from PDF.js's TextLayerBuilder, which the bare
// TextLayer API leaves out. Without it, dragging past the last word onto empty
// layer space makes the browser resolve the focus to an earlier span, so the
// selection flips to the text above. While selecting, an unselectable div sits
// right after the anchor span and absorbs those hits instead. Unlike PDF.js it
// covers the viewport (see style.css), so leaving the page doesn't flip it either.
export function bindSelectionEnd(layer: HTMLElement): () => void {
  const end = document.createElement("div");
  end.className = "endOfContent";
  layer.append(end);
  const controller = new AbortController();
  const { signal } = controller;
  const reset = () => {
    layer.append(end);
    layer.classList.remove("selecting");
  };
  // Firefox selects past the last span correctly on its own.
  const isFirefox =
    getComputedStyle(layer).getPropertyValue("-moz-user-select") === "none";
  let pointerDown = false;
  let previous: Range | null = null;
  layer.addEventListener("mousedown", () => layer.classList.add("selecting"), {
    signal,
  });
  document.addEventListener("pointerdown", () => (pointerDown = true), {
    signal,
  });
  document.addEventListener(
    "pointerup",
    () => {
      pointerDown = false;
      reset();
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      pointerDown = false;
      reset();
    },
    { signal },
  );
  document.addEventListener(
    "keyup",
    () => {
      if (!pointerDown) reset();
    },
    { signal },
  );
  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection?.rangeCount) return reset();
      const range = selection.getRangeAt(0);
      if (!range.intersectsNode(layer)) return reset();
      layer.classList.add("selecting");
      if (isFirefox) return;
      const modifyStart =
        previous &&
        (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
      let anchor: Node = modifyStart
        ? range.startContainer
        : range.endContainer;
      if (anchor.nodeType === Node.TEXT_NODE && anchor.parentNode)
        anchor = anchor.parentNode;
      const parent = anchor.parentElement;
      if (parent && parent.closest(".textLayer") === layer)
        parent.insertBefore(end, modifyStart ? anchor : anchor.nextSibling);
      previous = range.cloneRange();
    },
    { signal },
  );
  return () => {
    controller.abort();
    end.remove();
  };
}
