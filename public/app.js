const app = document.querySelector("#app");
const params = new URLSearchParams(window.location.search);
const fixedRaceInput = params.get("race") || params.get("url") || "";
const pollMs = clamp(Number(params.get("poll")) || 1000, 1000, 60000);
const limit = clamp(Number(params.get("limit")) || 12, 1, 99);
const showTitle = isEnabledParam(params.get("title"), true);
const theme = params.get("theme") === "light" ? "light" : "dark";
const panelMode = params.get("panel") === "1" || params.get("background") === "panel";
const defaultOverlayWidth = 290;
const widthParam = params.get("width");
const parsedOverlayWidth = Number(widthParam);
const overlayWidth = widthParam && Number.isFinite(parsedOverlayWidth)
  ? clamp(parsedOverlayWidth, 120, 2400)
  : defaultOverlayWidth;
const renderZoom = clamp(Number(params.get("zoom")) || Number(params.get("scale")) || 3, 1, 4);
const titleFontSize = normalizeFontSizeParam(
  getFirstParam(["TitleFontSize", "titleFontSize", "titlefontsize", "title-font-size"]),
  "13px"
);
const isControlPage = window.location.pathname === "/control" || window.location.pathname === "/";
const HTML_ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

let latestData = null;
let lastError = null;
let loading = false;
let pollTimer = null;
let controlPollTimer = null;
let controlState = null;
let controlDiagnostics = null;
let diagnosticsLoading = false;
let diagnosticsError = "";
let pendingSplitHighlights = new Set();

document.documentElement.dataset.theme = theme;
document.documentElement.style.setProperty("--overlay-width", `${overlayWidth}px`);
document.documentElement.style.setProperty("--render-zoom", renderZoom);
document.documentElement.style.setProperty("--title-font-size", titleFontSize);
document.documentElement.style.setProperty("--fancy-outline-size", toRenderedPixelSize(3));
document.documentElement.style.setProperty("--fancy-outline-spread", toRenderedPixelSize(1.5));
document.documentElement.style.setProperty("--fancy-shadow-near", toRenderedPixelSize(1));
document.documentElement.style.setProperty("--fancy-shadow-offset", toRenderedPixelSize(2));
document.documentElement.style.setProperty("--fancy-shadow-far", toRenderedPixelSize(3));

if (isControlPage) {
  renderControl();
  loadCurrentRace();
  controlPollTimer = window.setInterval(() => loadControlDiagnostics({ silent: true }), 5000);
} else {
  renderOverlayShell();
  refreshRace();
  pollTimer = window.setInterval(refreshRace, pollMs);
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
  if (controlPollTimer) window.clearInterval(controlPollTimer);
});

function renderControl(message = "", isError = false) {
  const draftRaceInput = app.querySelector("#raceUrl")?.value;
  app.className = "setup";
  const overlayUrl = `${window.location.origin}/overlay`;
  const current = controlState?.currentRace;

  app.innerHTML = `
    <section class="setupPanel">
      <div class="brand">TheRun OBS Overlay</div>
      <form class="setupForm">
        <label for="raceUrl">Current race URL or id</label>
        <div class="setupRow">
          <input id="raceUrl" name="race" autocomplete="off" placeholder="https://therun.gg/races/16c4" value="${escapeHtml(
            draftRaceInput ?? current?.sourceUrl ?? ""
          )}" />
          <button type="submit" ${controlState?.saving ? "disabled" : ""}>${
            controlState?.saving ? "Saving..." : "Set Race"
          }</button>
        </div>
      </form>
      <div class="controlGrid">
        <div>
          <div class="controlLabel">OBS Browser Source</div>
          <a class="controlValue" href="/overlay">${escapeHtml(overlayUrl)}</a>
        </div>
        <div>
          <div class="controlLabel">Active Race</div>
          <div class="controlValue">${escapeHtml(current?.title || current?.raceId || "None selected")}</div>
        </div>
      </div>
      ${
        message
          ? `<div class="controlMessage${isError ? " isError" : ""}">${escapeHtml(message)}</div>`
          : ""
      }
      ${renderControlDiagnostics()}
    </section>
  `;

  app.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (controlState?.saving) return;
    const value = new FormData(event.currentTarget).get("race");
    if (!value) return;
    await saveCurrentRace(value);
  });

  bindDiagnosticsRefresh();
}

