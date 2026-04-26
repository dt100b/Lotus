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

function renderChart(data) {
  state.lastProfile = data;
  const points = data.points || [];
  els.visibleStrikes.textContent = `${points.length}`;
  clearSvg(els.chart);

  if (!points.length) {
    els.chart.hidden = true;
    els.chartEmpty.hidden = false;
    return;
  }

  els.chart.hidden = false;
  els.chartEmpty.hidden = true;

  const width = 900;
  const height = 480;
  const padding = { top: 28, right: 36, bottom: 60, left: 86 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const strikes = points.map((point) => point.strike);
  const values = points.map((point) => point.value);
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1e-9);
  const minStrike = Math.min(...strikes);
  const maxStrike = Math.max(...strikes);
  const strikeSpan = Math.max(maxStrike - minStrike, 1);
  const zeroY = padding.top + plotHeight / 2;
  const spotX = padding.left + ((data.spot_price - minStrike) / strikeSpan) * plotWidth;
  const bandWidth = plotWidth / Math.max(points.length, 1);
  const barWidth = Math.max(10, bandWidth * 0.72);

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
    const y = zeroY - tick * (plotHeight / 2);
    root.appendChild(
      createSvgNode("line", {
        x1: padding.left,
        y1: y,
        x2: padding.left + plotWidth,
        y2: y,
        stroke: "rgba(139,178,170,0.16)",
        "stroke-width": tick === 0 ? 1.5 : 1,
      }),
    );

    root.appendChild(
      createSvgNode("text", {
        x: padding.left - 12,
        y: y + 4,
        "text-anchor": "end",
        fill: "rgba(139,178,170,0.9)",
        "font-size": 12,
      }),
    ).textContent = fmtNumber(tick * maxAbs, 2);
  });

  const xScale = (strike) => padding.left + ((strike - minStrike) / strikeSpan) * plotWidth;
  const yScale = (value) => zeroY - (value / maxAbs) * (plotHeight / 2 - 12);

  if (Number.isFinite(spotX)) {
    root.appendChild(
      createSvgNode("line", {
        x1: spotX,
        y1: padding.top,
        x2: spotX,
        y2: padding.top + plotHeight,
        stroke: "#ffd166",
        "stroke-width": 2,
        "stroke-dasharray": "5 7",
      }),
    );

    root.appendChild(
      createSvgNode("text", {
        x: Math.min(Math.max(spotX + 8, padding.left + 6), padding.left + plotWidth - 6),
        y: padding.top + 14,
        fill: "#ffd166",
        "font-size": 12,
      }),
    ).textContent = `Spot ${fmtNumber(data.spot_price, 0)}`;
  }

  points.forEach((point) => {
    const xCenter = xScale(point.strike);
    const yValue = yScale(point.value);
    const heightValue = Math.abs(zeroY - yValue);
    const y = point.value >= 0 ? yValue : zeroY;
    const fill = point.value >= 0 ? "#42d392" : "#ff6b57";

    const bar = createSvgNode("rect", {
      x: xCenter - barWidth / 2,
      y,
      width: barWidth,
      height: Math.max(heightValue, 1),
      rx: 8,
      fill,
      opacity: 0.92,
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
        x: xCenter,
        y: height - 26,
        "text-anchor": "middle",
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
  ).textContent = "Strike";

  const yAxisLabel = createSvgNode("text", {
    x: 22,
    y: padding.top + plotHeight / 2,
    transform: `rotate(-90 22 ${padding.top + plotHeight / 2})`,
    "text-anchor": "middle",
    fill: "rgba(139,178,170,0.9)",
    "font-size": 12,
  });
  yAxisLabel.textContent = `${state.view.toUpperCase()} GEX`;
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
  await loadHealth();
  await loadExpiries();
  await loadProfile();

  if (refreshHandle) {
    window.clearInterval(refreshHandle);
  }
  refreshHandle = window.setInterval(async () => {
    await loadHealth();
    await loadProfile();
  }, state.refreshSeconds * 1000);
}

window.addEventListener("DOMContentLoaded", init);
