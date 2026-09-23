// MERMAID Time Series Explorer
//
// Loads data/app_data.json (written by R/export_app_data.R), pairs surveys
// across the selected protocols, and maps the sites that meet the filters.
//
// Pairing rule - the same as analysis/explore_time_series_map.qmd:
//   * Every survey of a selected protocol is tried as an anchor.
//   * For each other selected protocol, the survey at the same site closest in
//     time to the anchor is found. If it is within the pairing window for every
//     selected protocol, the anchor and its matches form one paired visit.
//   * Each paired visit is dated by its earliest survey, and a site's count is
//     the number of distinct calendar years of its paired visits.
//   * With a single protocol, every survey is its own visit.

"use strict";

const DATA_URL = "data/app_data.json";
const EXPLORE_URL = "https://explore.datamermaid.org/";
const DAY_MS = 24 * 60 * 60 * 1000;

// Colour bands for the number of years - reversed viridis, as in the Quarto
// document. A site takes the last band whose minimum it reaches.
const YEAR_BANDS = [
  { label: "1 year",    min: 1,  colour: "#fde725", text: "#1f2a37" },
  { label: "2 years",   min: 2,  colour: "#5ec962", text: "#1f2a37" },
  { label: "3–4 years", min: 3,  colour: "#21918c", text: "#ffffff" },
  { label: "5–9 years", min: 5,  colour: "#3b528b", text: "#ffffff" },
  { label: "10+ years", min: 10, colour: "#440154", text: "#ffffff" }
];

const POLICY_LABELS = {
  0: "No public data",
  1: "Public summary",
  2: "Public",
  3: "Public and public summary"
};

// Filters and options chosen in the sidebar
const state = {
  protocols: new Set(["fish", "benthic"]),
  window: 30,
  minYears: 2,
  countries: new Set(),
  projects: new Set(),
  group: true
};

let DATA = null;      // processed data (see processData)
let RESULTS = [];     // sites meeting all filters
let map, siteLayer, legend;
let firstDraw = true;

// ---------------------------------------------------------------------------
// Helpers

const $ = id => document.getElementById(id);

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const yearOf = day => new Date(day * DAY_MS).getUTCFullYear();

const fmt = n => n.toLocaleString("en-US");

const plural = (n, word, words = word + "s") => `${fmt(n)} ${n === 1 ? word : words}`;

function bandFor(n) {
  let band = YEAR_BANDS[0];
  for (const b of YEAR_BANDS) if (n >= b.min) band = b;
  return band;
}

// Closest value to t in a sorted array (ties go to the earlier value)
function nearest(sorted, t) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1; else hi = mid;
  }
  // sorted[lo] is the first value >= t
  if (lo === 0) return sorted[0];
  if (lo === sorted.length) return sorted[lo - 1];
  return (t - sorted[lo - 1] <= sorted[lo] - t) ? sorted[lo - 1] : sorted[lo];
}

// Throttle a function to at most once per animation frame
function perFrame(fn) {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(); });
  };
}

// ---------------------------------------------------------------------------
// Data

function processData(raw) {
  const protocols = raw.meta.protocols;              // [{key, label}]
  const nProt = protocols.length;
  const countries = raw.countries.map(name => ({ name, sites: 0 }));
  const projects = raw.projects.id.map((id, i) => ({
    id, name: raw.projects.name[i], countries: new Set(), sites: 0
  }));

  const s = raw.sites;
  const sites = s.id.map((id, i) => {
    const lon = s.lon[i];
    return {
      idx: i,
      id,
      name: s.name[i],
      project: projects[s.project[i]],
      country: countries[s.country[i]],
      lat: s.lat[i],
      lon,
      // Shift sites east of the antimeridian (e.g. eastern Fiji) so they sit
      // next to their neighbours; for drawing only
      lonMap: lon < -150 ? lon + 360 : lon,
      policy: s.policy.map(p => p[i] ?? 0),
      dates: Array.from({ length: nProt }, () => [])  // days, per protocol
    };
  });

  for (const site of sites) {
    site.project.countries.add(site.country.name);
    site.project.sites++;
    site.country.sites++;
  }

  const sv = raw.surveys;
  for (let i = 0; i < sv.site.length; i++) {
    sites[sv.site[i]].dates[sv.protocol[i]].push(sv.day[i]);
  }
  for (const site of sites) for (const d of site.dates) d.sort((a, b) => a - b);

  return { meta: raw.meta, protocols, countries, projects, sites };
}

