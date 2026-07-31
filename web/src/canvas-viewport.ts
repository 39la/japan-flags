export type FittedViewport = {
  scale: number;
  offsetX: number;
  offsetY: number;
  contentWidth: number;
  contentHeight: number;
};

export function fitCanvasViewport(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
): FittedViewport {
  const safeViewportWidth = Math.max(1, viewportWidth);
  const safeViewportHeight = Math.max(1, viewportHeight);
  const safeContentWidth = Math.max(1, contentWidth);
  const safeContentHeight = Math.max(1, contentHeight);
  const scale = Math.min(
    safeViewportWidth / safeContentWidth,
    safeViewportHeight / safeContentHeight,
  );
  const fittedWidth = safeContentWidth * scale;
  const fittedHeight = safeContentHeight * scale;
  return {
    scale,
    offsetX: (safeViewportWidth - fittedWidth) / 2,
    offsetY: (safeViewportHeight - fittedHeight) / 2,
    contentWidth: fittedWidth,
    contentHeight: fittedHeight,
  };
}

export function viewportPointToContent(viewport: FittedViewport, x: number, y: number) {
  return {
    x: (x - viewport.offsetX) / viewport.scale,
    y: (y - viewport.offsetY) / viewport.scale,
  };
}