async function loadCurrentRace() {
  try {
    const data = await fetchJson("/api/current-race");
    controlState = data;
    renderControl();
    await loadControlDiagnostics();
  } catch (error) {
    controlState = { ok: false, currentRace: null };
    renderControl(error.message || String(error), true);
  }
}

async function saveCurrentRace(race) {
  controlState = { ...(controlState || {}), saving: true };
  renderControl();

  try {
    const data = await fetchJson("/api/current-race", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ race }),
    });
    controlState = { ok: true, version: data.version, currentRace: data.currentRace };
    controlDiagnostics = data.race || null;
    diagnosticsError = "";
    renderControl("Race updated. OBS will refresh on its next poll.");
  } catch (error) {
    controlState = { ...(controlState || {}), saving: false };
    renderControl(error.message || String(error), true);
  }
}

async function loadControlDiagnostics({ silent = false } = {}) {
  const raceId = controlState?.currentRace?.raceId;
  if (!raceId || diagnosticsLoading) return;

  diagnosticsLoading = true;
  if (!silent) renderControl();

  try {
    const data = await fetchJson(`/api/race?race=${encodeURIComponent(raceId)}`);
    if (controlState?.currentRace?.raceId !== raceId) return;
    controlDiagnostics = data;
    diagnosticsError = "";
  } catch (error) {
    if (controlState?.currentRace?.raceId === raceId) {
      diagnosticsError = error.message || String(error);
    }
  } finally {
    diagnosticsLoading = false;
    if (silent) {
      refreshControlDiagnosticsSection();
    } else {
      renderControl();
    }
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function refreshControlDiagnosticsSection() {
  const diagnosticsMarkup = renderControlDiagnostics();
  const existing = app.querySelector(".diagnosticsSection");
  if (!diagnosticsMarkup) {
    existing?.remove();
    return;
  }

  if (existing) {
    existing.outerHTML = diagnosticsMarkup;
  } else {
    app.querySelector(".setupPanel")?.insertAdjacentHTML("beforeend", diagnosticsMarkup);
  }
  bindDiagnosticsRefresh();
}

function bindDiagnosticsRefresh() {
  app.querySelector('[data-action="refresh-diagnostics"]')?.addEventListener("click", () => {
    loadControlDiagnostics();
  });
}

function renderControlDiagnostics() {
  if (!controlState?.currentRace?.raceId) return "";

  const data = controlDiagnostics;
  const runners = data?.runners || [];
  const freshness = data?.stale ? "Last good data" : data ? "Live" : "Waiting";
  const freshnessClass = data?.stale ? "warn" : data ? "ok" : "muted";

  return `
    <section class="diagnosticsSection">
      <div class="diagnosticsHeader">
        <div>
          <div class="diagnosticsTitle">Diagnostics</div>
          <div class="diagnosticsSubtitle">Visible on this control page only</div>
        </div>
        <button class="diagnosticsRefresh" type="button" data-action="refresh-diagnostics" ${
          diagnosticsLoading ? "disabled" : ""
        }>${diagnosticsLoading ? "Refreshing..." : "Refresh"}</button>
      </div>
      <div class="diagnosticsSummary">
        ${renderDiagnosticItem("Version", data?.version || controlState?.version || "-")}
        ${renderDiagnosticItem("Race", data?.raceStatus || "Unknown")}
        ${renderDiagnosticItem("Runners", data?.participantCount ?? runners.length)}
        ${renderDiagnosticItem("Source", freshness, freshnessClass)}
        ${renderDiagnosticItem("Fetched", formatDiagnosticTime(data?.fetchedAt))}
        ${renderDiagnosticItem("Last event", formatDiagnosticTime(data?.lastEventAt))}
      </div>
      ${
        diagnosticsError
          ? `<div class="diagnosticsError">${escapeHtml(diagnosticsError)}. Retaining the last successful diagnostics.</div>`
          : ""
      }
      ${
        data?.staleReason
          ? `<div class="diagnosticsWarning">${escapeHtml(data.staleReason)}</div>`
          : ""
      }
      <div class="diagnosticsTableWrap">
        <table class="diagnosticsTable">
          <thead>
            <tr>
              <th>Runner</th>
              <th>State</th>
              <th>Timing</th>
              <th>Parent splits</th>
              <th>Plan</th>
              <th>Comparison</th>
            </tr>
          </thead>
          <tbody>
            ${
              runners.length
                ? runners.map(renderDiagnosticRunner).join("")
                : `<tr><td colspan="6" class="diagnosticsEmpty">${
                    diagnosticsLoading ? "Loading race diagnostics..." : "No runner data available."
                  }</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderDiagnosticItem(label, value, valueClass = "") {
  return `
    <div class="diagnosticItem">
      <span>${escapeHtml(label)}</span>
      <strong class="${escapeHtml(valueClass)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderDiagnosticRunner(runner) {
  const planned = runner.plannedMainSplitCount ?? "?";
  const completed = runner.completedMainSplitCount ?? 0;
  const raw = runner.totalSplits != null ? ` (raw ${runner.totalSplits})` : "";
  const state = runner.isDisqualified ? "Disqualified" : runner.status || "Unknown";
  const comparisonClass = runner.comparisonStatus === "comparable" || runner.comparisonStatus === "leader"
    ? "ok"
    : runner.comparisonStatus === "timing method mismatch"
      ? "warn"
      : "muted";

  return `
    <tr>
      <td><span class="diagnosticRunnerName">${
        runner.streaming ? '<span class="diagnosticLiveDot" aria-label="Streaming"></span>' : ""
      }${escapeHtml(runner.username)}</span></td>
      <td>${escapeHtml(state)}</td>
      <td>${escapeHtml(runner.timingMethod || "Unknown")}</td>
      <td>${escapeHtml(`${completed}/${planned}${raw}`)}</td>
      <td>${escapeHtml(runner.splitPlanStatus || "unknown")}</td>
      <td><span class="${comparisonClass}">${escapeHtml(runner.comparisonStatus || "unknown")}</span></td>
    </tr>
  `;
}

function formatDiagnosticTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString();
}

function renderOverlayShell() {
  app.className = "app";

  if (!latestData && !lastError) {
    app.innerHTML = `
      <section class="overlay ${panelMode ? "overlayPanel" : ""} isLoading">
        <div class="statusLine"><span class="pulse"></span><span class="fancyText">Loading race...</span></div>
      </section>
    `;
    return;
  }

  if (lastError && !latestData) {
    app.innerHTML = `
      <section class="overlay ${panelMode ? "overlayPanel" : ""} hasError">
        <div class="statusLine"><span class="statusDot error"></span><span class="fancyText">${escapeHtml(
          lastError
        )}</span></div>
      </section>
    `;
    return;
  }

  const runners = latestData.runners.slice(0, limit);
  const titleSource = latestData.category || latestData.title || `Race ${latestData.raceId}`;
  const title = /\brace$/i.test(titleSource.trim()) ? titleSource : `${titleSource} Race`;
  const raceProgress = getLeaderRaceProgress(runners);
  const connectionWarning = lastError || (latestData.stale ? latestData.staleReason || "Using last good data" : "");

  app.innerHTML = `
    <section class="overlay ${panelMode ? "overlayPanel" : ""}">
      ${
        showTitle
          ? `<header class="overlayHeader">
              <div class="titleBlock">
                <div class="raceTitle fancyText">${escapeHtml(title)}</div>
                ${raceProgress ? `<div class="raceProgress fancyText">${escapeHtml(raceProgress)}</div>` : ""}
              </div>
            </header>`
          : ""
      }
      <div class="runnerList">
        ${runners.map(renderRunner).join("")}
      </div>
      ${
        connectionWarning
          ? `<span class="connectionWarning" title="${escapeHtml(connectionWarning)}" aria-label="${escapeHtml(
              connectionWarning
            )}"></span>`
          : ""
      }
    </section>
  `;

  pendingSplitHighlights.clear();
}

function renderRunner(runner) {
  const place = normalizePlace(runner.place);
  const rawCurrentTime = runner.currentTime || runner.status || "-";
  const latestSplit = runner.latestSplit;
  const splitName = latestSplit?.name || "No split yet";
  const splitTime = latestSplit?.time || "--";
  const percent = runner.percent && runner.percent !== "-" ? runner.percent : latestSplit?.percent || "-";
  const splitDetail = latestSplit ? `${splitTime} at ${splitName}` : "No split yet";
  const isFinished = runner.finalTimeMs != null || /^done$/i.test(runner.status || "");
  const isDisqualified = runner.isDisqualified === true || /disqual|dsq/i.test(`${runner.status} ${rawCurrentTime}`);
  const isAbandoned = isDisqualified || /abandoned/i.test(`${runner.status} ${rawCurrentTime}`);
  const disqualificationReason = String(runner.disqualificationReason || "").trim();
  const abandonedTimer = isAbandoned ? getTimerText(rawCurrentTime) : "";
  const currentTime = isAbandoned ? abandonedTimer || "-" : rawCurrentTime;
  const currentTimeClass = isAbandoned && currentTime !== "-" ? " isAbandoned" : "";
  const isReady = /^ready$/i.test(runner.status || "") && !latestSplit;
  const isNotReady = /^not ready$/i.test(runner.status || "") && !latestSplit;
  const isPreRaceStatus = isReady || isNotReady;
  const confirmation = runner.confirmationStatus === "confirmed" ? "confirmed" : "waiting for confirmation";
  const ratingDelta = runner.ratingDelta
    ? `<span class="runnerRatingDelta fancyText ${runner.ratingDelta.startsWith("-") ? "down" : "up"}">${escapeHtml(
        runner.ratingDelta
      )}</span>`
    : "";
  const rating = runner.rating
    ? `<sup class="runnerRating"><span class="runnerRatingValue fancyText">${escapeHtml(
        runner.rating
      )}</span>${ratingDelta}</sup>`
    : "";
  const deltaLabel = runner.raceDelta || (runner.isComparisonBaseline ? "Leader" : "-");
  const deltaClass = runner.raceDelta
    ? runner.raceDeltaMs < 0
      ? "ahead"
      : "behind"
    : runner.isComparisonBaseline
      ? "leader"
      : "empty";

  const highlightClass = pendingSplitHighlights.has(runner.username) ? " justSplit" : "";

  return `
    <article class="runner${highlightClass}">
      <div class="place"><span class="placeText fancyText">${escapeHtml(place)}</span></div>
      <div class="runnerInfo">
        <span class="runnerName">
          ${runner.streaming ? '<span class="streamingIndicator" aria-label="Live stream"></span>' : ""}
          <span class="runnerNameText fancyText">${escapeHtml(runner.username)}</span>
          ${rating}
        </span>
        ${
          isAbandoned || isFinished || isPreRaceStatus
            ? `<span class="splitMeta isOutcome">
                <span class="outcomeDetail">
                  <span class="outcomeLabel ${
                    isAbandoned
                      ? "isAbandoned"
                      : isPreRaceStatus
                        ? isReady
                          ? "isReady"
                          : "isNotReady"
                        : "isFinished"
                  } fancyText">${escapeHtml(isDisqualified ? "Disqualified" : isAbandoned ? "Abandoned" : isPreRaceStatus ? runner.status : "Finished")}</span>
                  ${
                    isDisqualified
                      ? `<span class="outcomeConfirmation fancyText">(${escapeHtml(
                          disqualificationReason || "no reason given"
                        )})</span>`
                      : isPreRaceStatus || isAbandoned
                        ? ""
                        : `<span class="outcomeConfirmation fancyText">(${escapeHtml(confirmation)})</span>`
                  }
                </span>
              </span>`
            : `<span class="splitMeta">
                <span class="splitPercent fancyText">${escapeHtml(percent)}</span>
                <span class="splitDetail fancyText">${escapeHtml(splitDetail)}</span>
              </span>`
        }
      </div>
      <div class="runnerStats">
        <div class="timingLine">
          <div class="raceDelta fancyText ${deltaClass}">${escapeHtml(deltaLabel)}</div>
          <span class="currentTime fancyText${currentTimeClass}">${escapeHtml(currentTime)}</span>
        </div>
      </div>
    </article>
  `;
}

async function refreshRace() {
  if (loading) return;
  loading = true;

  try {
    const endpoint = fixedRaceInput
      ? `/api/race?race=${encodeURIComponent(fixedRaceInput)}`
      : "/api/race";
    const data = await fetchJson(endpoint);
    pendingSplitHighlights = detectParentSplitChanges(latestData, data);
    latestData = data;
    lastError = null;
  } catch (error) {
    lastError = error.message || String(error);
  } finally {
    loading = false;
    renderOverlayShell();
  }
}

function detectParentSplitChanges(previousData, nextData) {
  if (!previousData?.runners?.length || !nextData?.runners?.length || nextData.stale) return new Set();

  const previousByName = new Map(previousData.runners.map((runner) => [runner.username, runner]));
  const changed = new Set();
  for (const runner of nextData.runners) {
    const previous = previousByName.get(runner.username);
    if (!previous) continue;
    const previousCount = Number(previous.completedMainSplitCount) || 0;
    const nextCount = Number(runner.completedMainSplitCount) || 0;
    if (nextCount > previousCount) changed.add(runner.username);
  }
  return changed;
}

function getLeaderRaceProgress(runners) {
  const leader = runners.find((runner) => runner.isComparisonBaseline) || runners[0];
  const total = Number(leader?.plannedMainSplitCount);
  if (!leader || !Number.isFinite(total) || total <= 0) return "";

  const finished = leader.finalTimeMs != null || /^done$/i.test(leader.status || "");
  const completed = finished ? total : clamp(Number(leader.completedMainSplitCount) || 0, 0, total);
  return `Split ${completed}/${total}`;
}

function normalizePlace(value) {
  const clean = String(value || "-").replace(/\.$/, "").trim();
  if (!clean || clean === "-") return "-";
  return clean.startsWith("#") ? clean : `#${clean}`;
}

function getTimerText(value) {
  const match = String(value || "")
    .trim()
    .match(/(\d+:)?\d{1,2}:\d{2}(?:\.\d+)?/);
  return match ? match[0].replace(/\.\d+$/, "") : "";
}

function isEnabledParam(value, defaultValue) {
  if (value == null || value === "") return defaultValue;
  const raw = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(raw)) return false;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  return defaultValue;
}

function getFirstParam(names) {
  for (const name of names) {
    const value = params.get(name);
    if (value != null && value !== "") return value;
  }
  return "";
}

function normalizeFontSizeParam(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  const unitless = raw.match(/^(\d+(?:\.\d+)?)$/);
  if (unitless) {
    return `${clamp(Number(unitless[1]), 8, 32)}px`;
  }

  const withUnit = raw.match(/^(\d+(?:\.\d+)?)(px|rem|em)$/i);
  if (!withUnit) return fallback;

  const size = Number(withUnit[1]);
  const unit = withUnit[2].toLowerCase();
  const clamped = unit === "px" ? clamp(size, 8, 32) : clamp(size, 0.5, 2);
  return `${clamped}${unit}`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function toRenderedPixelSize(pixels) {
  return `${Number((pixels / renderZoom).toFixed(4))}px`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}
