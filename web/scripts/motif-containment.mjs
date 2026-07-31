export function analyzeMotifContainment(raster) {
  const { width, height, data } = raster;
  let visiblePixels = 0;
  let edgePixels = 0;
  let longestEdgeRun = 0;

  const isVisible = (x, y) => data[(y * width + x) * 4 + 3] >= 16;
  const scanEdge = (length, pointAt) => {
    let run = 0;
    for (let index = 0; index < length; index += 1) {
      const [x, y] = pointAt(index);
      if (isVisible(x, y)) {
        edgePixels += 1;
        run += 1;
        longestEdgeRun = Math.max(longestEdgeRun, run);
      } else {
        run = 0;
      }
    }
  };

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (data[pixel * 4 + 3] >= 16) visiblePixels += 1;
  }
  scanEdge(width, (index) => [index, 0]);
  if (height > 1) scanEdge(width, (index) => [index, height - 1]);
  if (height > 2) {
    scanEdge(height - 2, (index) => [0, index + 1]);
    if (width > 1) {
      scanEdge(height - 2, (index) => [width - 1, index + 1]);
    }
  }

  const perimeter = Math.max(1, width * 2 + Math.max(0, height - 2) * 2);
  return {
    visiblePixels,
    edgePixels,
    edgeCoverageRatio: edgePixels / perimeter,
    longestEdgeRun,
    longestEdgeRunRatio: longestEdgeRun / Math.max(width, height),
  };
}

export function hasContainedVisiblePixels(raster) {
  const analysis = analyzeMotifContainment(raster);
  if (analysis.visiblePixels < 4) return false;
  if (analysis.edgePixels === 0) return true;

  // A mark may deliberately graze the canvas edge (Nagano is a representative
  // case). Broad bands and edge illustrations are background composition and
  // must remain in the full flag, so accept only short, sparse contacts.
  return analysis.edgeCoverageRatio <= 0.08 && analysis.longestEdgeRunRatio <= 0.12;
}
