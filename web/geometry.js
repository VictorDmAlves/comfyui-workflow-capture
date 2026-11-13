/** Stateless calculations. Kept separate for isolated regression tests. */
export function getGraphBounds(graph, titleHeight = 36) {
  const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
  const groups = Array.isArray(graph?._groups) ? graph._groups : [];
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const include = (rect) => {
    if (!rect || rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) return;
    const [x, y, w, h] = rect;
    if (w < 0 || h < 0) return;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + w); bottom = Math.max(bottom, y + h);
  };
  for (const node of nodes) {
    if (!node || !node.pos) continue;
    const x = Number(node.pos[0]), y = Number(node.pos[1]);
    const w = Number(node.size?.[0] ?? 160), h = Number(node.size?.[1] ?? 80);
    // A deliberately generous title margin accommodates custom title rendering.
    include([x - 12, y - titleHeight - 12, w + 24, h + titleHeight + 24]);
  }
  for (const group of groups) {
    const box = group?._bounding ?? group?.bounding ?? group?.getBounding?.();
    // LiteGraph groups include their title/header INSIDE their bounding box.
    // Unlike nodes, groups must not get an extra titleHeight above the box:
    // doing so makes the export's top margin larger than its bottom margin.
    // Node title bounds are handled independently in the node loop above.
    if (box) include([Number(box[0]) - 12, Number(box[1]) - 12,
      Number(box[2]) + 24, Number(box[3]) + 24]);
  }
  const reroutes = graph?.reroutes ?? graph?._reroutes;
  const items = reroutes instanceof Map ? reroutes.values() : (Array.isArray(reroutes) ? reroutes : []);
  for (const item of items) {
    const pos = item?.pos;
    if (pos?.length >= 2) include([Number(pos[0]) - 15, Number(pos[1]) - 15, 30, 30]);
  }
  if (!Number.isFinite(left)) return null;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function captureSize(bounds, zoomPercent, multiplier, padding) {
  const scale = (Number(zoomPercent) / 100) * Number(multiplier);
  const width = Math.ceil(bounds.width * scale + padding * 2);
  const height = Math.ceil(bounds.height * scale + padding * 2);
  return { scale, width, height,
    offset: [padding / scale - bounds.left, padding / scale - bounds.top] };
}

export function groupNodeDependencies(graph, registry = {}, objectInfo = {}) {
  const packages = new Map();
  const nodes = Array.isArray(graph?._nodes) ? graph._nodes : [];
  const builtin = "ComfyUI (built-in)";
  for (const node of nodes) {
    if (!node) continue;
    const type = String(node.type || node.constructor?.type || "Unknown node");
    const entry = registry[type];
    const info = objectInfo[type];
    const module = String(info?.python_module || "");
    const fallback = module.startsWith("custom_nodes.")
      ? module.split(".")[1]
      : (module.startsWith("comfy_extras") || module === "nodes" ? builtin : "Unknown / frontend");
    const pkg = entry?.package || fallback;
    const label = String(entry?.display_name || info?.display_name || type);
    if (!packages.has(pkg)) packages.set(pkg, new Map());
    const entries = packages.get(pkg);
    const key = type;
    const existing = entries.get(key);
    entries.set(key, { type, label, count: (existing?.count || 0) + 1 });
  }
  return Array.from(packages, ([name, list]) => ({
    name, nodes: Array.from(list.values()).sort((a, b) => a.label.localeCompare(b.label)),
    count: Array.from(list.values()).reduce((n, item) => n + item.count, 0),
  })).sort((a, b) => (a.name === builtin) - (b.name === builtin) || a.name.localeCompare(b.name));
}
