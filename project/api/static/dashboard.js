const state = {
  expiry: "ALL",
  view: "net",
  refreshSeconds: 5,
  lastProfile: null,
  contractVersion: "--",
};

const els = {
  expirySelect: document.getElementById("expiry-select"),
  viewButtons: Array.from(document.querySelectorAll("[data-view]")),
  asOfPill: document.getElementById("as-of-pill"),
  spotPill: document.getElementById("spot-pill"),
  freshnessPill: document.getElementById("freshness-pill"),
  contractPill: document.getElementById("contract-pill"),
  selectedExpiry: document.getElementById("selected-expiry"),
  selectedView: document.getElementById("selected-view"),
  refreshValue: document.getElementById("refresh-value"),
  visibleStrikes: document.getElementById("visible-strikes"),
  snapshotProvenance: document.getElementById("snapshot-provenance"),
  chartCopy: document.getElementById("chart-copy"),
  tableBody: document.getElementById("top-strikes-body"),
  chart: document.getElementById("chart"),
  chartEmpty: document.getElementById("chart-empty"),
  errorBanner: document.getElementById("error-banner"),
};

let inflight = false;
let refreshHandle = null;

function fmtNumber(value, decimals = 0) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function setError(message) {
  els.errorBanner.textContent = message;
  els.errorBanner.hidden = false;
}

function setStaleError(message) {
  els.errorBanner.dataset.source = "stale";
  setError(message);
}

function clearError() {
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = "";
  delete els.errorBanner.dataset.source;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      detail = body.detail || detail;
    } catch (_) {
      // Keep the HTTP fallback when the response is not JSON.
    }
    throw new Error(detail);
  }
  return response.json();
}

function syncViewButtons() {
  els.viewButtons.forEach((button) => {
    const active = button.dataset.view === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  els.selectedView.textContent = state.view.toUpperCase();
}

function renderMeta(data) {
  els.asOfPill.textContent = `As of: ${new Date(data.as_of).toLocaleString()}`;
  els.spotPill.textContent = `Spot: $${fmtNumber(data.spot_price, 2)}`;
  els.selectedExpiry.textContent = state.expiry;
}

function renderHealth(data) {
  const ageSeconds = Number(data.snapshot_age_seconds || 0);
  const thresholdSeconds = Number(data.freshness_threshold_seconds || 0);
  els.freshnessPill.textContent = data.is_fresh
    ? `Freshness: live (${fmtNumber(ageSeconds, 1)}s old)`
    : `Freshness: stale (${fmtNumber(ageSeconds, 1)}s old)`;
  els.freshnessPill.classList.toggle("pill-stale", !data.is_fresh);
  els.contractPill.textContent = `Contract: ${data.contract_version || state.contractVersion}`;
  els.snapshotProvenance.textContent = data.snapshot_provenance || "--";
  els.snapshotProvenance.title = data.snapshot_provenance || "";

  if (!data.is_fresh) {
    setStaleError(
      `Snapshot is stale. Age ${fmtNumber(ageSeconds, 1)}s exceeds freshness threshold ${fmtNumber(
        thresholdSeconds,
        0,
      )}s. Displayed values remain read-only from the loaded validated snapshot.`,
    );
  } else if (els.errorBanner.dataset.source === "stale") {
    clearError();
  }
}

function renderExpiries(data) {
  const values = ["ALL", ...(data.expiries || [])];
  els.expirySelect.innerHTML = values
    .map((expiry) => `<option value="${expiry}">${expiry}</option>`)
    .join("");
  if (!values.includes(state.expiry)) {
    state.expiry = "ALL";
  }
  els.expirySelect.value = state.expiry;
}

function createSvgNode(name, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, `${value}`));
  return node;
}

function clearSvg(svg) {
  while (svg.firstChild) {
    svg.removeChild(svg.firstChild);
  }
}