// Years of paired visits at one site, or null if there are none
function pairedYears(site, protIdx, window) {
  for (const p of protIdx) if (site.dates[p].length === 0) return null;
  const years = new Set();
  for (const a of protIdx) {
    for (const t of site.dates[a]) {
      let earliest = t;
      let ok = true;
      for (const q of protIdx) {
        if (q === a) continue;
        const m = nearest(site.dates[q], t);
        if (Math.abs(m - t) > window) { ok = false; break; }
        if (m < earliest) earliest = m;
      }
      if (ok) years.add(yearOf(earliest));
    }
  }
  return years.size ? [...years].sort((x, y) => x - y) : null;
}

function selectedProtocolIdx() {
  return DATA.protocols
    .map((p, i) => (state.protocols.has(p.key) ? i : -1))
    .filter(i => i >= 0);
}

function allowedProjects() {
  if (state.countries.size === 0) return DATA.projects;
  return DATA.projects.filter(p => [...p.countries].some(c => state.countries.has(c)));
}

// Recalculate RESULTS from the current filters
function compute() {
  const protIdx = selectedProtocolIdx();
  const all = [];
  if (protIdx.length > 0) {
    for (const site of DATA.sites) {
      if (state.countries.size && !state.countries.has(site.country.name)) continue;
      if (state.projects.size && !state.projects.has(site.project.id)) continue;
      const years = pairedYears(site, protIdx, state.window);
      if (years) all.push({ site, years, n: years.length });
    }
  }

  // Keep the minimum-years slider within the range the current selection allows
  const maxYears = Math.max(1, ...all.map(r => r.n));
  const slider = $("min-years");
  slider.max = maxYears;
  if (state.minYears > maxYears) state.minYears = maxYears;
  slider.value = state.minYears;
  $("min-years-value").textContent = state.minYears;

  RESULTS = all
    .filter(r => r.n >= state.minYears)
    .sort((a, b) => a.n - b.n);   // more years drawn last, on top
}

// ---------------------------------------------------------------------------
// Map

