// Revvy 共有ページの編集機能。画像の上に SVG を重ねて書き込み、保存するとバージョンが 1 つ増える。
// 元の画像は書き換えない。書き込みは画像のピクセル座標で持つ（表示の拡大率に左右されない）。
// 文字列は必ず textContent / 属性で入れる（HTML として解釈させない）。
(function () {
  "use strict";
  // 編集用リンク（…/<id>#edit=<合言葉>）で開いたときだけ、書き込みを保存できる。# 以降はサーバーにも Referer にも送られない。
  // 合言葉はこのタブの中（sessionStorage）に移して、アドレスバーと履歴からは消す（URL をコピーして渡しても、編集の権限まで渡らないように）。
  // パスワードの入口のページでもここまでは動くので、パスワードを通したあとも編集できる。
  var editToken = "";
  (function () {
    var key = "revvy-edit:" + (location.pathname.split("/")[1] || "");
    var found = location.hash.match(/^#edit=([A-Za-z0-9_-]{43})$/);
    try {
      if (found) {
        sessionStorage.setItem(key, found[1]);
        history.replaceState(null, "", location.pathname + location.search);
      }
      editToken = sessionStorage.getItem(key) || "";
    } catch (e) {
      editToken = found ? found[1] : ""; // sessionStorage が使えないブラウザでは、URL に残したまま使う
    }
  })();

  var img = document.getElementById("shot");
  var holder = document.getElementById("canvas");
  var bar = document.getElementById("tools");
  if (!img || !holder || !bar) return;

  var M = JSON.parse(bar.getAttribute("data-messages"));
  var api = "/api/v1/shots/" + bar.getAttribute("data-id") + "/versions";
  var NS = "http://www.w3.org/2000/svg";
  var FONT = '-apple-system, BlinkMacSystemFont, "Hiragino Sans", "Segoe UI", sans-serif';
  var TEXT_SIZES = { 0: 10, 1: 10, 2: 14, 4: 22 };
  var ZOOMS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
  var MAX_ITEMS = 300, MAX_TEXT = 500, MAX_PEN = 4000;

  var W = 0, H = 0, unit = 1;
  var items = [], selected = -1, tool = "select", color = "#e5484d", weight = 2;
  var undoStack = [], redoStack = [], dirty = false, editing = false;
  var versions = [], current = null;
  var drag = null, svg = null, field = null, toastTimer = 0;
  var hover = -1, halo = null, nodes = [], extents = [], frame = null, sticky = false;
  var zoom = 0, grid = null, cursorAt = null; // zoom は画像 1px あたりの表示 px。0 は「全体を表示」

  var $ = function (id) { return document.getElementById(id); };
  var editButton = $("edit"), versionSelect = $("versions"), zoomBox = $("zoom"), downloadLink = $("download");
  var toast = $("toast"), labelInput = $("vlabel");

  function el(name, attrs) {
    var node = document.createElementNS(NS, name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }
  function isBox(it) { return it.t === "rect" || it.t === "ellipse"; }
  function isSegment(it) { return it.t === "line" || it.t === "arrow" || it.t === "ruler"; }
  function scale() { return svg ? svg.getBoundingClientRect().width / W || 1 : 1; }
  function textSize() { return TEXT_SIZES[weight] * unit; }
  // 太さ 0 は、画像のちょうど 1px（1px のズレを見るとき、線で隠さない）
  function strokeWidth() { return weight ? weight * unit : 1; }

  // MARK: 形の計算（SVG とダウンロード用の canvas で同じものを使う）

  function arrowGeometry(it) {
    var dx = it.x2 - it.x1, dy = it.y2 - it.y1, len = Math.hypot(dx, dy) || 1;
    var ux = dx / len, uy = dy / len, head = Math.min(Math.max(it.width * 4, 8), len);
    var bx = it.x2 - ux * head, by = it.y2 - uy * head, half = head * 0.45;
    return {
      end: { x: it.x2 - ux * head * 0.7, y: it.y2 - uy * head * 0.7 },
      head: [[it.x2, it.y2], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]]
    };
  }
  // onScreen のときは、拡大してもラベルが画面を覆わない大きさに抑える（ダウンロードする画像では元の大きさ）
  function rulerGeometry(it, onScreen) {
    var dx = it.x2 - it.x1, dy = it.y2 - it.y1, len = Math.hypot(dx, dy);
    var ux = len ? dx / len : 1, uy = len ? dy / len : 0, tick = it.width < unit ? 3 : Math.max(it.width * 3, 4 * unit);
    var size = onScreen ? Math.min(9 * unit, 28 / scale()) : 9 * unit, nx = -uy, ny = ux;
    // ラベルは線の上（縦の線なら右）に置く
    if (ny > 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; }
    var gap = size * 1.1 + it.width;
    return {
      ticks: [[it.x1 - uy * tick, it.y1 + ux * tick, it.x1 + uy * tick, it.y1 - ux * tick],
              [it.x2 - uy * tick, it.y2 + ux * tick, it.x2 + uy * tick, it.y2 - ux * tick]],
      label: Math.round(len) + " px", size: size,
      cx: (it.x1 + it.x2) / 2 + nx * gap, cy: (it.y1 + it.y2) / 2 + ny * gap
    };
  }
  function outlineFor(hex) {
    var n = parseInt(hex.slice(1), 16);
    var lum = (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
    return lum > 0.6 ? "#111111" : "#ffffff";
  }
  function bounds(it, node) {
    if (it.t === "pen") {
      var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (var i = 0; i < it.points.length; i += 2) {
        x1 = Math.min(x1, it.points[i]); x2 = Math.max(x2, it.points[i]);
        y1 = Math.min(y1, it.points[i + 1]); y2 = Math.max(y2, it.points[i + 1]);
      }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    if (it.t === "text") {
      var box = node.getBBox();
      return { x: box.x, y: box.y, w: box.width, h: box.height };
    }
    return { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1) };
  }

  // MARK: SVG に描く

  function drawItem(it, index) {
    var g = el("g", { "data-i": index });
    var stroke = { fill: "none", stroke: it.color, "stroke-width": it.width, "stroke-linecap": "round", "stroke-linejoin": "round" };
    var main = null;
    function add(name, attrs) {
      var node = el(name, attrs);
      for (var key in stroke) if (!(key in attrs)) node.setAttribute(key, stroke[key]);
      g.appendChild(node);
      return node;
    }
    if (it.t === "rect") {
      main = add("rect", { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), width: Math.abs(it.x2 - it.x1), height: Math.abs(it.y2 - it.y1) });
    } else if (it.t === "ellipse") {
      main = add("ellipse", { cx: (it.x1 + it.x2) / 2, cy: (it.y1 + it.y2) / 2, rx: Math.abs(it.x2 - it.x1) / 2, ry: Math.abs(it.y2 - it.y1) / 2 });
    } else if (it.t === "line") {
      main = add("line", { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2 });
    } else if (it.t === "arrow") {
      var a = arrowGeometry(it);
      add("line", { x1: it.x1, y1: it.y1, x2: a.end.x, y2: a.end.y, "stroke-linecap": "butt" });
      add("polygon", { points: a.head.map(function (p) { return p.join(","); }).join(" "), fill: it.color, stroke: "none" });
    } else if (it.t === "ruler") {
      var r = rulerGeometry(it, true);
      add("line", { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, "stroke-linecap": "butt" });
      r.ticks.forEach(function (t) { add("line", { x1: t[0], y1: t[1], x2: t[2], y2: t[3], "stroke-linecap": "butt" }); });
      var label = el("text", { x: r.cx, y: r.cy, "text-anchor": "middle", "dominant-baseline": "central", "font-size": r.size,
        "font-family": FONT, "font-weight": 600, fill: outlineFor(it.color) });
      label.textContent = r.label;
      g.appendChild(label);
      svg.appendChild(g);
      var lb = label.getBBox(), pad = r.size * 0.35;
      g.insertBefore(el("rect", { x: lb.x - pad, y: lb.y - pad * 0.5, width: lb.width + pad * 2, height: lb.height + pad, rx: r.size * 0.3, fill: it.color }), label);
      extents[index] = { x: lb.x - pad, y: lb.y - pad * 0.5, w: lb.width + pad * 2, h: lb.height + pad };
    } else if (it.t === "pen") {
      var pts = [];
      for (var i = 0; i < it.points.length; i += 2) pts.push(it.points[i] + "," + it.points[i + 1]);
      main = add("polyline", { points: pts.join(" ") });
    } else if (it.t === "text") {
      var text = el("text", { x: it.x, y: it.y, "font-size": it.size, "font-family": FONT, "font-weight": 600, fill: it.color,
        stroke: outlineFor(it.color), "stroke-width": it.size / 7, "stroke-linejoin": "round", "paint-order": "stroke" });
      it.text.split("\n").forEach(function (line, n) {
        var span = el("tspan", { x: it.x, y: it.y + it.size * 0.85 + n * it.size * 1.3 });
        span.textContent = line || " ";
        text.appendChild(span);
      });
      g.appendChild(text);
      svg.appendChild(g);
      var tb = text.getBBox();
      extents[index] = { x: tb.x, y: tb.y, w: tb.width, h: tb.height };
      g.textNode = text;
    }
    if (!g.parentNode) svg.appendChild(g);
    return g;
  }

  function handlesFor(it) {
    if (isSegment(it)) return [["a", it.x1, it.y1], ["b", it.x2, it.y2]];
    if (isBox(it)) return [["11", it.x1, it.y1], ["21", it.x2, it.y1], ["12", it.x1, it.y2], ["22", it.x2, it.y2]];
    return [];
  }

  function render() {
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    halo = null; frame = null; extents = [];
    if (hover >= items.length) hover = -1;
    nodes = items.map(function (it, i) { return field && field.index === i ? null : drawItem(it, i); });
    if (editing && selected >= 0 && items[selected] && nodes[selected]) {
      var it = items[selected], s = scale(), b = bounds(it, nodes[selected].textNode), pad = 6 / s;
      frame = { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
      svg.appendChild(el("rect", { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, fill: "none", stroke: "#ffffff",
        "stroke-width": 3, "vector-effect": "non-scaling-stroke", "pointer-events": "none", opacity: 0.9 }));
      svg.appendChild(el("rect", { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, fill: "none", stroke: "#0b7d5f",
        "stroke-width": 1.5, "stroke-dasharray": "5 4", "vector-effect": "non-scaling-stroke", "pointer-events": "none" }));
      if (s >= 2 && (isBox(it) || isSegment(it))) {
        // 拡大中は、線の太さに隠れた本当の位置（ピクセルの境目）を細線で見せる
        [["#ffffff", ""], ["#111111", "3 3"]].forEach(function (style) {
          var exact = outlineNode(it, selected);
          var attrs = { fill: "none", stroke: style[0], "stroke-width": 1, "vector-effect": "non-scaling-stroke", "pointer-events": "none" };
          if (style[1]) attrs["stroke-dasharray"] = style[1];
          for (var key in attrs) exact.setAttribute(key, attrs[key]);
          svg.appendChild(exact);
        });
      }
      var note = measure(it);
      if (note) {
        var size = 11 / s, badge = el("text", { x: b.x + b.w / 2, y: frame.y + frame.h + size * 1.5, "text-anchor": "middle", "dominant-baseline": "central",
          "font-size": size, "font-family": FONT, "font-weight": 600, fill: "#ffffff", "pointer-events": "none" });
        badge.textContent = note;
        svg.appendChild(badge);
        var nb = badge.getBBox(), np = size * 0.45;
        svg.insertBefore(el("rect", { x: nb.x - np, y: nb.y - np * 0.4, width: nb.width + np * 2, height: nb.height + np * 0.8, rx: size * 0.35,
          fill: "#0b7d5f", "pointer-events": "none" }), badge);
      }
      handlesFor(it).forEach(function (h) {
        svg.appendChild(el("circle", { cx: h[1], cy: h[2], r: 6 / s, fill: "#ffffff", stroke: "#0b7d5f", "stroke-width": 2,
          "vector-effect": "non-scaling-stroke", "data-h": h[0], "class": "handle" }));
      });
    }
    showHalo();
    updateReadout();
    updateControls();
  }

  // MARK: 寸法と拡大

  function measure(it) {
    if (isBox(it)) return Math.abs(it.x2 - it.x1) + " × " + Math.abs(it.y2 - it.y1) + " px";
    if (!isSegment(it)) return "";
    var dx = Math.abs(it.x2 - it.x1), dy = Math.abs(it.y2 - it.y1);
    if (!dx || !dy) return (dx || dy) + " px";
    return Math.round(Math.hypot(dx, dy)) + " px (Δx " + dx + ", Δy " + dy + ")";
  }
  function updateReadout() {
    var out = $("readout"), parts = [];
    if (!out) return;
    if (cursorAt) parts.push("x " + cursorAt.x + ", y " + cursorAt.y);
    var it = editing && selected >= 0 ? items[selected] : null;
    if (it && (isBox(it) || isSegment(it))) {
      parts.push((isBox(it) ? Math.min(it.x1, it.x2) + ", " + Math.min(it.y1, it.y2) : it.x1 + ", " + it.y1 + " → " + it.x2 + ", " + it.y2) + " · " + measure(it));
    }
    out.textContent = editing ? parts.join("  |  ") : "";
  }
  function stage() { return holder.parentNode; }
  // around（画面上の点）の下にある画像の位置を保ったまま、倍率を変える
  function setZoom(next, around) {
    var before = img.getBoundingClientRect(), box = stage().getBoundingClientRect();
    var cx = around ? around.x : box.left + box.width / 2, cy = around ? around.y : box.top + box.height / 2;
    var fx = (cx - before.left) / before.width, fy = (cy - before.top) / before.height;
    zoom = next;
    img.style.width = zoom ? W * zoom + "px" : "";
    document.body.classList.toggle("zoomed", zoom > 0);
    if (zoom) {
      var after = img.getBoundingClientRect();
      stage().scrollLeft += after.left + fx * after.width - cx;
      stage().scrollTop += after.top + fy * after.height - cy;
    }
    render();
  }
  function stepZoom(direction, around) {
    var now = scale(), next = 0, i;
    if (direction > 0) { for (i = 0; i < ZOOMS.length; i += 1) if (ZOOMS[i] > now * 1.05) { next = ZOOMS[i]; break; } }
    else { for (i = ZOOMS.length - 1; i >= 0; i -= 1) if (ZOOMS[i] < now / 1.05) { next = ZOOMS[i]; break; } }
    if (next) setZoom(next, around);
  }
  function updateZoomUI() {
    var s = scale(), level = $("zoomlevel");
    if (level) level.textContent = (s >= 1 ? Math.round(s * 100) : Math.round(s * 1000) / 10) + "%";
    document.body.classList.toggle("crisp", editing && s >= 2);
    var want = editing && s >= 8;
    if (want && !grid) { grid = document.createElement("div"); grid.className = "pixels"; holder.insertBefore(grid, svg); }
    if (grid) { grid.hidden = !want; grid.style.backgroundSize = s + "px " + s + "px"; }
  }

  // MARK: 近くにあるものを拾う（PowerPoint のように、線の近くに寄るだけでつかめる）

  function rawPoint(event) {
    var rect = svg.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width * W, y: (event.clientY - rect.top) / rect.height * H };
  }
  function reach(event) { return (event.pointerType === "touch" ? 18 : 9) / scale(); }
  function segmentDistance(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
    var t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
    return Math.hypot(px - x1 - dx * t, py - y1 - dy * t);
  }
  function boxDistance(px, py, b) {
    return Math.hypot(Math.max(b.x - px, 0, px - b.x - b.w), Math.max(b.y - py, 0, py - b.y - b.h));
  }
  function distanceTo(it, index, p) {
    var d = Infinity, i;
    if (it.t === "text") return extents[index] ? boxDistance(p.x, p.y, extents[index]) : Infinity;
    if (it.t === "rect") {
      // 塗りのない四角と丸は、枠線の近くだけで拾う（中をクリックしても、下の絵に書き込める）
      d = Math.min(segmentDistance(p.x, p.y, it.x1, it.y1, it.x2, it.y1), segmentDistance(p.x, p.y, it.x2, it.y1, it.x2, it.y2),
        segmentDistance(p.x, p.y, it.x2, it.y2, it.x1, it.y2), segmentDistance(p.x, p.y, it.x1, it.y2, it.x1, it.y1));
    } else if (it.t === "ellipse") {
      var rx = Math.abs(it.x2 - it.x1) / 2, ry = Math.abs(it.y2 - it.y1) / 2, cx = (it.x1 + it.x2) / 2, cy = (it.y1 + it.y2) / 2;
      if (rx < 0.5 || ry < 0.5) d = segmentDistance(p.x, p.y, it.x1, it.y1, it.x2, it.y2);
      else {
        var ex = p.x - cx, ey = p.y - cy, k = Math.hypot(ex / rx, ey / ry);
        d = k ? Math.hypot(ex, ey) * Math.abs(1 - 1 / k) : Math.min(rx, ry);
      }
    } else if (it.t === "pen") {
      d = Math.hypot(p.x - it.points[0], p.y - it.points[1]);
      for (i = 2; i < it.points.length; i += 2) d = Math.min(d, segmentDistance(p.x, p.y, it.points[i - 2], it.points[i - 1], it.points[i], it.points[i + 1]));
    } else {
      d = segmentDistance(p.x, p.y, it.x1, it.y1, it.x2, it.y2);
      if (extents[index]) d = Math.min(d, boxDistance(p.x, p.y, extents[index]));
    }
    return Math.max(0, d - it.width / 2);
  }
  // いちばん近いもの。同じ近さなら上に重なっているほう
  function hitTest(p, tol) {
    var best = -1, bestDistance = Infinity;
    for (var i = items.length - 1; i >= 0; i -= 1) {
      if (field && field.index === i) continue;
      var d = distanceTo(items[i], i, p);
      if (d <= tol && d < bestDistance - 0.01) { best = i; bestDistance = d; }
    }
    return best;
  }
  function handleAt(p, tol) {
    if (!editing || selected < 0 || !items[selected]) return null;
    var best = null, bestDistance = tol;
    handlesFor(items[selected]).forEach(function (h) {
      var d = Math.hypot(p.x - h[1], p.y - h[2]);
      if (d <= bestDistance) { best = h; bestDistance = d; }
    });
    return best;
  }
  function inFrame(p) { return frame !== null && selected >= 0 && boxDistance(p.x, p.y, frame) === 0; }
  // 選んでいるもののハンドル → 近くのもの → 選択枠の中、の順に拾う
  function pick(event) {
    var p = rawPoint(event), tol = reach(event), handle = handleAt(p, tol);
    if (handle) return { handle: handle, index: selected };
    var index = hitTest(p, tol);
    if (index < 0 && tool === "select" && inFrame(p)) index = selected;
    return { handle: null, index: index };
  }
  function outlineNode(it, index) {
    var b = extents[index];
    if (it.t === "text") return b ? el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 3 / scale() }) : null;
    if (it.t === "rect") return el("rect", { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), width: Math.abs(it.x2 - it.x1), height: Math.abs(it.y2 - it.y1) });
    if (it.t === "ellipse") return el("ellipse", { cx: (it.x1 + it.x2) / 2, cy: (it.y1 + it.y2) / 2, rx: Math.abs(it.x2 - it.x1) / 2, ry: Math.abs(it.y2 - it.y1) / 2 });
    if (it.t === "pen") {
      var pts = [];
      for (var i = 0; i < it.points.length; i += 2) pts.push(it.points[i] + "," + it.points[i + 1]);
      return el("polyline", { points: pts.join(" ") });
    }
    return el("line", { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2 });
  }
  // カーソルが近づいたものを、ふちどりで知らせる
  function showHalo() {
    if (halo) { halo.remove(); halo = null; }
    if (!editing || drag || hover < 0 || hover === selected || !items[hover] || !nodes[hover]) return;
    var it = items[hover], node = outlineNode(it, hover);
    if (!node) return;
    var attrs = { fill: "none", stroke: "#0b7d5f", "stroke-opacity": 0.5, "stroke-width": (it.t === "text" ? 0 : it.width) + 8 / scale(),
      "stroke-linecap": "round", "stroke-linejoin": "round", "pointer-events": "none" };
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    halo = node;
    svg.insertBefore(halo, nodes[hover]);
  }
  function handleCursor(it, h) {
    if (!isBox(it)) return "pointer";
    return (h[1] < (it.x1 + it.x2) / 2) === (h[2] < (it.y1 + it.y2) / 2) ? "nwse-resize" : "nesw-resize";
  }
  function onHover(event) {
    if (!editing || drag || field || event.pointerType === "touch") return;
    var found = pick(event), next = found.handle ? -1 : found.index, cursor = "";
    if (found.handle) cursor = handleCursor(items[selected], found.handle);
    else if (next >= 0) cursor = tool === "select" ? "move" : tool === "text" ? "pointer" : "";
    svg.style.cursor = cursor;
    if (next !== hover) { hover = next; showHalo(); }
  }
  function clearHover() {
    cursorAt = null; updateReadout();
    if (svg) svg.style.cursor = "";
    if (hover >= 0) { hover = -1; showHalo(); }
  }

  // MARK: ダウンロード用に canvas へ描く

  function paint(ctx, it) {
    ctx.strokeStyle = it.color; ctx.fillStyle = it.color; ctx.lineWidth = it.width; ctx.lineCap = "round"; ctx.lineJoin = "round";
    function segment(x1, y1, x2, y2, cap) { ctx.lineCap = cap || "round"; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
    if (it.t === "rect") {
      ctx.strokeRect(Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1));
    } else if (it.t === "ellipse") {
      ctx.beginPath();
      ctx.ellipse((it.x1 + it.x2) / 2, (it.y1 + it.y2) / 2, Math.abs(it.x2 - it.x1) / 2, Math.abs(it.y2 - it.y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (it.t === "line") {
      segment(it.x1, it.y1, it.x2, it.y2);
    } else if (it.t === "arrow") {
      var a = arrowGeometry(it);
      segment(it.x1, it.y1, a.end.x, a.end.y, "butt");
      ctx.beginPath(); ctx.moveTo(a.head[0][0], a.head[0][1]); ctx.lineTo(a.head[1][0], a.head[1][1]); ctx.lineTo(a.head[2][0], a.head[2][1]); ctx.closePath(); ctx.fill();
    } else if (it.t === "ruler") {
      var r = rulerGeometry(it);
      segment(it.x1, it.y1, it.x2, it.y2, "butt");
      r.ticks.forEach(function (t) { segment(t[0], t[1], t[2], t[3], "butt"); });
      ctx.font = "600 " + r.size + "px " + FONT; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      var w = ctx.measureText(r.label).width, pad = r.size * 0.35, h = r.size * 1.2 + pad;
      ctx.beginPath(); ctx.roundRect(r.cx - w / 2 - pad, r.cy - h / 2, w + pad * 2, h, r.size * 0.3); ctx.fill();
      ctx.fillStyle = outlineFor(it.color); ctx.fillText(r.label, r.cx, r.cy);
    } else if (it.t === "pen") {
      ctx.beginPath(); ctx.moveTo(it.points[0], it.points[1]);
      for (var i = 2; i < it.points.length; i += 2) ctx.lineTo(it.points[i], it.points[i + 1]);
      ctx.stroke();
    } else if (it.t === "text") {
      ctx.font = "600 " + it.size + "px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.strokeStyle = outlineFor(it.color); ctx.lineWidth = it.size / 7;
      it.text.split("\n").forEach(function (line, n) {
        var y = it.y + it.size * 0.85 + n * it.size * 1.3;
        ctx.strokeText(line, it.x, y); ctx.fillText(line, it.x, y);
      });
    }
  }

  function download(event) {
    if (!items.length || !W) return; // 書き込みがなければ、元の画像をそのまま落とす
    event.preventDefault();
    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    items.forEach(function (it) { paint(ctx, it); });
    canvas.toBlob(function (blob) {
      if (!blob) return;
      var link = document.createElement("a"), url = URL.createObjectURL(blob);
      var number = versionNumber(current);
      link.href = url;
      link.download = (downloadLink.getAttribute("download") || "revvy").replace(/\.[a-z]+$/, "") + (number ? "-v" + number : "-edited") + ".png";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    }, "image/png");
  }

  // MARK: 操作

  function point(event) {
    var rect = svg.getBoundingClientRect();
    return { x: Math.round((event.clientX - rect.left) / rect.width * W), y: Math.round((event.clientY - rect.top) / rect.height * H) };
  }
  function snapshot() {
    undoStack.push(JSON.stringify(items));
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    dirty = true;
  }
  function constrain(it, start, p, shift) {
    if (!shift) return p;
    var dx = p.x - start.x, dy = p.y - start.y;
    if (isBox(it)) {
      var side = Math.max(Math.abs(dx), Math.abs(dy));
      return { x: start.x + (dx < 0 ? -side : side), y: start.y + (dy < 0 ? -side : side) };
    }
    return Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: start.y } : { x: start.x, y: p.y };
  }
  function translate(it, dx, dy) {
    if (it.t === "text") { it.x += dx; it.y += dy; }
    else if (it.t === "pen") { for (var i = 0; i < it.points.length; i += 2) { it.points[i] += dx; it.points[i + 1] += dy; } }
    else { it.x1 += dx; it.y1 += dy; it.x2 += dx; it.y2 += dy; }
  }

  function onDown(event) {
    if (!editing || event.button > 0) return;
    commitField();
    var p = point(event), found = pick(event), origin = { x: event.clientX, y: event.clientY };
    hover = -1;
    if (found.handle) {
      drag = { mode: "handle", handle: found.handle[0], origin: origin };
    } else if (tool === "select" || (tool === "text" && found.index >= 0)) {
      // 文字ツールでも、すでにあるものの近くを押したときは、新しく置かずにそれを選ぶ
      if (tool !== "select") { tool = "select"; sticky = false; }
      selected = found.index;
      drag = selected >= 0 ? { mode: "move", last: p, origin: origin } : null;
    } else if (tool === "text") {
      event.preventDefault();
      openField(p, -1);
      return;
    } else if (items.length < MAX_ITEMS) {
      snapshot();
      items.push(tool === "pen"
        ? { t: "pen", points: [p.x, p.y], color: color, width: strokeWidth() }
        : { t: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color: color, width: strokeWidth() });
      selected = items.length - 1;
      drag = { mode: "create", start: p, snapped: true, near: found.index };
    } else {
      say(M.tooMany);
    }
    if (drag) { try { svg.setPointerCapture(event.pointerId); } catch (e) { /* 合成したイベントでは使えない */ } }
    event.preventDefault();
    render();
  }

  function onMove(event) {
    if (editing) { var at = rawPoint(event); cursorAt = { x: Math.floor(at.x), y: Math.floor(at.y) }; }
    if (!drag || selected < 0) { onHover(event); updateReadout(); return; }
    var it = items[selected], p = point(event);
    if (!drag.snapped) {
      // クリックしただけで少しずれるのを防ぐ
      if (Math.hypot(event.clientX - drag.origin.x, event.clientY - drag.origin.y) < 3) return;
      snapshot(); drag.snapped = true;
    }
    if (drag.mode === "create") {
      if (it.t === "pen") {
        var n = it.points.length;
        if (n < MAX_PEN && Math.hypot(p.x - it.points[n - 2], p.y - it.points[n - 1]) >= 2 / scale()) it.points.push(p.x, p.y);
      } else {
        var q = constrain(it, drag.start, p, event.shiftKey);
        it.x2 = q.x; it.y2 = q.y;
      }
    } else if (drag.mode === "handle") {
      if (isSegment(it)) {
        var other = drag.handle === "a" ? { x: it.x2, y: it.y2 } : { x: it.x1, y: it.y1 };
        var c = constrain(it, other, p, event.shiftKey);
        if (drag.handle === "a") { it.x1 = c.x; it.y1 = c.y; } else { it.x2 = c.x; it.y2 = c.y; }
      } else if (isBox(it)) {
        it[drag.handle[0] === "1" ? "x1" : "x2"] = p.x;
        it[drag.handle[1] === "1" ? "y1" : "y2"] = p.y;
      }
    } else {
      translate(it, p.x - drag.last.x, p.y - drag.last.y);
      drag.last = p;
    }
    render();
  }

  function onUp(event) {
    if (!drag) return;
    var made = false;
    if (drag.mode === "create" && selected >= 0) {
      made = true;
      var it = items[selected];
      // ルーラーは 1px から測れる。ほかは、クリックしただけの小さな図形を残さない
      var size = it.t === "pen" ? it.points.length / 2 : Math.hypot(it.x2 - it.x1, it.y2 - it.y1);
      var least = it.t === "pen" ? 2 : it.t === "ruler" ? 1 : 3 / scale();
      if (size < least) {
        items.pop(); undoStack.pop(); selected = -1; dirty = undoStack.length > 0; made = false;
        // 描かずにクリックしただけなら、近くにあったものを選ぶ
        if (drag.near >= 0 && drag.near < items.length) { selected = drag.near; tool = "select"; sticky = false; }
      }
      // 描き終えたら選択に戻り、いま描いたものをそのまま動かせる。ペンと、固定したツールは続けて描ける
      if (made && it.t !== "pen" && !sticky) tool = "select";
    }
    drag = null;
    render();
    if (event && event.type === "pointerup") onHover(event);
  }

  function openField(p, index) {
    var it = index >= 0 ? items[index] : null;
    var size = it ? it.size : textSize(), s = scale();
    var area = document.createElement("textarea");
    area.className = "field";
    area.rows = 1;
    area.maxLength = MAX_TEXT;
    area.value = it ? it.text : "";
    area.setAttribute("aria-label", M.text);
    area.style.left = (p.x / W * 100) + "%";
    area.style.top = (p.y / H * 100) + "%";
    area.style.fontSize = Math.max(size * s, 11) + "px";
    area.style.color = it ? it.color : color;
    area.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); commitField(); }
      else if (event.key === "Escape") { event.preventDefault(); field.cancelled = true; commitField(); }
      event.stopPropagation();
    });
    area.addEventListener("input", function () { area.style.height = "auto"; area.style.height = area.scrollHeight + "px"; });
    area.addEventListener("blur", function () { commitField(); });
    field = { node: area, index: index, x: p.x, y: p.y, size: size, cancelled: false };
    holder.appendChild(area);
    render();
    area.focus();
  }

  function commitField() {
    if (!field) return;
    var f = field, value = f.node.value.replace(/\s+$/, "").slice(0, MAX_TEXT);
    field = null;
    f.node.remove();
    if (!f.cancelled) {
      if (f.index < 0 && value && items.length < MAX_ITEMS) {
        snapshot();
        items.push({ t: "text", x: f.x, y: f.y, text: value, size: f.size, color: color });
        selected = items.length - 1;
        if (!sticky) tool = "select";
      } else if (f.index >= 0 && value !== items[f.index].text) {
        snapshot();
        if (value) items[f.index].text = value; else { items.splice(f.index, 1); selected = -1; }
      }
    }
    render();
  }

  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(items));
    items = JSON.parse(from.pop());
    selected = -1;
    dirty = true;
    render();
  }
  function removeSelected() {
    if (selected < 0) return;
    snapshot();
    items.splice(selected, 1);
    selected = -1;
    render();
  }
  function setTool(name, lock) {
    commitField();
    // ダブルクリック（または同じキーをもう一度）で固定すると、続けて描ける
    sticky = Boolean(lock) && name !== "select";
    tool = name;
    if (name !== "select") selected = -1;
    render();
  }
  function applyStyle() {
    // 色や太さの変更を選んだものに効かせるのは、選択ツールのときだけ（描いた直後の図形を、次の色で塗り替えない）
    var it = tool === "select" ? items[selected] : null;
    if (!it) return;
    snapshot();
    it.color = color;
    if (it.t === "text") it.size = textSize(); else it.width = strokeWidth();
  }

  function onKey(event) {
    if (!editing) return;
    var tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    var mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
    if (mod && key === "z") { event.preventDefault(); if (event.shiftKey) restore(redoStack, undoStack); else restore(undoStack, redoStack); return; }
    if (mod && key === "y") { event.preventDefault(); restore(redoStack, undoStack); return; }
    if (!mod && !event.altKey && (key === "+" || key === "=" || key === ";")) { event.preventDefault(); stepZoom(1); return; }
    if (!mod && !event.altKey && key === "-") { event.preventDefault(); stepZoom(-1); return; }
    if (!mod && !event.altKey && key === "0") { event.preventDefault(); setZoom(0); return; }
    if (mod) return;
    if (event.altKey && (key.indexOf("arrow") !== 0 || selected < 0)) return;
    if (key === "delete" || key === "backspace") { event.preventDefault(); removeSelected(); return; }
    if (key === "escape") { if (selected >= 0) { selected = -1; render(); } else setTool("select"); return; }
    if (key.indexOf("arrow") === 0 && selected >= 0) {
      event.preventDefault();
      var step = event.shiftKey ? 10 : 1;
      snapshot();
      var mx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0, my = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
      var target = items[selected];
      if (!event.altKey) translate(target, mx, my);
      else if (isSegment(target)) { target.x2 += mx; target.y2 += my; }
      else if (isBox(target)) {
        // 右と下の辺を動かす（左上は動かさない）
        target[target.x2 >= target.x1 ? "x2" : "x1"] += mx;
        target[target.y2 >= target.y1 ? "y2" : "y1"] += my;
      }
      render();
      return;
    }
    var shortcut = { v: "select", t: "text", r: "rect", o: "ellipse", l: "line", a: "arrow", m: "ruler", p: "pen" }[key];
    if (shortcut) { event.preventDefault(); setTool(shortcut, shortcut === tool && !sticky); }
  }

  function updateControls() {
    var each = function (selector, fn) { Array.prototype.forEach.call(bar.querySelectorAll(selector), fn); };
    each("[data-tool]", function (b) {
      var on = b.getAttribute("data-tool") === tool;
      b.setAttribute("aria-pressed", String(on));
      if (on && sticky) b.setAttribute("data-locked", ""); else b.removeAttribute("data-locked");
    });
    each("[data-color]", function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-color") === color)); });
    each("[data-weight]", function (b) { b.setAttribute("aria-pressed", String(Number(b.getAttribute("data-weight")) === weight)); });
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
    $("del").disabled = selected < 0;
    $("save").disabled = !dirty;
    svg.setAttribute("class", "ink" + (editing ? " on tool-" + tool : ""));
    updateZoomUI();
  }

  function say(message, withCopy) {
    clearTimeout(toastTimer);
    while (toast.firstChild) toast.removeChild(toast.firstChild);
    toast.appendChild(document.createTextNode(message));
    if (withCopy && navigator.clipboard) {
      var copy = document.createElement("button");
      copy.type = "button"; copy.className = "btn"; copy.textContent = M.copy;
      copy.addEventListener("click", function () {
        // コピーするのは見るだけのリンク（編集用の合言葉は付けない）
        navigator.clipboard.writeText(location.href.split("#")[0]).then(function () { copy.textContent = M.copied; });
      });
      toast.appendChild(copy);
    }
    toast.hidden = false;
    toastTimer = setTimeout(function () { toast.hidden = true; }, withCopy ? 15000 : 6000);
  }

  // MARK: バージョン

  function versionNumber(id) {
    for (var i = 0; i < versions.length; i += 1) if (versions[i].v === id) return i + 1;
    return 0;
  }
  function fillVersions() {
    while (versionSelect.firstChild) versionSelect.removeChild(versionSelect.firstChild);
    for (var i = versions.length - 1; i >= 0; i -= 1) {
      var v = versions[i], option = document.createElement("option");
      var when = new Date(v.createdAt).toLocaleString(document.documentElement.lang, { dateStyle: "short", timeStyle: "short" });
      option.value = v.v;
      option.textContent = "v" + (i + 1) + " · " + when + (v.label ? " · " + v.label : "");
      versionSelect.appendChild(option);
    }
    var original = document.createElement("option");
    original.value = ""; original.textContent = M.original;
    versionSelect.appendChild(original);
    versionSelect.value = current || "";
    versionSelect.hidden = versions.length === 0;
  }
  function show(id, list) {
    items = list; selected = -1; undoStack = []; redoStack = []; dirty = false; current = id;
    fillVersions();
    render();
  }
  function load(id, updateURL) {
    var done = function (list) {
      show(id, list);
      if (updateURL) history.replaceState(null, "", "?v=" + encodeURIComponent(id || "original") + location.hash);
    };
    if (!id) { done([]); return Promise.resolve(); }
    return fetch(api + "/" + encodeURIComponent(id)).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then(function (body) { done(Array.isArray(body.items) ? body.items : []); }).catch(function () { say(M.loadFailed); });
  }
  function save() {
    commitField();
    if (!dirty) return;
    $("save").disabled = true;
    fetch(api, { method: "POST", headers: { "Content-Type": "application/json", "X-Edit-Token": editToken },
      body: JSON.stringify({ width: W, height: H, items: items, label: labelInput.value }) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; }); })
      .then(function (result) {
        if (result.status !== 201) { say(M.errors[result.status] || M.saveFailed); updateControls(); return; }
        versions.push(result.body);
        current = result.body.v; dirty = false; undoStack = []; redoStack = []; labelInput.value = "";
        history.replaceState(null, "", "?v=" + encodeURIComponent(current) + location.hash);
        fillVersions();
        render();
        say(M.saved.replace("{n}", String(versions.length)), true);
      }).catch(function () { say(M.saveFailed); updateControls(); });
  }

  function setEditing(on) {
    commitField();
    editing = on;
    selected = -1; hover = -1; sticky = false;
    if (on) tool = "select";
    if (!on && zoom) { zoom = 0; img.style.width = ""; document.body.classList.remove("zoomed"); }
    if (on && zoomBox.checked) zoomBox.checked = false;
    bar.hidden = !on;
    editButton.hidden = on || !editToken;
    document.body.classList.toggle("editing", on);
    render();
  }

  function start() {
    if (svg || !img.naturalWidth) return;
    W = img.naturalWidth; H = img.naturalHeight;
    unit = Math.max(1, Math.round(Math.max(W, H) / 600));
    svg = el("svg", { viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none", "class": "ink" });
    holder.appendChild(svg);
    svg.addEventListener("pointerdown", onDown);
    svg.addEventListener("pointermove", onMove);
    svg.addEventListener("pointerup", onUp);
    svg.addEventListener("pointercancel", onUp);
    svg.addEventListener("pointerleave", clearHover);
    svg.addEventListener("dblclick", function (event) {
      if (!editing) return;
      var index = hitTest(rawPoint(event), reach(event));
      if (index >= 0 && items[index].t === "text") { selected = index; openField({ x: items[index].x, y: items[index].y }, index); }
    });
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", render);
    window.addEventListener("beforeunload", function (event) { if (dirty) { event.preventDefault(); event.returnValue = ""; } });

    Array.prototype.forEach.call(bar.querySelectorAll("[data-tool]"), function (b) {
      b.addEventListener("click", function () { setTool(b.getAttribute("data-tool")); });
      b.addEventListener("dblclick", function () { setTool(b.getAttribute("data-tool"), true); });
    });
    Array.prototype.forEach.call(bar.querySelectorAll("[data-color]"), function (b) {
      b.addEventListener("click", function () { color = b.getAttribute("data-color"); applyStyle(); render(); });
    });
    Array.prototype.forEach.call(bar.querySelectorAll("[data-weight]"), function (b) {
      b.addEventListener("click", function () { weight = Number(b.getAttribute("data-weight")); applyStyle(); render(); });
    });
    $("undo").addEventListener("click", function () { restore(undoStack, redoStack); });
    $("redo").addEventListener("click", function () { restore(redoStack, undoStack); });
    $("del").addEventListener("click", removeSelected);
    $("save").addEventListener("click", save);
    $("done").addEventListener("click", function () { setEditing(false); });
    $("zoomin").addEventListener("click", function () { stepZoom(1); });
    $("zoomout").addEventListener("click", function () { stepZoom(-1); });
    $("zoomlevel").addEventListener("click", function () { setZoom(0); });
    // Ctrl／⌘＋ホイール（トラックパッドのピンチ）で、カーソルの位置を中心に拡大する
    var wheelSum = 0;
    stage().addEventListener("wheel", function (event) {
      if (!editing || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      wheelSum += event.deltaY;
      if (Math.abs(wheelSum) < 30) return;
      stepZoom(wheelSum < 0 ? 1 : -1, { x: event.clientX, y: event.clientY });
      wheelSum = 0;
    }, { passive: false });
    zoomBox.addEventListener("change", function () { requestAnimationFrame(render); });
    editButton.addEventListener("click", function () { setEditing(true); });
    downloadLink.addEventListener("click", download);
    versionSelect.addEventListener("change", function () {
      if (dirty && !window.confirm(M.discard)) { versionSelect.value = current || ""; return; }
      load(versionSelect.value || null, true);
    });
    editButton.hidden = !editToken;

    fetch(api).then(function (res) { return res.ok ? res.json() : { versions: [] }; }).then(function (body) {
      versions = Array.isArray(body.versions) ? body.versions : [];
      var wanted = new URLSearchParams(location.search).get("v");
      var known = versions.some(function (v) { return v.v === wanted; });
      // 指定がなければ最新のバージョンを開く。?v=original は元の画像
      var id = wanted === "original" ? null : known ? wanted : versions.length ? versions[versions.length - 1].v : null;
      return load(id, false);
    }).catch(function () { fillVersions(); render(); });
  }

  if (img.complete) start();
  img.addEventListener("load", start);
})();
