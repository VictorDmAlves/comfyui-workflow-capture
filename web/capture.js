import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { getGraphBounds, captureSize, groupNodeDependencies } from "./geometry.js";
import { renderEntireGraph } from "./render.js";
import { makeGitHubPreview } from "./github.js";

const EXTENSION_NAME = "Vic.WorkflowCapture";
const BUILTIN = "ComfyUI (built-in)";
const MAX_SIDE = 16384;
const MAX_AREA = 48_000_000;
const MAX_EXAMPLES = 6;
const ACCENT = "#75d6ef";

function attachStyles() {
  if (document.getElementById("vic-workflow-capture-css")) return;
  const link = document.createElement("link");
  link.id = "vic-workflow-capture-css";
  link.rel = "stylesheet";
  link.href = new URL("./capture.css", import.meta.url).href;
  document.head.append(link);
}

function createCanvas(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_AREA) {
    throw new Error(`Image dimensions ${width} x ${height} exceed the prototype's safe limit (${MAX_SIDE}px per side, 48 megapixels). Reduce zoom or resolution.`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Could not allocate a 2D canvas. Try a smaller resolution.");
  return canvas;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Browser failed to encode PNG.")), "image/png");
    } catch (err) { reject(err); }
  });
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function safeName(name) {
  return String(name || "workflow").trim().replace(/[\\/:*?"<>|\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-").slice(0, 100) || "workflow";
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let i = 0; i < 8; i++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function writeUInt(bytes, n, index) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(index, n >>> 0, false);
}

/** PNG iTXt chunk: uncompressed UTF-8, understood by Pillow/ComfyUI PNG workflow loader. */
async function embedWorkflowMetadata(blob, workflowObject) {
  const original = new Uint8Array(await blob.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((b, i) => original[i] === b)) throw new Error("Not a PNG file.");
  let position = 8;
  while (position + 12 <= original.length) {
    const dv = new DataView(original.buffer, original.byteOffset + position);
    const length = dv.getUint32(0, false);
    const type = String.fromCharCode(...original.subarray(position + 4, position + 8));
    if (type === "IDAT") break;
    position += length + 12;
  }
  if (position + 12 > original.length) throw new Error("Malformed PNG file.");
  const utf8 = new TextEncoder().encode(JSON.stringify(workflowObject));
  const keyword = new TextEncoder().encode("workflow");
  const data = new Uint8Array(keyword.length + 5 + utf8.length);
  data.set(keyword, 0);
  // Null delimiter, compression flag 0, compression method 0,
  // empty language tag, empty translated keyword (all zeroed).
  data.set(utf8, keyword.length + 5);
  const chunk = new Uint8Array(data.length + 12);
  writeUInt(chunk, data.length, 0);
  chunk.set([105, 84, 88, 116], 4); // iTXt
  chunk.set(data, 8);
  writeUInt(chunk, crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return new Blob([original.subarray(0, position), chunk, original.subarray(position)], { type: "image/png" });
}

function roundedRect(ctx, x, y, w, h, radius, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fill();
}
function textLines(ctx, content, width) {
  const out = [];
  for (const paragraph of String(content || "").split(/\r?\n/)) {
    if (!paragraph.trim()) { out.push(""); continue; }
    let current = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const merged = current ? `${current} ${word}` : word;
      if (current && ctx.measureText(merged).width > width) {
        out.push(current); current = word;
      } else { current = merged; }
      // Break extraordinarily long, unspaced custom-node IDs.
      while (ctx.measureText(current).width > width && current.length > 1) {
        let take = current.length - 1;
        while (take > 1 && ctx.measureText(current.slice(0, take)).width > width) take--;
        out.push(current.slice(0, take));
        current = current.slice(take);
      }
    }
    if (current) out.push(current);
  }
  return out;
}

/**
 * Creates a portrait/landscape documentation poster based on content width,
 * preserving all details in the independent workflow-only PNG export.
 */
function makePresentation({ screenshot, title, author, description, samples, dependencies, builtin, zoom }) {
  const width = Math.max(1200, Math.min(3200, screenshot.width + 160));
  const unit = width / 1600;
  const pad = Math.round(80 * unit);
  const inner = width - pad * 2;
  const temp = createCanvas(1, 1);
  const measureContext = temp.getContext("2d");
  const producedAt = new Date().toLocaleDateString();
  const hasCustom = dependencies.some((p) => p.name !== BUILTIN);
  const filtered = dependencies.filter((p) => builtin || p.name !== BUILTIN);

  const draw = (ctx, paint) => {
    let y = 76 * unit;
    const label = (s, x, yy, font = 22, color = "#8f9aaf", weight = 600) => {
      ctx.font = `${weight} ${Math.round(font * unit)}px system-ui, -apple-system, Segoe UI, sans-serif`;
      ctx.fillStyle = color;
      if (paint) ctx.fillText(s, x, yy);
    };
    const paragraph = (value, x, yy, w, font = 29, color = "#dbe2ef", gap = 1.38, weight = 400) => {
      ctx.font = `${weight} ${Math.round(font * unit)}px system-ui, -apple-system, Segoe UI, sans-serif`;
      ctx.fillStyle = color;
      const lines = textLines(ctx, value, w);
      const lineHeight = Math.ceil(font * gap * unit);
      if (paint) lines.forEach((line, i) => ctx.fillText(line, x, yy + i * lineHeight));
      return yy + lines.length * lineHeight;
    };
    const section = (name) => {
      y += 46 * unit;
      label(name.toUpperCase(), pad, y, 22, ACCENT, 750);
      y += 33 * unit;
    };
    label("WORKFLOW / CAPTURE", pad, y, 22, ACCENT, 750);
    y += 79 * unit;
    y = paragraph(title || "Untitled workflow", pad, y, inner, 65, "#f6f9ff", 1.12, 750);
    y += 10 * unit;
    label([author ? `By ${author}` : "", `${dependencies.reduce((n, p) => n + p.count, 0)} nodes`, `${zoom}% zoom`, producedAt]
      .filter(Boolean).join("   /   "), pad, y, 23, "#a6b2c7");
    y += 46 * unit;
    if (paint) { ctx.strokeStyle = "#2d374c"; ctx.lineWidth = 2 * unit;
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke(); }

    section("Workflow overview");
    const displayedW = Math.min(inner - 40 * unit, screenshot.width);
    const displayedH = Math.round(screenshot.height * displayedW / screenshot.width);
    if (paint) {
      roundedRect(ctx, pad, y - 24 * unit, inner, displayedH + 50 * unit, 22 * unit, "#111620");
      ctx.drawImage(screenshot, pad + (inner - displayedW) / 2, y, displayedW, displayedH);
    }
    y += displayedH + 45 * unit;

    if (filtered.length || hasCustom) {
      section("Nodes and dependencies");
      for (const group of filtered) {
        label(`${group.name}  /  ${group.count} node${group.count === 1 ? "" : "s"}`, pad, y,
          32, "#f2f6ff", 700);
        y += 45 * unit;
        const listing = group.nodes.map((n) => `${n.label}${n.count > 1 ? ` (x${n.count})` : ""}`).join("  |  ");
        y = paragraph(listing, pad + 18 * unit, y, inner - 30 * unit, 25, "#aebdd2", 1.38);
        y += 35 * unit;
      }
    }
    if (samples.length) {
      section("Generated examples");
      const count = Math.min(3, samples.length);
      const gutter = 20 * unit;
      const cardW = (inner - gutter * (count - 1)) / count;
      const imageH = Math.round(360 * unit);
      for (let start = 0; start < samples.length; start += count) {
        const row = samples.slice(start, start + count);
        if (paint) row.forEach((item, i) => {
          const x = pad + i * (cardW + gutter);
          roundedRect(ctx, x, y, cardW, imageH + 64 * unit, 18 * unit, "#1a2330");
          const image = item.image;
          const scale = Math.min((cardW - 20 * unit) / image.naturalWidth,
            (imageH - 20 * unit) / image.naturalHeight);
          const dw = image.naturalWidth * scale, dh = image.naturalHeight * scale;
          ctx.drawImage(image, x + (cardW - dw) / 2, y + (imageH - dh) / 2, dw, dh);
          const caption = item.caption || `Example ${start + i + 1}`;
          ctx.font = `${Math.round(21 * unit)}px system-ui, -apple-system, Segoe UI, sans-serif`;
          let visible = caption;
          while (visible.length > 1 && ctx.measureText(visible).width > cardW - 40 * unit) {
            visible = visible.slice(0, -1);
          }
          if (visible !== caption) visible = visible.slice(0, -1) + "…";
          label(visible, x + 20 * unit, y + imageH + 38 * unit, 21, "#d7deeb");
        });
        y += imageH + 86 * unit;
      }
    }
    if (description.trim()) {
      section("Author notes");
      y = paragraph(description, pad, y, inner, 29, "#dce4f0", 1.55);
      y += 16 * unit;
    }

    y += 52 * unit;
    if (paint) { ctx.strokeStyle = "#293347"; ctx.lineWidth = 2 * unit;
      ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke(); }
    y += 40 * unit;
    label("CREATED WITH COMFYUI WORKFLOW CAPTURE", pad, y, 20, "#7c8ca2", 650);
    return Math.ceil(y + 75 * unit);
  };

  const height = draw(measureContext, false);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#10151e";
  ctx.fillRect(0, 0, width, height);
  draw(ctx, true);
  return canvas;
}

function makeElement(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.firstElementChild;
}

class WorkflowCaptureDialog {
  constructor() {
    this.dialog = null;
    this.graphImage = null;
    this.imageURL = null;
    this.githubPreviewURL = null;
    this.githubPreviewCanvas = null;
    this.previewMode = "workflow";
    this.previewRevision = 0;
    this.previewTimer = null;
    this.capturedZoom = 60;
    this.samples = [];
    this.dependencies = [];
    this.registry = {};
    this.objectInfo = {};
    this.busy = false;
    this._escHandler = (e) => { if (e.key === "Escape" && this.dialog && !this.busy) this.close(); };
  }

  element(selector) { return this.dialog.querySelector(selector); }
  get setting() {
    return {
      zoom: Number(this.element("#vwc-zoom").value),
      resolution: Number(this.element("#vwc-resolution").value),
      padding: Number(this.element("#vwc-padding").value),
      background: this.element("#vwc-background").value,
    };
  }
  get details() {
    return {
      title: this.element("#vwc-title").value.trim() || "ComfyUI Workflow",
      author: this.element("#vwc-author").value.trim(),
      description: this.element("#vwc-description").value.trim(),
      dependencies: this.dependencies,
      samples: this.samples,
      builtin: this.element("#vwc-core").checked,
      zoom: this.capturedZoom,
      githubType: this.element("#vwc-github-type").value,
      githubModel: this.element("#vwc-github-model").value.trim(),
      githubSummary: this.element("#vwc-github-summary").value.trim(),
      githubDensity: this.element("#vwc-github-density").value,
    };
  }
  status(message, isError = false) {
    const el = this.element("#vwc-status");
    if (!el) return;
    el.textContent = message;
    el.dataset.error = isError ? "1" : "0";
  }
  setBusy(value) {
    this.busy = value;
    this.dialog?.querySelectorAll("button[data-action]").forEach((button) => {
      button.disabled = value;
    });
  }

  async open() {
    if (this.dialog) return;
    attachStyles();
    this.dialog = makeElement(`
      <div class="vwc-backdrop" role="presentation">
        <div class="vwc-dialog" role="dialog" aria-modal="true" aria-label="Capture Workflow">
          <header class="vwc-header">
            <div><span class="vwc-eyebrow">COMFYUI / EXPORT STUDIO</span><h2>Capture Workflow <small>v0.2.0</small></h2></div>
            <button class="vwc-icon-button" data-action="close" type="button" title="Close" aria-label="Close">✕</button>
          </header>
          <div class="vwc-main">
            <section class="vwc-preview-area">
              <div class="vwc-section-bar"><div class="vwc-preview-tabs" role="group" aria-label="Preview mode">
                <button class="vwc-preview-tab vwc-preview-tab-active" data-action="preview-workflow" type="button" aria-pressed="true">Workflow</button>
                <button class="vwc-preview-tab" data-action="preview-github" type="button" aria-pressed="false">GitHub Preview</button>
              </div><span id="vwc-dimensions">Not captured yet</span></div>
              <div class="vwc-preview"><div class="vwc-placeholder"><span class="vwc-placeholder-icon">▦</span><strong>Preparing capture</strong><small>All nodes will be included, even those outside the current viewport.</small></div><img id="vwc-capture-image" alt="Whole ComfyUI workflow" hidden></div>
              <div class="vwc-status-row"><span class="vwc-indicator"></span><span id="vwc-status" role="status">Preparing…</span></div>
              <div class="vwc-subheading">Detected plugins and nodes</div>
              <div id="vwc-dependencies" class="vwc-dependencies"><p class="vwc-muted">Loading installed node information…</p></div>
            </section>
            <aside class="vwc-sidebar">
              <div class="vwc-settings-group"><h3>01 <span>Capture settings</span></h3>
                <div class="vwc-form-row"><label>Workflow zoom <input id="vwc-zoom" type="number" min="20" max="200" step="5" value="60"> <span class="vwc-suffix">%</span></label>
                <label>Resolution <select id="vwc-resolution"><option value="1">1× — Original</option><option value="2" selected>2× — High (recommended)</option><option value="3">3× — Ultra</option></select></label></div>
                <div class="vwc-form-row"><label>Padding <input id="vwc-padding" type="number" min="0" max="500" step="10" value="80"> <span class="vwc-suffix">px</span></label>
                <label>Background <select id="vwc-background"><option value="#191a20">ComfyUI dark</option><option value="#10151e">Dark</option><option value="#ffffff">White</option></select></label></div>
                <button class="vwc-button vwc-button-outline" data-action="recapture" type="button">↻ &nbsp; Capture / Refresh</button>
                <div id="vwc-estimate" class="vwc-hint"></div>
              </div>
              <div class="vwc-settings-group"><h3>02 <span>Presentation details</span></h3>
                <label>Workflow title <input id="vwc-title" type="text" maxlength="150" placeholder="e.g. Krea 2 — Image to Image" value="My Workflow"></label>
                <label>Author <input id="vwc-author" type="text" maxlength="120" placeholder="Name or GitHub handle (optional)"></label>
                <label>Notes / workflow description <textarea id="vwc-description" rows="4" maxlength="4000" placeholder="How it works, model requirements, recommended settings, instructions…"></textarea></label>
                <label class="vwc-toggle"><input id="vwc-core" type="checkbox"><span>Include built-in ComfyUI nodes in the presentation</span></label>
              </div>
              <div class="vwc-settings-group"><h3>03 <span>GitHub Preview</span></h3>
                <div class="vwc-form-row"><label>Workflow type
                  <select id="vwc-github-type"><option value="Workflow">Workflow</option><option value="TXT2IMG">TXT2IMG</option><option value="IMG2IMG">IMG2IMG</option><option value="Image Editing">Image Editing</option><option value="Upscaler">Upscaler</option><option value="Video">Video</option><option value="Other">Other</option></select>
                </label><label>Layout density
                  <select id="vwc-github-density"><option value="compact" selected>Compact (recommended)</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select>
                </label></div>
                <label>Model / backend <input id="vwc-github-model" type="text" maxlength="70" placeholder="e.g. MOSS-Image 5B (optional)"></label>
                <label>Short README summary <textarea id="vwc-github-summary" rows="3" maxlength="320" placeholder="What does this workflow do? Short description for GitHub."></textarea></label>
                <span class="vwc-hint">Horizontal 2000px layout. Uses up to three result images (first is featured), your plugin names and relevant nodes. Falls back to the presentation notes if the summary is empty.</span>
              </div>
              <div class="vwc-settings-group"><h3>04 <span>Output examples</span></h3>
                <label class="vwc-upload">＋ &nbsp; Add result images <input id="vwc-samples" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden></label>
                <span class="vwc-hint">Up to six images. Automatically resized for the presentation (original files are not changed).</span>
                <div id="vwc-gallery" class="vwc-gallery"></div>
              </div>
              <div class="vwc-settings-group vwc-settings-last"><h3>05 <span>Export</span></h3>
                <label class="vwc-toggle"><input id="vwc-embed" type="checkbox"><span>Embed workflow JSON in PNG (makes it importable; may reveal prompts and settings)</span></label>
                <span class="vwc-hint">Workflow PNG retains the original capture resolution; Presentation PNG is the detailed documentation; GitHub Preview is a compact horizontal cover for README files.</span>
              </div>
            </aside>
          </div>
          <footer class="vwc-footer"><div class="vwc-footer-note">Capture does not execute, move, or save your workflow.</div><div class="vwc-actions">
            <button class="vwc-button vwc-button-muted" data-action="json" type="button">Workflow JSON</button>
            <button class="vwc-button vwc-button-outline" data-action="raw" type="button">Workflow PNG</button>
            <button class="vwc-button vwc-button-outline" data-action="report" type="button">Presentation PNG</button>
            <button class="vwc-button vwc-button-primary" data-action="github" type="button">Export GitHub Preview</button>
          </div></footer>
        </div>
      </div>`);
    document.body.append(this.dialog);
    document.addEventListener("keydown", this._escHandler, true);
    this.dialog.addEventListener("click", (event) => {
      if (event.target === this.dialog) this.close();
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (!action || this.busy) return;
      const actions = {
        close: () => this.close(), recapture: () => this.capture(),
        raw: () => this.export("raw"), report: () => this.export("report"),
        github: () => this.export("github"),
        "preview-workflow": () => this.switchPreview("workflow"),
        "preview-github": () => this.switchPreview("github"),
        json: () => this.exportJSON(),
      };
      actions[action]?.();
    });
    this.element("#vwc-samples").addEventListener("change", (event) => this.addSamples(event.target.files));
    for (const id of ["#vwc-zoom", "#vwc-resolution", "#vwc-padding"]) {
      this.element(id).addEventListener("input", () => this.updateEstimate());
    }
    for (const id of ["#vwc-title", "#vwc-author", "#vwc-description", "#vwc-github-type",
      "#vwc-github-model", "#vwc-github-summary", "#vwc-github-density"]) {
      this.element(id).addEventListener("input", () => this.invalidateGithubPreview());
    }
    // Set dependencies and the first capture independently.
    this.fetchDependencies();
    await this.capture();
  }

  close() {
    if (!this.dialog || this.busy) return;
    this.dialog.remove();
    this.dialog = null;
    if (this.imageURL) URL.revokeObjectURL(this.imageURL);
    if (this.githubPreviewURL) URL.revokeObjectURL(this.githubPreviewURL);
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewRevision++;
    this.imageURL = null;
    this.githubPreviewURL = null;
    this.githubPreviewCanvas = null;
    this.graphImage = null;
    for (const sample of this.samples) URL.revokeObjectURL(sample.url);
    this.samples = [];
    document.removeEventListener("keydown", this._escHandler, true);
  }

  updateEstimate() {
    if (!this.dialog) return;
    const bounds = getGraphBounds(app.graph);
    if (!bounds) return;
    const settings = this.setting;
    const { width, height } = captureSize(bounds, settings.zoom, settings.resolution, settings.padding);
    const unsafe = width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_AREA;
    const target = this.element("#vwc-estimate");
    target.textContent = `Expected PNG: ${width.toLocaleString()} × ${height.toLocaleString()}px${unsafe ? " — exceeds safe image limit" : ""}`;
    target.dataset.error = unsafe ? "1" : "0";
  }

  async fetchDependencies() {
    try {
      const [registryResult, infoResult] = await Promise.allSettled([
        api.fetchApi("/vic_workflow_capture/node_map").then((r) => { if (!r.ok) throw new Error("Registry unavailable"); return r.json(); }),
        api.fetchApi("/object_info").then((r) => { if (!r.ok) throw new Error("Node info unavailable"); return r.json(); }),
      ]);
      if (registryResult.status === "fulfilled") this.registry = registryResult.value.nodes || {};
      if (infoResult.status === "fulfilled") this.objectInfo = infoResult.value || {};
    } catch (error) { console.warn("Workflow Capture: node registry error", error); }
    if (!this.dialog) return;
    this.dependencies = groupNodeDependencies(app.graph, this.registry, this.objectInfo);
    this.renderDependencies();
    this.invalidateGithubPreview();
  }

  renderDependencies() {
    const target = this.element("#vwc-dependencies");
    if (!target) return;
    target.replaceChildren();
    if (!this.dependencies.length) {
      const empty = document.createElement("p"); empty.className = "vwc-muted";
      empty.textContent = "No nodes detected in the current workflow.";
      target.append(empty); return;
    }
    for (const group of this.dependencies) {
      const item = document.createElement("details");
      item.className = "vwc-dep-item";
      item.open = group.name !== BUILTIN;
      const header = document.createElement("summary");
      const pkg = document.createElement("span"); pkg.textContent = group.name;
      const count = document.createElement("em"); count.textContent = `${group.count} node${group.count === 1 ? "" : "s"}`;
      header.append(pkg, count); item.append(header);
      const ul = document.createElement("ul");
      for (const node of group.nodes) {
        const li = document.createElement("li");
        li.textContent = `${node.label}${node.count > 1 ? ` × ${node.count}` : ""}`;
        if (node.label !== node.type) li.title = node.type;
        ul.append(li);
      }
      item.append(ul); target.append(item);
    }
  }

  switchPreview(mode) {
    if (mode !== "workflow" && mode !== "github") return;
    this.previewMode = mode;
    this.dialog?.querySelectorAll(".vwc-preview-tab").forEach((button) => {
      const active = button.dataset.action === `preview-${mode}`;
      button.classList.toggle("vwc-preview-tab-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    this.updatePreview();
  }

  invalidateGithubPreview() {
    this.previewRevision++;
    this.githubPreviewCanvas = null;
    if (this.previewTimer) clearTimeout(this.previewTimer);
    if (this.previewMode === "github" && this.dialog && !this.busy) {
      this.previewTimer = setTimeout(() => { this.previewTimer = null; this.updatePreview(); }, 220);
    }
  }

  async updatePreview() {
    if (!this.dialog || !this.graphImage) return;
    const image = this.element("#vwc-capture-image");
    const dimensions = this.element("#vwc-dimensions");
    if (this.previewMode === "workflow") {
      this.previewRevision++;
      image.src = this.imageURL;
      image.alt = "Complete workflow";
      dimensions.textContent = `${this.graphImage.width.toLocaleString()} × ${this.graphImage.height.toLocaleString()} px`;
      image.hidden = false;
      this.element(".vwc-placeholder").hidden = true;
      return;
    }
    const revision = ++this.previewRevision;
    try {
      const canvas = this.githubPreviewCanvas || makeGitHubPreview({
        screenshot: this.graphImage, ...this.details
      }, createCanvas);
      this.githubPreviewCanvas = canvas;
      const blob = await canvasToBlob(canvas);
      if (!this.dialog || this.previewMode !== "github" || revision !== this.previewRevision) return;
      const nextURL = URL.createObjectURL(blob);
      const previous = this.githubPreviewURL;
      this.githubPreviewURL = nextURL;
      image.src = nextURL;
      image.alt = "GitHub README preview";
      image.hidden = false;
      this.element(".vwc-placeholder").hidden = true;
      dimensions.textContent = `GitHub • ${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} px`;
      if (previous) URL.revokeObjectURL(previous);
    } catch (error) {
      console.error("Workflow Capture: GitHub preview failed", error);
      this.status(error.message || String(error), true);
    }
  }

  async capture() {
    if (!this.dialog || this.busy) return;
    this.setBusy(true);
    this.status("Rendering full workflow…");
    try {
      const bounds = getGraphBounds(app.graph);
      if (!bounds) throw new Error("There are no nodes or groups in this workflow.");
      // Yield once so the status is visibly painted before a synchronous render.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const canvas = renderEntireGraph(app.canvas, bounds, this.setting, createCanvas);
      this.graphImage = canvas;
      this.capturedZoom = this.setting.zoom;
      const prior = this.imageURL;
      const blob = await canvasToBlob(canvas);
      this.imageURL = URL.createObjectURL(blob);
      if (!this.dialog) return;
      this.githubPreviewCanvas = null;
      this.status(`Captured ${app.graph._nodes?.length || 0} nodes with complete graph bounds.`);
      this.updateEstimate();
      this.dependencies = groupNodeDependencies(app.graph, this.registry, this.objectInfo);
      this.renderDependencies();
      await this.updatePreview();
      if (prior) URL.revokeObjectURL(prior);
    } catch (error) {
      console.error("Workflow Capture:", error);
      this.status(error.message || String(error), true);
    } finally { this.setBusy(false); }
  }

  async addSamples(fileList) {
    if (!this.dialog) return;
    const files = [...fileList].filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type));
    const added = Math.min(files.length, MAX_EXAMPLES - this.samples.length);
    for (const file of files.slice(0, added)) {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
        this.samples.push({ image, url, caption: "" });
      } catch (_) { URL.revokeObjectURL(url); }
    }
    this.element("#vwc-samples").value = "";
    this.renderGallery();
    this.invalidateGithubPreview();
    if (files.length > added) this.status(`Only ${MAX_EXAMPLES} example images can be included.`);
  }

  renderGallery() {
    const el = this.element("#vwc-gallery");
    if (!el) return;
    el.replaceChildren();
    this.samples.forEach((sample, index) => {
      const tile = document.createElement("div"); tile.className = "vwc-gallery-item";
      const img = document.createElement("img"); img.src = sample.url; img.alt = `Result example ${index + 1}`;
      const input = document.createElement("input"); input.type = "text";
      input.value = sample.caption; input.maxLength = 65; input.placeholder = `Example ${index + 1} caption`;
      input.addEventListener("input", () => { sample.caption = input.value; this.invalidateGithubPreview(); });
      const remove = document.createElement("button");
      remove.type = "button"; remove.textContent = "✕"; remove.title = "Remove image";
      remove.className = "vwc-remove";
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(sample.url);
        this.samples.splice(index, 1); this.renderGallery(); this.invalidateGithubPreview();
      });
      tile.append(img, remove, input); el.append(tile);
    });
  }

  async prepareBlob(canvas) {
    let blob = await canvasToBlob(canvas);
    if (this.element("#vwc-embed").checked) {
      const workflow = app.graph?.serialize?.();
      if (!workflow) throw new Error("Could not serialize workflow metadata.");
      blob = await embedWorkflowMetadata(blob, workflow);
    }
    return blob;
  }

  async export(kind) {
    if (!this.dialog || this.busy) return;
    if (!this.graphImage) { this.status("Capture your workflow before exporting.", true); return; }
    this.setBusy(true);
    try {
      this.status(kind === "raw" ? "Encoding original PNG…" :
        kind === "github" ? "Preparing compact GitHub preview…" : "Preparing presentation…");
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const data = this.details;
      const canvas = kind === "raw" ? this.graphImage : kind === "github"
        ? makeGitHubPreview({ screenshot: this.graphImage, ...data }, createCanvas)
        : makePresentation({ screenshot: this.graphImage, ...data });
      const blob = await this.prepareBlob(canvas);
      const suffix = kind === "raw" ? "workflow" : kind === "github" ? "github-preview" : "presentation";
      saveBlob(blob, `${safeName(data.title)}-${suffix}.png`);
      this.status(`Exported ${canvas.width.toLocaleString()} × ${canvas.height.toLocaleString()} PNG.`);
    } catch (error) {
      console.error("Workflow Capture: export failed", error);
      this.status(error.message || String(error), true);
    } finally { this.setBusy(false); }
  }

  exportJSON() {
    try {
      const json = app.graph?.serialize?.();
      if (!json) throw new Error("Could not serialize workflow JSON.");
      const title = this.details.title;
      saveBlob(new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }), `${safeName(title)}.json`);
      this.status("Workflow JSON exported.");
    } catch (error) { this.status(error.message || String(error), true); }
  }
}

let currentDialog = null;
async function openCapture() {
  if (currentDialog?.dialog) return;
  currentDialog = new WorkflowCaptureDialog();
  try { await currentDialog.open(); }
  catch (error) { console.error("Workflow Capture: could not open", error); currentDialog.close(); }
}

app.registerExtension({
  name: EXTENSION_NAME,
  commands: [{
    id: "Vic.WorkflowCapture.Open",
    label: "Capture Workflow",
    icon: "icon-[lucide--camera]",
    function: openCapture,
  }],
  menuCommands: [{ path: ["Edit"], commands: ["Vic.WorkflowCapture.Open"] }],
  getCanvasMenuItems() {
    return [{ content: "Capture Workflow", callback: openCapture }];
  },
});
