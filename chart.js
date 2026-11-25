/* Charts by hand on <canvas>, devicePixelRatio aware (STEP 10). No library. */
(function () {
  const C = { green: "#00d35a", red: "#ff453a", blue: "#0a84ff", orange: "#ff9f0a", ter: "rgba(235,235,245,0.3)", sec: "rgba(235,235,245,0.6)" };
  const reduce = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: r.width, h: r.height };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // line chart: points [{t, v}], marks [{t, label, color}], start (dashed line)
  function line(canvas, data, prevCount) {
    const pts = (data.points || []).map(p => ({ t: Date.parse(p.t), v: +p.v })).filter(p => isFinite(p.t) && isFinite(p.v));
    const draw = (slide) => {
      const { ctx, w, h } = fit(canvas);
      ctx.clearRect(0, 0, w, h);
      if (pts.length < 2) return false;
      const top = 54, bot = 14, padX = 16;
      const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
      let lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
      if (data.start != null && isFinite(data.start)) { lo = Math.min(lo, data.start); hi = Math.max(hi, data.start); }
      if (hi - lo < 1e-9) { hi += 0.5; lo -= 0.5; }
      const X = t => padX + (w - 2 * padX) * ((t - t0) / Math.max(1, t1 - t0));
      const Y = v => top + (h - top - bot) * (1 - (v - lo) / (hi - lo));
      const xy = pts.map(p => [X(p.t), Y(p.v)]);
      if (slide < 1 && xy.length > 1) { // a new point slides in from the previous one
        const a = xy[xy.length - 2], b = xy[xy.length - 1];
        xy[xy.length - 1] = [a[0] + (b[0] - a[0]) * slide, a[1] + (b[1] - a[1]) * slide];
      }
      // gradient under the line
      const g = ctx.createLinearGradient(0, top, 0, h);
      g.addColorStop(0, "rgba(0,211,90,0.28)"); g.addColorStop(1, "rgba(0,211,90,0)");
      ctx.beginPath(); ctx.moveTo(xy[0][0], h - bot);
      xy.forEach(p => ctx.lineTo(p[0], p[1])); ctx.lineTo(xy[xy.length - 1][0], h - bot); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      // dashed start line
      if (data.start != null && isFinite(data.start)) {
        ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = C.ter; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padX, Y(data.start)); ctx.lineTo(w - padX, Y(data.start)); ctx.stroke(); ctx.restore();
      }
      ctx.beginPath(); xy.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
      ctx.strokeStyle = C.green; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      // marks above the line; a later mark that would overlap moves up a row
      ctx.font = "600 11px -apple-system, system-ui, sans-serif";
      const rows = [];
      (data.marks || []).forEach(m => {
        const t = Date.parse(m.t); if (!isFinite(t)) return;
        const x = Math.min(Math.max(X(Math.min(Math.max(t, t0), t1)), padX), w - padX);
        const tw = ctx.measureText(m.label).width + 14, x0 = Math.min(Math.max(x - tw / 2, 2), w - tw - 2);
        let row = 0;
        while ((rows[row] || []).some(([a, b]) => x0 < b + 4 && x0 + tw > a - 4)) row++;
        (rows[row] = rows[row] || []).push([x0, x0 + tw]);
        const y = Math.max(4, 30 - row * 22);
        const col = { blue: C.blue, green: C.green, red: C.red }[m.color] || C.sec;
        ctx.fillStyle = col; roundRect(ctx, x0, y, tw, 18, 9); ctx.fill();
        ctx.fillStyle = m.color === "green" ? "#000" : "#fff"; ctx.fillText(m.label, x0 + 7, y + 13);
        ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(x, y + 18); ctx.lineTo(x, Y(nearest(pts, t).v)); ctx.stroke(); ctx.globalAlpha = 1;
      });
      return true;
    };
    const grew = prevCount != null && pts.length > prevCount && prevCount > 1 && !reduce();
    if (!grew) return draw(1);
    const s = performance.now();
    const step = (n) => { const k = Math.min(1, (n - s) / 250); draw(1 - Math.pow(1 - k, 3)); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    return pts.length >= 2;
  }

  function nearest(pts, t) { let b = pts[0]; for (const p of pts) if (Math.abs(p.t - t) < Math.abs(b.t - t)) b = p; return b; }

  // 1-minute candles [{t,o,h,l,c}] with an orange dashed exit line
  function candles(canvas, cs, exitLine) {
    const { ctx, w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!cs || !cs.length) return false;
    let lo = Math.min(...cs.map(c => c.l)), hi = Math.max(...cs.map(c => c.h));
    if (exitLine != null) { lo = Math.min(lo, exitLine); hi = Math.max(hi, exitLine); }
    if (hi - lo <= 0) { hi *= 1.01; lo *= 0.99; }
    const pad = 10, cw = (w - 2 * pad) / Math.max(cs.length, 20);
    const Y = v => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo));
    cs.forEach((c, i) => {
      const x = pad + i * cw + cw / 2, col = c.c >= c.o ? C.green : C.red;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
      const y0 = Y(Math.max(c.o, c.c)), y1 = Y(Math.min(c.o, c.c));
      ctx.fillRect(x - Math.max(1, cw * 0.32), y0, Math.max(2, cw * 0.64), Math.max(1, y1 - y0));
    });
    if (exitLine != null) {
      ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = C.orange; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(pad, Y(exitLine)); ctx.lineTo(w - pad, Y(exitLine)); ctx.stroke(); ctx.restore();
    }
    return true;
  }

  window.DeskChart = { line, candles };
})();