function getVisibleChartPoints(data) {
  const ordered = [...(data.points || [])]
    .map((point) => ({
      ...point,
      strike: Number(point.strike),
      value: Number(point.value),
      call_gex: Number(point.call_gex),
      put_gex: Number(point.put_gex),
      net_gex: Number(point.net_gex),
    }))
    .filter((point) => Number.isFinite(point.strike) && Number.isFinite(point.value))
    .sort((a, b) => a.strike - b.strike);

  if (!ordered.length) {
    return [];
  }

  const maxPoints = state.view === "net" ? 16 : 14;
  const minWindowPoints = 8;
  const spot = Number(data.spot_price);
  if (!Number.isFinite(spot) || spot <= 0) {
    return ordered
      .filter((point) => Math.abs(point.value) > 0)
      .slice(-maxPoints);
  }

  const windowRatio = 0.12;
  const lowerBound = spot * (1 - windowRatio);
  const upperBound = spot * (1 + windowRatio);

  let visible = ordered.filter((point) => point.strike >= lowerBound && point.strike <= upperBound);
  visible = visible.filter((point) => Math.abs(point.value) > 0);

  if (visible.length < minWindowPoints) {
    visible = [...ordered]
      .filter((point) => Math.abs(point.value) > 0)
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
      .slice(0, Math.min(maxPoints, ordered.length))
      .sort((a, b) => a.strike - b.strike);
  } else if (visible.length > maxPoints) {
    visible = [...visible]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, maxPoints)
      .sort((a, b) => a.strike - b.strike);
  }

  const maxAbs = Math.max(...visible.map((point) => Math.abs(point.value)), 0);
  const significanceFloor = maxAbs * 0.01;
  const filtered = visible.filter((point) => Math.abs(point.value) >= significanceFloor);
  if (filtered.length >= Math.min(8, visible.length)) {
    visible = filtered;
  }

  return visible;
}

function getSpotBandY(orderedPoints, rowGap, topPadding, spotPrice) {
  const centers = orderedPoints.map((_, index) => topPadding + index * rowGap + rowGap / 2);
  const strikes = orderedPoints.map((point) => point.strike);

  if (!Number.isFinite(spotPrice) || !strikes.length) {
    return null;
  }

  const highestStrike = strikes[0];
  const lowestStrike = strikes[strikes.length - 1];
  if (spotPrice >= highestStrike) {
    return centers[0] - rowGap / 2;
  }
  if (spotPrice <= lowestStrike) {
    return centers[centers.length - 1] + rowGap / 2;
  }

  for (let index = 0; index < strikes.length - 1; index += 1) {
    const highStrike = strikes[index];
    const lowStrike = strikes[index + 1];
    if (spotPrice === highStrike) {
      return centers[index];
    }
    if (spotPrice <= highStrike && spotPrice >= lowStrike) {
      const span = Math.max(highStrike - lowStrike, 1e-9);
      const ratio = (highStrike - spotPrice) / span;
      return centers[index] + ratio * (centers[index + 1] - centers[index]);
    }
  }

  return centers[centers.length - 1];
}

