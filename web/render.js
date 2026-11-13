import { captureSize } from "./geometry.js";

/**
 * Render the entire active classic LiteGraph on temporary surfaces.
 *
 * A LiteGraph canvas and its DragAndScale keep separate viewport dimensions.
 * Swapping only view.canvas leaves the original (screen-sized) culling area in
 * place; wide workflows then show group backgrounds but omit nodes to the right.
 * This function temporarily makes BOTH viewports match the export surface.
 */
export function renderEntireGraph(view, bounds, settings, createCanvas) {
  if (!view?.canvas || !view?.ds || typeof view.draw !== "function") {
    throw new Error("The classic LiteGraph canvas is not available on this ComfyUI frontend.");
  }

  const { scale, width, height, offset } = captureSize(
    bounds, settings.zoom, settings.resolution, settings.padding
  );
  const frontCanvas = createCanvas(width, height);
  const backCanvas = createCanvas(width, height);
  const result = createCanvas(width, height);
  const { ds } = view;
  const originalViewportSize = typeof ds.getViewportSize === "function"
    ? ds.getViewportSize() : null;
  const oldVisibleArea = view.visible_area ? Array.from(view.visible_area) : null;
  const snapshot = {
    canvas: view.canvas,
    ctx: view.ctx,
    bgcanvas: view.bgcanvas,
    bgctx: view.bgctx,
    viewport: view.viewport,
    dsElement: ds.element,
    dpr: view.dpr,
    scale: ds.scale,
    offset: Array.from(ds.offset),
    dirty_canvas: view.dirty_canvas,
    dirty_bgcanvas: view.dirty_bgcanvas,
    dirty_area: view.dirty_area,
    visible_nodes: view.visible_nodes,
    visible_node_ids: view._visible_node_ids,
    clear_background: view.clear_background,
    rendering_scale: view.rendering_scale,
    show_info: view.show_info,
  };

  try {
    view.canvas = frontCanvas;
    view.ctx = frontCanvas.getContext("2d");
    view.bgcanvas = backCanvas;
    view.bgctx = backCanvas.getContext("2d");
    if (!view.ctx || !view.bgctx) {
      throw new Error("Could not allocate the temporary workflow render contexts.");
    }

    // Explicit full-area viewport controls clipping AND visible-node culling.
    // In older builds, DragAndScale may instead read ds.element dimensions.
    view.viewport = [0, 0, width, height];
    if ("element" in ds) ds.element = frontCanvas;
    ds.setViewportSize?.(width, height);

    // These are one pixel per logical render coordinate. Keeping the original
    // monitor DPR here incorrectly scales the background and nodes differently.
    if (typeof view.dpr === "number") view.dpr = 1;
    ds.scale = scale;
    ds.offset[0] = offset[0];
    ds.offset[1] = offset[1];
    view.dirty_canvas = true;
    view.dirty_bgcanvas = true;
    view.dirty_area = null;
    view.visible_nodes = [];
    view._visible_node_ids = new Set();
    view.show_info = false;
    view.draw(true, true);

    // The modern front canvas already composites its background. Retain the
    // background as a fallback for old LiteGraph builds with separate layers.
    const ctx = result.getContext("2d");
    if (!ctx) throw new Error("Could not allocate the final workflow image.");
    ctx.fillStyle = settings.background;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(backCanvas, 0, 0);
    ctx.drawImage(frontCanvas, 0, 0);
  } finally {
    view.canvas = snapshot.canvas;
    view.ctx = snapshot.ctx;
    view.bgcanvas = snapshot.bgcanvas;
    view.bgctx = snapshot.bgctx;
    view.viewport = snapshot.viewport;
    if ("element" in ds) ds.element = snapshot.dsElement;
    if (originalViewportSize) {
      ds.setViewportSize?.(...originalViewportSize);
    } else {
      ds.invalidateViewportSize?.();
    }
    if (typeof snapshot.dpr === "number") view.dpr = snapshot.dpr;
    ds.scale = snapshot.scale;
    ds.offset[0] = snapshot.offset[0];
    ds.offset[1] = snapshot.offset[1];
    view.dirty_canvas = true;
    view.dirty_bgcanvas = true;
    view.dirty_area = snapshot.dirty_area;
    view.visible_nodes = snapshot.visible_nodes;
    view._visible_node_ids = snapshot.visible_node_ids;
    view.clear_background = snapshot.clear_background;
    view.rendering_scale = snapshot.rendering_scale;
    view.show_info = snapshot.show_info;
    if (oldVisibleArea && view.visible_area) {
      for (let i = 0; i < oldVisibleArea.length; i++) {
        view.visible_area[i] = oldVisibleArea[i];
      }
    }
    view.setDirtyCanvas?.(true, true);
  }
  return result;
}
