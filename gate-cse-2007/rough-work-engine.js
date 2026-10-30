/* Vector strokes stay independent of quiz responses, grading and storage. */
((root, factory) => {
  "use strict";
  const engine = factory();
  if (typeof module === "object" && module.exports) module.exports = engine;
  else root.RoughWorkEngine = engine;
})(typeof globalThis === "object" ? globalThis : this, () => {
  "use strict";
  const colors = Object.freeze(["#17233b", "#4169e1", "#dc2626", "#15803d", "#f59e0b"]);
  const widths = Object.freeze([2, 4, 8, 16]);
  const tools = Object.freeze(["pen", "highlighter", "eraser"]);
  const paperStyles = Object.freeze(["blank", "dotted", "ruled", "grid"]);
  const limits = Object.freeze({ strokes: 1000, pointsPerStroke: 10000, totalPoints: 100000 });
  const paper = Object.freeze({ width: 1000, height: 1250 });
  const fields = ["tool", "color", "width", "points"];
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const coordinate = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

  function validateStrokes(value) {
    if (!Array.isArray(value) || value.length > limits.strokes) throw new Error("Invalid rough-work strokes.");
    const restored = [];
    let total = 0;
    for (const stroke of value) {
      if (!object(stroke) || Object.keys(stroke).length !== fields.length || fields.some(field => !Object.hasOwn(stroke, field)) ||
          !tools.includes(stroke.tool) || !colors.includes(stroke.color) || !widths.includes(stroke.width) ||
          !Array.isArray(stroke.points) || !stroke.points.length || stroke.points.length > limits.pointsPerStroke) throw new Error("Invalid rough-work stroke.");
      total += stroke.points.length;
      if (total > limits.totalPoints) throw new Error("Too many rough-work points.");
      const points = [];
      for (const point of stroke.points) {
        if (!Array.isArray(point) || point.length !== 2 || !coordinate(point[0]) || !coordinate(point[1])) throw new Error("Invalid rough-work point.");
        points.push([point[0], point[1]]);
      }
      restored.push({ tool: stroke.tool, color: stroke.color, width: stroke.width, points });
    }
    return restored;
  }

  // Width and height are canvas backing dimensions. A transparent ink layer
  // lets erasing reveal the paper surface without depending on its color.
  function draw(context, strokes, width, height) {
    if (!context || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new Error("Invalid rough-work canvas.");
    const checked = validateStrokes(strokes);
    context.save();
    try {
      context.setTransform?.(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      context.lineCap = "round";
      context.lineJoin = "round";
      for (const stroke of checked) {
        context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
        context.globalAlpha = stroke.tool === "highlighter" ? 0.25 : 1;
        context.strokeStyle = stroke.color;
        context.fillStyle = stroke.color;
        context.lineWidth = stroke.width * width / paper.width;
        context.beginPath();
        const [firstX, firstY] = stroke.points[0];
        if (stroke.points.length === 1) {
          context.arc(firstX * width, firstY * height, context.lineWidth / 2, 0, Math.PI * 2);
          context.fill();
        } else {
          context.moveTo(firstX * width, firstY * height);
          for (let i = 1; i < stroke.points.length; i++) context.lineTo(stroke.points[i][0] * width, stroke.points[i][1] * height);
          context.stroke();
        }
      }
    } finally { context.restore(); }
  }

  // Render the backdrop separately so erasing the ink cannot erase its rules.
  // The virtual grid has a fixed number of rows/columns at any display size.
  function drawPaper(context, style, width, height) {
    if (!paperStyles.includes(style)) throw new Error("Invalid rough-work paper.");
    if (!context || !Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) throw new Error("Invalid rough-work canvas.");
    context.save();
    try {
      context.setTransform?.(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = "source-over";
      context.globalAlpha = 1;
      context.clearRect(0, 0, width, height);
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      if (style === "blank") return;
      context.beginPath();
      if (style === "dotted") {
        const radius = 3 * (width / paper.width);
        context.fillStyle = "#8fa3bd";
        for (let x = 25; x < paper.width; x += 50) for (let y = 25; y < paper.height; y += 50) {
          const left = x / paper.width * width, top = y / paper.height * height;
          context.moveTo(left + radius, top);
          context.arc(left, top, radius, 0, Math.PI * 2);
        }
        context.fill();
      } else {
        context.strokeStyle = "#b0c0d4";
        context.lineWidth = 2.5 * (width / paper.width);
        context.lineCap = "butt";
        context.lineJoin = "miter";
        for (let y = 50; y < paper.height; y += 50) {
          const top = y / paper.height * height;
          context.moveTo(0, top);
          context.lineTo(width, top);
        }
        if (style === "grid") for (let x = 50; x < paper.width; x += 50) {
          const left = x / paper.width * width;
          context.moveTo(left, 0);
          context.lineTo(left, height);
        }
        context.stroke();
      }
    } finally { context.restore(); }
  }

  return Object.freeze({ colors, widths, tools, paperStyles, limits, paper, validateStrokes, draw, drawPaper });
});