function renderChart(data) {
  state.lastProfile = data;
  const points = getVisibleChartPoints(data);
  els.visibleStrikes.textContent = `${points.length}`;
  clearSvg(els.chart);

  if (!points.length) {
    els.chart.hidden = true;
    els.chartEmpty.hidden = false;
    els.chartCopy.textContent =
      "No chartable strikes were available for the selected expiry and view.";
    return;
  }

  els.chart.hidden = false;
  els.chartEmpty.hidden = true;
  const orderedPoints = [...points].sort((a, b) => b.strike - a.strike);
  const spotPrice = Number(data.spot_price);
  const lowestStrike = Math.min(...points.map((point) => point.strike));
  const highestStrike = Math.max(...points.map((point) => point.strike));
  const strikeWindowPct = spotPrice > 0
    ? Math.max(Math.abs((highestStrike - spotPrice) / spotPrice), Math.abs((spotPrice - lowestStrike) / spotPrice)) * 100
    : 0;
  const viewLabel = state.view.toUpperCase();
  const viewNote =
    state.view === "net"
      ? "NET equals signed CALL plus signed PUT exposure."
      : `${viewLabel} view stays signed, so negative ${state.view} bars are valid when that book is net short at a strike.`;
  els.chartCopy.textContent =
    `Focused horizontal ${viewLabel} bars around spot, showing ${points.length} strikes within roughly +/-${fmtNumber(strikeWindowPct, 1)}% of $${fmtNumber(spotPrice, 0)}. ${viewNote}`;

  const width = 900;
  const rowGap = 22;
  const height = Math.max(390, 96 + orderedPoints.length * rowGap);
  const padding = { top: 42, right: 44, bottom: 68, left: 112 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const zeroX = padding.left + plotWidth / 2;
  const maxAbs = Math.max(...orderedPoints.map((point) => Math.abs(point.value)), 1e-9);
  const spotY = getSpotBandY(orderedPoints, rowGap, padding.top, spotPrice);
  const barHeight = Math.max(10, rowGap * 0.58);

  els.chart.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const root = createSvgNode("g");
  els.chart.appendChild(root);

  root.appendChild(
    createSvgNode("rect", {
      x: padding.left,
      y: padding.top,
      width: plotWidth,
      height: plotHeight,
      rx: 18,
      fill: "rgba(255,255,255,0.02)",
      stroke: "rgba(139,178,170,0.08)",
    }),
  );

  [-1, -0.5, 0, 0.5, 1].forEach((tick) => {
    const x = zeroX + tick * (plotWidth / 2 - 22);
    root.appendChild(
      createSvgNode("line", {
        x1: x,
        y1: padding.top,
        x2: x,
        y2: padding.top + plotHeight,
        stroke: "rgba(139,178,170,0.16)",
        "stroke-width": tick === 0 ? 1.5 : 1,
      }),
    );

    root.appendChild(
      createSvgNode("text", {
        x,
        y: height - 24,
        "text-anchor": "middle",
        fill: "rgba(139,178,170,0.9)",
        "font-size": 12,
      }),
    ).textContent = fmtNumber(tick * maxAbs, 2);
  });

  if (Number.isFinite(spotY)) {
    root.appendChild(
      createSvgNode("line", {
        x1: padding.left,
        y1: spotY,
        x2: padding.left + plotWidth,
        y2: spotY,
        stroke: "#ffd166",
        "stroke-width": 2,
        "stroke-dasharray": "5 7",
      }),
    );

    root.appendChild(
      createSvgNode("text", {
        x: padding.left + 10,
        y: Math.max(padding.top + 14, spotY - 10),
        fill: "#ffd166",
        "font-size": 12,
      }),
    ).textContent = `Spot ${fmtNumber(data.spot_price, 0)}`;
  }

  const xScale = (value) => zeroX + (value / maxAbs) * (plotWidth / 2 - 22);
  const topIndexes = new Set(
    [...orderedPoints]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 6)
      .map((point) => point.strike),
  );

  orderedPoints.forEach((point, index) => {
    const yCenter = padding.top + index * rowGap + rowGap / 2;
    const xValue = xScale(point.value);
    const x = Math.min(zeroX, xValue);
    const widthValue = Math.abs(xValue - zeroX);
    const fill = point.value >= 0 ? "#42d392" : "#ff6b57";
    const isHighlighted = topIndexes.has(point.strike);

    const bar = createSvgNode("rect", {
      x,
      y: yCenter - barHeight / 2,
      width: Math.max(widthValue, 1),
      height: barHeight,
      rx: 8,
      fill,
      opacity: isHighlighted ? 0.96 : 0.82,
      stroke: isHighlighted ? "rgba(255,255,255,0.2)" : "none",
      "stroke-width": isHighlighted ? 1.2 : 0,
    });
    bar.appendChild(createSvgNode("title")).textContent = [
      `Strike ${fmtNumber(point.strike, 0)}`,
      `${state.view.toUpperCase()} ${fmtNumber(point.value, 4)}`,
      `Call ${fmtNumber(point.call_gex, 4)}`,
      `Put ${fmtNumber(point.put_gex, 4)}`,
    ].join("\n");
    root.appendChild(bar);

    root.appendChild(
      createSvgNode("text", {
        x: padding.left - 12,
        y: yCenter + 4,
        "text-anchor": "end",
        fill: "rgba(139,178,170,0.86)",
        "font-size": 11,
      }),
    ).textContent = fmtNumber(point.strike, 0);
  });

  root.appendChild(
    createSvgNode("text", {
      x: padding.left + plotWidth / 2,
      y: height - 8,
      "text-anchor": "middle",
      fill: "rgba(139,178,170,0.9)",
      "font-size": 12,
    }),
  ).textContent = `${state.view.toUpperCase()} GEX`;

  const yAxisLabel = createSvgNode("text", {
    x: 26,
    y: padding.top + plotHeight / 2,
    transform: `rotate(-90 26 ${padding.top + plotHeight / 2})`,
    "text-anchor": "middle",
    fill: "rgba(139,178,170,0.9)",
    "font-size": 12,
  });
  yAxisLabel.textContent = "Strike";
  root.appendChild(yAxisLabel);
}