function initMap() {
  map = L.map("map", {
    preferCanvas: true,
    worldCopyJump: true,
    minZoom: 2,
    zoomControl: true
  });

  // Esri basemaps are free to use without an API key
  const esri = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const attribution = "Tiles &copy; Esri";
  const basemaps = {
    "Light": L.tileLayer(esri + "Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 16, attribution: attribution + " &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors" }),
    "Ocean": L.tileLayer(esri + "Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 13, attribution: attribution + " &mdash; Sources: GEBCO, NOAA, CHS, OSU, UNH, CSUMB, National Geographic, DeLorme, NAVTEQ, and Esri" }),
    "Satellite": L.tileLayer(esri + "World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 18, attribution: attribution + " &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" })
  };
  basemaps.Light.addTo(map);
  L.control.layers(basemaps, null, { position: "topright" }).addTo(map);

  // Legend
  legend = L.control({ position: "bottomright" });
  legend.onAdd = () => {
    const div = L.DomUtil.create("div", "legend");
    div.innerHTML = "<strong>Years with data</strong>" + YEAR_BANDS
      .map(b => `<div><span class="swatch" style="background:${b.colour}"></span>${b.label}</div>`)
      .join("");
    return div;
  };
  legend.addTo(map);

  // "Zoom to sites" button under the zoom control
  const zoomCtl = L.control({ position: "topleft" });
  zoomCtl.onAdd = () => {
    const div = L.DomUtil.create("div", "leaflet-bar");
    const btn = L.DomUtil.create("button", "zoom-button", div);
    btn.type = "button";
    btn.textContent = "Zoom to sites";
    btn.title = "Zoom to the sites shown";
    L.DomEvent.on(btn, "click", e => { L.DomEvent.stop(e); fitToResults(); });
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  zoomCtl.addTo(map);

  map.setView([0, 120], 2);
  map.on("click", hideSitePanel);
}

function makeSiteLayer() {
  if (!state.group) return L.layerGroup();
  return L.markerClusterGroup({
    chunkedLoading: true,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    maxClusterRadius: 40,
    disableClusteringAtZoom: 8,
    // Colour each group by the longest time series inside it
    iconCreateFunction: cluster => {
      let max = 0;
      for (const m of cluster.getAllChildMarkers()) if (m.options.nYears > max) max = m.options.nYears;
      const band = bandFor(max);
      const n = cluster.getChildCount();
      const size = n < 10 ? 28 : n < 100 ? 34 : n < 1000 ? 40 : 46;
      return L.divIcon({
        html: `<div class="cluster-icon" style="background:${band.colour};color:${band.text}">${fmt(n)}</div>`,
        className: "cluster",
        iconSize: [size, size]
      });
    }
  });
}

function drawSites() {
  if (siteLayer) map.removeLayer(siteLayer);
  siteLayer = makeSiteLayer();

  const markers = RESULTS.map(r => {
    const band = bandFor(r.n);
    const marker = L.circleMarker([r.site.lat, r.site.lonMap], {
      radius: 6,
      weight: 1,
      color: "#1f2a37",
      fillColor: band.colour,
      fillOpacity: 0.95,
      nYears: r.n
    });
    marker.on("click", e => { L.DomEvent.stop(e); showSitePanel(r); });
    marker.bindTooltip(`${esc(r.site.name)} · ${plural(r.n, "year")}`, { direction: "top", offset: [0, -4] });
    return marker;
  });

  if (state.group) siteLayer.addLayers(markers);
  else markers.forEach(m => siteLayer.addLayer(m));
  siteLayer.addTo(map);

  if (firstDraw && RESULTS.length) { fitToResults(); firstDraw = false; }
}

function fitToResults() {
  if (!RESULTS.length) return;
  const bounds = L.latLngBounds(RESULTS.map(r => [r.site.lat, r.site.lonMap]));
  map.fitBounds(bounds, { padding: [30, 30], maxZoom: 10 });
}

// ---------------------------------------------------------------------------
// Site panel

function exploreLink(site) {
  // MERMAID Explore encodes the project name twice (spaces become %2520)
  const project = encodeURIComponent(encodeURIComponent(site.project.name));
  return `${EXPLORE_URL}?lat=${site.lat}&lng=${site.lon}&zoom=10&project=${project}`;
}

function showSitePanel(r) {
  const site = r.site;
  const protocolRows = selectedProtocolIdx().map(p => {
    const years = [...new Set(site.dates[p].map(yearOf))].join(", ");
    return `<div class="protocol-row">
        <div><span class="label">${esc(DATA.protocols[p].label)}</span>
        <span class="policy"> · ${esc(POLICY_LABELS[site.policy[p]])}</span></div>
        <div class="years">Surveyed in ${esc(years)}</div>
      </div>`;
  }).join("");

  const heading = state.protocols.size > 1
    ? `Years with paired surveys (${r.n})`
    : `Years with data (${r.n})`;

  const panel = $("site-panel");
  panel.innerHTML = `
    <button type="button" class="close" aria-label="Close">&times;</button>
    <h3>${esc(site.name)}</h3>
    <div class="meta">${esc(site.project.name)}<br>${esc(site.country.name)}
      · ${site.lat.toFixed(4)}, ${site.lon.toFixed(4)}</div>
    <h4>${heading}</h4>
    <div class="chips">${r.years.map(y => `<span class="chip">${y}</span>`).join("")}</div>
    <h4>Selected protocols</h4>
    ${protocolRows}
    <a class="explore-link" href="${exploreLink(site)}" target="_blank" rel="noopener">View project in MERMAID Explore ↗</a>`;
  panel.hidden = false;
  panel.querySelector(".close").addEventListener("click", hideSitePanel);
}

function hideSitePanel() { $("site-panel").hidden = true; }

// ---------------------------------------------------------------------------
// Sidebar

function buildProtocolList() {
  const list = $("protocol-list");
  list.innerHTML = DATA.protocols.map((p, i) => {
    const nSites = DATA.sites.filter(s => s.dates[i].length > 0).length;
    return `<label>
        <span class="name"><input type="checkbox" value="${p.key}" ${state.protocols.has(p.key) ? "checked" : ""}>
        ${esc(p.label)}</span>
        <span class="count" title="Sites with any public data for this protocol">${fmt(nSites)}</span>
      </label>`;
  }).join("");
  list.addEventListener("change", e => {
    if (e.target.checked) state.protocols.add(e.target.value);
    else state.protocols.delete(e.target.value);
    update();
  });
}

// A searchable check-box list, used for countries and projects
function setupFilter({ key, getItems, selected, onChange }) {
  const search = $(`${key}-search`);
  const options = $(`${key}-options`);
  const clear = $(`${key}-clear`);

  function render() {
    const q = search.value.trim().toLowerCase();
    const items = getItems();
    // Selected items first, then alphabetical
    const shown = items
      .filter(it => !q || it.label.toLowerCase().includes(q))
      .sort((a, b) => (selected.has(b.value) - selected.has(a.value)) || a.label.localeCompare(b.label));
    options.innerHTML = shown.length
      ? shown.map(it => `<label><input type="checkbox" value="${esc(it.value)}" ${selected.has(it.value) ? "checked" : ""}>
          <span>${esc(it.label)}</span></label>`).join("")
      : `<div class="empty">No matches</div>`;
    clear.hidden = selected.size === 0;
    clear.textContent = `Clear (${selected.size})`;
  }

  search.addEventListener("input", render);
  options.addEventListener("change", e => {
    if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
    render();
    onChange();
  });
  clear.addEventListener("click", () => { selected.clear(); render(); onChange(); });
  return render;
}

let renderCountries, renderProjects;

function buildFilters() {
  renderCountries = setupFilter({
    key: "country",
    selected: state.countries,
    getItems: () => DATA.countries.map(c => ({ value: c.name, label: c.name })),
    onChange: () => {
      // Drop selected projects that are outside the chosen countries
      const allowed = new Set(allowedProjects().map(p => p.id));
      for (const id of [...state.projects]) if (!allowed.has(id)) state.projects.delete(id);
      renderProjects();
      update({ zoom: true });
    }
  });
  renderProjects = setupFilter({
    key: "project",
    selected: state.projects,
    getItems: () => allowedProjects().map(p => ({ value: p.id, label: p.name })),
    onChange: () => update({ zoom: true })
  });
  renderCountries();
  renderProjects();
}

function buildControls() {
  const win = $("window");
  const onWindow = perFrame(update);
  win.addEventListener("input", () => {
    state.window = Number(win.value);
    $("window-value").textContent = `±${state.window} days`;
    onWindow();
  });

  const minYears = $("min-years");
  const onMinYears = perFrame(update);
  minYears.addEventListener("input", () => {
    state.minYears = Number(minYears.value);
    $("min-years-value").textContent = state.minYears;
    onMinYears();
  });

  $("group-sites").addEventListener("change", e => { state.group = e.target.checked; drawSites(); });
  $("download").addEventListener("click", downloadCsv);

  const d = DATA.meta.downloaded;
  $("data-date").textContent = d ? `Data downloaded from MERMAID on ${d}.` : "";
}

function updateSummary() {
  const n = RESULTS.length;
  $("site-count").textContent = fmt(n);
  $("site-count-label").textContent = n === 1 ? "site" : "sites";

  const labels = DATA.protocols.filter(p => state.protocols.has(p.key)).map(p => p.label);
  let detail;
  if (labels.length === 0) {
    detail = "Tick at least one protocol to show sites.";
  } else {
    const projects = new Set(RESULTS.map(r => r.site.project.id)).size;
    const countries = new Set(RESULTS.map(r => r.site.country.name)).size;
    const what = labels.length === 1
      ? `with ${labels[0]} data`
      : `with ${labels.join(", ")} surveyed within ±${state.window} days of each other`;
    detail = `${plural(projects, "project")} · ${plural(countries, "country", "countries")}<br>` +
      `Sites ${esc(what)} in at least ${plural(state.minYears, "year")}.`;
  }
  $("summary-detail").innerHTML = detail;

  $("window-panel").classList.toggle("is-disabled", labels.length < 2);
  $("download").disabled = n === 0;
}

function update(opts = {}) {
  compute();
  updateSummary();
  drawSites();
  hideSitePanel();
  if (opts.zoom) fitToResults();
}

// ---------------------------------------------------------------------------
// CSV download

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv() {
  const protIdx = selectedProtocolIdx();
  const keys = protIdx.map(p => DATA.protocols[p].key);
  const labels = protIdx.map(p => DATA.protocols[p].label);

  const header = ["site_id", "site", "project", "project_id", "country",
    "latitude", "longitude", "n_years", "years", "first_year", "last_year",
    "protocols", "pairing_window_days",
    ...keys.map(k => `policy_${k}`)];

  const rows = [...RESULTS]
    .sort((a, b) => b.n - a.n || a.site.name.localeCompare(b.site.name))
    .map(r => [
      r.site.id, r.site.name, r.site.project.name, r.site.project.id, r.site.country.name,
      r.site.lat, r.site.lon, r.n, r.years.join("; "), r.years[0], r.years[r.years.length - 1],
      labels.join(" + "), protIdx.length > 1 ? state.window : "",
      ...protIdx.map(p => POLICY_LABELS[r.site.policy[p]])
    ]);

  const csv = [header, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
  // The byte-order mark helps Excel read accented site names correctly
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mermaid_time_series_${keys.join("_")}_min${state.minYears}yrs.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Start

async function init() {
  initMap();
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    DATA = processData(await response.json());
  } catch (err) {
    const box = $("loading");
    box.classList.add("error");
    box.innerHTML = location.protocol === "file:"
      ? "The data could not be loaded because this page was opened directly from a file.<br>" +
        "Browsers block that, so run a small local web server instead (see the README)."
      : `The data could not be loaded (${esc(err.message)}).<br>` +
        "Check that data/app_data.json exists - it is created by R/export_app_data.R.";
    console.error(err);
    return;
  }

  buildProtocolList();
  buildFilters();
  buildControls();
  update();
  $("loading").hidden = true;
}

init();
