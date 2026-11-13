/**
 * Compact, README-oriented presentation. This never re-renders or modifies the
 * LiteGraph view: it only scales the already captured workflow canvas.
 */
export const GITHUB_PREVIEW_WIDTH = 2000;
export const GITHUB_PREVIEW_HEIGHTS = Object.freeze({
  compact: 880,
  balanced: 1060,
  detailed: 1220,
});

const COLORS = {
  bg: '#0e141e', panel: '#172230', deep: '#0b111a', line: '#354457',
  cyan: '#75d6ef', text: '#f2f7ff', muted: '#a5b6ca', dim: '#6e849e',
};

export function normalizeGitHubDensity(density) {
  return Object.hasOwn(GITHUB_PREVIEW_HEIGHTS, density) ? density : 'compact';
}

export function githubPluginSummary(dependencies = [], limit = 4) {
  const known = dependencies.filter((group) => group?.name && group.name !== 'ComfyUI (built-in)' &&
    !/^Unknown\s*\//i.test(group.name));
  known.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const names = known.map((group) => group.name);
  return { names: names.slice(0, limit), remaining: Math.max(0, names.length - limit) };
}

export function githubNodeSummary(dependencies = [], limit = 3) {
  const groups = dependencies.filter((group) => group?.name !== 'ComfyUI (built-in)' &&
    !/^Unknown\s*\//i.test(group?.name || ''));
  return groups.flatMap((group) => group.nodes || [])
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit).map((node) => node.label);
}

export function githubShortSummary(custom = '', description = '', dependencies = []) {
  const value = String(custom || '').trim() || String(description || '').trim();
  if (value) return value.replace(/\s+/g, ' ').slice(0, 320);
  const mainNodes = githubNodeSummary(dependencies, 3);
  return mainNodes.length ? `A ComfyUI workflow featuring ${mainNodes.join(', ')}.` :
    'A ComfyUI workflow ready to explore and customize.';
}

function path(ctx, x, y, w, h, r = 0) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
function fill(ctx, x, y, w, h, color, r = 0) {
  ctx.fillStyle = color;
  path(ctx, x, y, w, h, r);
  ctx.fill();
}
function panel(ctx, x, y, w, h, radius = 20) {
  fill(ctx, x, y, w, h, COLORS.panel, radius);
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  path(ctx, x, y, w, h, radius);
  ctx.stroke();
}
function font(ctx, px, weight = 500) {
  ctx.font = `${weight} ${px}px system-ui, -apple-system, Segoe UI, Arial, sans-serif`;
}
function measure(ctx, value, maxWidth) {
  const original = String(value || '');
  if (ctx.measureText(original).width <= maxWidth) return original;
  let low = 0, high = original.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(original.slice(0, mid) + '\u2026').width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return original.slice(0, low).trimEnd() + '\u2026';
}
function label(ctx, value, x, y, color = COLORS.cyan, size = 20) {
  font(ctx, size, 750);
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}
function fitText(ctx, value, x, y, maxWidth, base = 70, min = 39) {
  let px = base;
  for (; px > min; px -= 2) {
    font(ctx, px, 780);
    if (ctx.measureText(value).width <= maxWidth) break;
  }
  font(ctx, Math.max(min, px), 780);
  ctx.fillStyle = COLORS.text;
  ctx.fillText(measure(ctx, value, maxWidth), x, y);
}
function wrapLines(ctx, text, width, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let current = '';
  for (let i = 0; i < words.length; i++) {
    const next = current ? `${current} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= width) { current = next; continue; }
    if (current) lines.push(current);
    current = words[i];
    if (ctx.measureText(current).width > width) {
      lines.push(measure(ctx, current, width));
      current = '';
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.length) {
    // Reconstruct any omitted remainder into the final visible line.
    const joined = lines.join(' ');
    const source = words.join(' ');
    if (joined !== source) lines[lines.length - 1] = measure(ctx, lines[lines.length - 1] + '\u2026', width);
  }
  return lines;
}
function paragraph(ctx, text, x, y, width, maxLines, size = 28, gap = 1.38) {
  font(ctx, size, 450);
  ctx.fillStyle = '#cad8e9';
  const lines = wrapLines(ctx, text, width, maxLines);
  const lineHeight = Math.round(size * gap);
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
  return y + lines.length * lineHeight;
}
function imageDimensions(img) {
  return { w: img.naturalWidth || img.width || 1, h: img.naturalHeight || img.height || 1 };
}
function imageFit(ctx, image, x, y, w, h, mode = 'contain') {
  const { w: iw, h: ih } = imageDimensions(image);
  const scale = (mode === 'cover' ? Math.max : Math.min)(w / iw, h / ih);
  const rw = iw * scale, rh = ih * scale;
  ctx.drawImage(image, x + (w - rw) / 2, y + (h - rh) / 2, rw, rh);
}
function clippedImage(ctx, image, x, y, w, h, radius = 12) {
  ctx.save();
  path(ctx, x, y, w, h, radius);
  ctx.clip();
  fill(ctx, x, y, w, h, '#101925');
  ctx.globalAlpha = 0.28;
  ctx.filter = 'blur(18px)';
  imageFit(ctx, image, x - 25, y - 25, w + 50, h + 50, 'cover');
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  imageFit(ctx, image, x + 7, y + 7, w - 14, h - 14);
  ctx.restore();
}
function sampleTile(ctx, item, x, y, w, h, index) {
  fill(ctx, x, y, w, h, '#101925', 15);
  clippedImage(ctx, item.image, x, y, w, h, 15);
  const grad = ctx.createLinearGradient(0, y + h - 77, 0, y + h);
  grad.addColorStop(0, '#09101a00');
  grad.addColorStop(1, '#09101aef');
  ctx.save();
  path(ctx, x, y, w, h, 15); ctx.clip();
  ctx.fillStyle = grad; ctx.fillRect(x, y + h - 80, w, 80);
  font(ctx, 19, 650); ctx.fillStyle = '#eef7ff';
  ctx.fillText(measure(ctx, item.caption?.trim() || `Example ${index + 1}`, w - 32), x + 17, y + h - 20);
  ctx.restore();
}
function drawSamples(ctx, samples, x, y, w, h) {
  const usable = samples.slice(0, 3);
  if (!usable.length) return;
  const gap = 12;
  if (usable.length === 1) { sampleTile(ctx, usable[0], x, y, w, h, 0); return; }
  if (usable.length === 2) {
    const cw = (w - gap) / 2;
    usable.forEach((sample, i) => sampleTile(ctx, sample, x + i * (cw + gap), y, cw, h, i));
    return;
  }
  const featuredW = Math.round(w * .57);
  const sideW = w - featuredW - gap;
  const halfH = (h - gap) / 2;
  sampleTile(ctx, usable[0], x, y, featuredW, h, 0);
  sampleTile(ctx, usable[1], x + featuredW + gap, y, sideW, halfH, 1);
  sampleTile(ctx, usable[2], x + featuredW + gap, y + halfH + gap, sideW, halfH, 2);
}
function displayPackage(name) {
  if (/^comfyui[-_]vicnodes$/i.test(name)) return 'VicNodes';
  if (/^comfyui[-_]essentials$/i.test(name)) return 'ComfyUI Essentials';
  return name;
}
function pill(ctx, text, x, y, wLimit, fillColor = '#233547') {
  font(ctx, 23, 630);
  const labelText = measure(ctx, text, wLimit - 34);
  const w = Math.min(wLimit, Math.ceil(ctx.measureText(labelText).width + 34));
  fill(ctx, x, y, w, 43, fillColor, 12);
  ctx.fillStyle = '#dae9f8'; ctx.fillText(labelText, x + 17, y + 29);
  return w;
}

export function makeGitHubPreview({ screenshot, title, author, description, githubSummary,
  githubType, githubModel, githubDensity, dependencies = [], samples = [], zoom = 60 }, createCanvas) {
  if (!screenshot) throw new Error('Capture the workflow before creating a GitHub preview.');
  const density = normalizeGitHubDensity(githubDensity);
  const width = GITHUB_PREVIEW_WIDTH;
  const height = GITHUB_PREVIEW_HEIGHTS[density];
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not allocate the GitHub preview canvas.');

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, '#172331'); bg.addColorStop(.55, COLORS.bg);
  bg.addColorStop(1, '#0c1119');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  fill(ctx, 0, 0, 11, height, COLORS.cyan);

  label(ctx, 'COMFYUI  /  WORKFLOW PREVIEW', 74, 60, COLORS.cyan, 21);
  const nodeTotal = dependencies.reduce((n, group) => n + (group.count || 0), 0);
  font(ctx, 22, 550); ctx.fillStyle = COLORS.muted;
  const topRight = `${nodeTotal} NODES   /   ${zoom}% CAPTURE`;
  ctx.fillText(topRight, width - 74 - ctx.measureText(topRight).width, 61);
  fitText(ctx, title || 'Untitled workflow', 74, 146, 1465, 76, 41);
  font(ctx, 24, 500); ctx.fillStyle = COLORS.muted;
  const byline = author ? `BY ${author}` : 'COMFYUI WORKFLOW';
  ctx.fillText(measure(ctx, byline, 640), 76, 192);
  let tagX = 835;
  for (const tag of [githubType && githubType !== 'Workflow' ? githubType : '', githubModel || ''].filter(Boolean)) {
    if (tagX >= width - 200) break;
    tagX += pill(ctx, tag, tagX, 158, Math.min(380, width - tagX - 76), '#1f3442') + 12;
  }
  ctx.strokeStyle = '#334256'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(74, 216); ctx.lineTo(width - 74, 216); ctx.stroke();

  const bodyY = 243, footerY = height - 158, bodyH = footerY - bodyY - 12;
  const leftX = 74, leftW = 1160, rightX = 1254, rightW = 672;
  panel(ctx, leftX, bodyY, leftW, bodyH);
  label(ctx, 'WORKFLOW OVERVIEW', leftX + 25, bodyY + 38, COLORS.cyan, 19);
  const imgX = leftX + 19, imgY = bodyY + 59;
  const imgW = leftW - 38, imgH = bodyH - 79;
  fill(ctx, imgX, imgY, imgW, imgH, '#090e15', 12);
  ctx.save(); path(ctx, imgX, imgY, imgW, imgH, 12); ctx.clip();
  imageFit(ctx, screenshot, imgX + 10, imgY + 10, imgW - 20, imgH - 20);
  ctx.restore();

  panel(ctx, rightX, bodyY, rightW, bodyH);
  label(ctx, 'AT A GLANCE', rightX + 24, bodyY + 38, COLORS.cyan, 19);
  const summary = githubShortSummary(githubSummary, description, dependencies);
  const summaryTop = bodyY + 88;
  const summaryLines = density === 'compact' ? 2 : density === 'balanced' ? 3 : 4;
  const summaryBottom = paragraph(ctx, summary, rightX + 24, summaryTop,
    rightW - 48, summaryLines, 26, 1.35);

  const imageTop = Math.max(bodyY + (density === 'compact' ? 176 : density === 'balanced' ? 216 : 254),
    summaryBottom + 12);
  const imageBottom = bodyY + bodyH - 22;
  const imageHeight = Math.max(65, imageBottom - imageTop);
  if (samples.length) {
    drawSamples(ctx, samples, rightX + 22, imageTop, rightW - 44, imageHeight);
  } else {
    fill(ctx, rightX + 22, imageTop, rightW - 44, imageHeight, '#101b28', 14);
    label(ctx, 'KEY NODES', rightX + 42, imageTop + 37, COLORS.dim, 18);
    const names = githubNodeSummary(dependencies, density === 'compact' ? 3 : 5);
    if (!names.length) names.push('Explore this workflow in ComfyUI');
    const lineHeight = density === 'compact' ? 48 : 58;
    names.forEach((name, i) => {
      if (imageTop + 89 + i * lineHeight >= imageBottom - 12) return;
      font(ctx, 25, 610); ctx.fillStyle = '#cbd9ea';
      ctx.fillText(measure(ctx, `\u2022  ${name}`, rightW - 97), rightX + 41, imageTop + 85 + i * lineHeight);
    });
  }

  const plugins = githubPluginSummary(dependencies, 4);
  label(ctx, 'CUSTOM NODE PACKS', leftX, footerY + 25, COLORS.cyan, 18);
  let px = leftX;
  if (plugins.names.length) {
    const names = [...plugins.names.map(displayPackage)];
    if (plugins.remaining) names.push(`+${plugins.remaining} more`);
    for (const name of names) {
      font(ctx, 23, 630);
      const available = (leftX + leftW) - px;
      if (available < 100) break;
      const actualWidth = Math.min(available, Math.ceil(ctx.measureText(name).width + 34));
      px += pill(ctx, name, px, footerY + 40, actualWidth) + 10;
    }
  } else {
    font(ctx, 23, 480); ctx.fillStyle = COLORS.muted;
    ctx.fillText('No custom node packs identified', px, footerY + 69);
  }

  label(ctx, 'FEATURED NODES', rightX, footerY + 25, COLORS.cyan, 18);
  font(ctx, 23, 550); ctx.fillStyle = '#c7d4e6';
  const nodeLabels = githubNodeSummary(dependencies, 3);
  const featured = nodeLabels.length ? nodeLabels.join('  /  ') : 'ComfyUI workflow';
  ctx.fillText(measure(ctx, featured, rightW), rightX, footerY + 69);
  ctx.strokeStyle = '#29384b'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(74, height - 61); ctx.lineTo(width - 74, height - 61); ctx.stroke();
  font(ctx, 18, 700); ctx.fillStyle = '#71869e';
  ctx.fillText('CREATED WITH COMFYUI WORKFLOW CAPTURE', 74, height - 29);
  font(ctx, 18, 570); ctx.fillStyle = '#6f8299';
  const footer = 'README / GITHUB PREVIEW';
  ctx.fillText(footer, width - 74 - ctx.measureText(footer).width, height - 29);
  return canvas;
}