function renderTable(data) {
  const rows = [...(data.points || [])]
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 12);

  if (!rows.length) {
    els.tableBody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center;color:var(--muted);">No rows available.</td>
      </tr>
    `;
    return;
  }

  els.tableBody.innerHTML = rows
    .map((row) => {
      const className = row.value >= 0 ? "positive" : "negative";
      return `
        <tr>
          <td>${fmtNumber(row.strike, 0)}</td>
          <td class="${className}">${fmtNumber(row.value, 4)}</td>
          <td>${fmtNumber(row.call_gex, 4)}</td>
          <td>${fmtNumber(row.put_gex, 4)}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadConfig() {
  const data = await getJson("/api/v1/config");
  state.refreshSeconds = data.refresh_seconds || 5;
  state.expiry = data.default_expiry || state.expiry;
  state.view = data.default_view || state.view;
  state.contractVersion = data.contract_version || state.contractVersion;
  els.refreshValue.textContent = `${state.refreshSeconds}s`;
  els.contractPill.textContent = `Contract: ${state.contractVersion}`;
}

async function loadHealth() {
  const data = await getJson("/api/v1/health");
  renderHealth(data);
}

async function loadExpiries() {
  const data = await getJson("/api/v1/expiries");
  renderExpiries(data);
  renderMeta(data);
}

async function loadProfile() {
  if (inflight) {
    return;
  }

  inflight = true;
  if (els.errorBanner.dataset.source !== "stale") {
    clearError();
  }

  try {
    const params = new URLSearchParams({
      expiry: state.expiry,
      view: state.view,
    });
    const data = await getJson(`/api/v1/gex-profile?${params.toString()}`);
    renderMeta(data);
    renderChart(data);
    renderTable(data);
  } catch (error) {
    els.errorBanner.dataset.source = "request";
    setError(error.message || "Failed to load dashboard data.");
  } finally {
    inflight = false;
  }
}

function bindEvents() {
  els.expirySelect.addEventListener("change", async (event) => {
    state.expiry = event.target.value;
    els.selectedExpiry.textContent = state.expiry;
    await loadProfile();
  });

  els.viewButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      state.view = button.dataset.view;
      syncViewButtons();
      await loadProfile();
    });
  });

  window.addEventListener("resize", () => {
    if (state.lastProfile) {
      renderChart(state.lastProfile);
    }
  });
}

async function init() {
  bindEvents();
  await loadConfig();
  syncViewButtons();
  els.selectedExpiry.textContent = state.expiry;
  try {
    await loadHealth();
  } catch (error) {
    els.errorBanner.dataset.source = "request";
    setError(error.message || "Failed to load snapshot health.");
  }
  try {
    await loadExpiries();
  } catch (error) {
    els.errorBanner.dataset.source = "request";
    setError(error.message || "Failed to load expiry metadata.");
  }
  await loadProfile();

  if (refreshHandle) {
    window.clearInterval(refreshHandle);
  }
  refreshHandle = window.setInterval(async () => {
    try {
      await loadHealth();
    } catch (error) {
      els.errorBanner.dataset.source = "request";
      setError(error.message || "Failed to refresh snapshot health.");
    }
    await loadProfile();
  }, state.refreshSeconds * 1000);
}

window.addEventListener("DOMContentLoaded", init);
