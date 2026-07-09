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
const overlayWidth = widthParam ? clamp(Number(widthParam), 120, 2400) : defaultOverlayWidth;
const renderZoom = clamp(Number(params.get("zoom")) || Number(params.get("scale")) || 3, 1, 4);
const titleFontSize = normalizeFontSizeParam(
  getFirstParam(["TitleFontSize", "titleFontSize", "titlefontsize", "title-font-size"]),
  "13px"
);
const isControlPage = window.location.pathname === "/control" || window.location.pathname === "/";

let latestData = null;
let lastError = null;
let loading = false;
let pollTimer = null;
let controlState = null;

document.documentElement.dataset.theme = theme;
document.documentElement.style.setProperty("--overlay-width", `${overlayWidth}px`);
document.documentElement.style.setProperty("--render-zoom", renderZoom);
document.documentElement.style.setProperty("--title-font-size", titleFontSize);

if (isControlPage) {
  renderControl();
  loadCurrentRace();
} else {
  renderOverlayShell();
  refreshRace();
  pollTimer = window.setInterval(refreshRace, pollMs);
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) window.clearInterval(pollTimer);
});

function renderControl(message = "") {
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
            current?.sourceUrl || ""
          )}" />
          <button type="submit">${controlState?.saving ? "Saving..." : "Set Race"}</button>
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
      ${message ? `<div class="controlMessage">${escapeHtml(message)}</div>` : ""}
    </section>
  `;

  app.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("race");
    if (!value) return;
    await saveCurrentRace(value);
  });
}

async function loadCurrentRace() {
  try {
    const response = await fetch("/api/current-race", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    controlState = data;
    renderControl();
  } catch (error) {
    controlState = { ok: false, currentRace: null };
    renderControl(error.message || String(error));
  }
}

async function saveCurrentRace(race) {
  controlState = { ...(controlState || {}), saving: true };
  renderControl();

  try {
    const response = await fetch("/api/current-race", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ race }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    controlState = { ok: true, currentRace: data.currentRace };
    renderControl("Race updated. OBS will refresh on its next poll.");
  } catch (error) {
    controlState = { ...(controlState || {}), saving: false };
    renderControl(error.message || String(error));
  }
}

function renderOverlayShell() {
  app.className = "app";

  if (!latestData && !lastError) {
    app.innerHTML = `
      <section class="overlay ${panelMode ? "overlayPanel" : ""} isLoading">
        <div class="statusLine"><span class="pulse"></span><span>Loading race...</span></div>
      </section>
    `;
    return;
  }

  if (lastError && !latestData) {
    app.innerHTML = `
      <section class="overlay ${panelMode ? "overlayPanel" : ""} hasError">
        <div class="statusLine"><span class="statusDot error"></span><span>${escapeHtml(lastError)}</span></div>
      </section>
    `;
    return;
  }

  const runners = latestData.runners.slice(0, limit);
  const title = `${latestData.category || latestData.title || `Race ${latestData.raceId}`} Race`;

  app.innerHTML = `
    <section class="overlay ${panelMode ? "overlayPanel" : ""}">
      ${
        showTitle
          ? `<header class="overlayHeader">
              <div class="titleBlock">
                <div class="raceTitle">${escapeHtml(title)}</div>
              </div>
            </header>`
          : ""
      }
      <div class="runnerList">
        ${runners.map(renderRunner).join("")}
      </div>
      ${lastError ? `<div class="softError">${escapeHtml(lastError)}</div>` : ""}
    </section>
  `;
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
  const isAbandoned = /abandoned/i.test(`${runner.status} ${rawCurrentTime}`);
  const abandonedTimer = isAbandoned ? getTimerText(rawCurrentTime) : "";
  const currentTime = isAbandoned ? abandonedTimer || "-" : rawCurrentTime;
  const currentTimeClass = isAbandoned && currentTime !== "-" ? " isAbandoned" : "";
  const isReady = /^ready$/i.test(runner.status || "") && !latestSplit;
  const isNotReady = /^not ready$/i.test(runner.status || "") && !latestSplit;
  const isPreRaceStatus = isReady || isNotReady;
  const confirmation = runner.confirmationStatus === "confirmed" ? "confirmed" : "waiting for confirmation";
  const isDnf = /dnf|abandoned|forfeit/i.test(`${runner.status} ${runner.currentTime}`);
  const ratingDelta = runner.ratingDelta
    ? `<span class="runnerRatingDelta ${runner.ratingDelta.startsWith("-") ? "down" : "up"}">${escapeHtml(
        runner.ratingDelta
      )}</span>`
    : "";
  const rating = runner.rating ? `<sup class="runnerRating">${escapeHtml(runner.rating)}${ratingDelta}</sup>` : "";
  const deltaLabel = runner.raceDelta || (runner.isComparisonBaseline ? "Leader" : "-");
  const deltaClass = runner.raceDelta
    ? runner.raceDeltaMs < 0
      ? "ahead"
      : "behind"
    : runner.isComparisonBaseline
      ? "leader"
      : "empty";

  return `
    <article class="runner ${isDnf ? "isDnf" : ""}">
      <div class="place">${escapeHtml(place)}</div>
      <div class="runnerInfo">
        <span class="runnerName">
          <span class="runnerNameText">${escapeHtml(runner.username)}</span>
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
                  }">${escapeHtml(isAbandoned ? "Abandoned" : isPreRaceStatus ? runner.status : "Finished")}</span>
                  ${isPreRaceStatus ? "" : `<span class="outcomeConfirmation">(${escapeHtml(confirmation)})</span>`}
                </span>
              </span>`
            : `<span class="splitMeta">
                <span class="splitPercent">${escapeHtml(percent)}</span>
                <span class="splitDetail">${escapeHtml(splitDetail)}</span>
              </span>`
        }
      </div>
      <div class="runnerStats">
        <div class="timingLine">
          <div class="raceDelta ${deltaClass}">${escapeHtml(deltaLabel)}</div>
          <span class="currentTime${currentTimeClass}">${escapeHtml(currentTime)}</span>
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
      ? `/api/race?race=${encodeURIComponent(fixedRaceInput)}&now=${Date.now()}`
      : `/api/race?now=${Date.now()}`;
    const response = await fetch(endpoint, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    latestData = data;
    lastError = null;
  } catch (error) {
    lastError = error.message || String(error);
  } finally {
    loading = false;
    renderOverlayShell();
  }
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

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[char];
  });
}
