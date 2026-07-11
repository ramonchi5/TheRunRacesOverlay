const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const STATE_FILE = path.join(ROOT, ".overlay-state.json");
const APP_VERSION = "2.0.2";
const DEFAULT_PORT = 5179;
const CACHE_TTL_MS = 750;
const ERROR_RETRY_MS = 3000;
const SPLIT_PLAN_CACHE_TTL_MS = 10 * 60 * 1000;
const SPLIT_PLAN_FAILURE_TTL_MS = 30 * 1000;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_SPLITS_FILE_BYTES = 32 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;

const cache = new Map();
const inFlightRaceRequests = new Map();
const splitPlanCache = new Map();
let currentRace = readState();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return fallback;
}

const port = Number(process.env.PORT || getArg("--port", DEFAULT_PORT));

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(raw);
    return state && state.raceId ? state : null;
  } catch {
    return null;
  }
}

function writeState(state) {
  currentRace = state;
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeRaceInput(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("Missing race. Add ?race=16c4 or ?race=https://therun.gg/races/16c4");
  }

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (!/(^|\.)therun\.gg$/i.test(url.hostname)) {
      throw new Error("Only therun.gg race URLs are supported.");
    }
    const match = url.pathname.match(/^\/races\/([^/?#]+)/i);
    if (!match) {
      throw new Error("That therun.gg URL does not look like a race page.");
    }
    return match[1];
  }

  const match = raw.match(/^(?:races\/)?([a-z0-9_-]+)$/i);
  if (!match) {
    throw new Error("Race id was not recognized.");
  }
  return match[1];
}

function getCurrentRaceId() {
  return currentRace?.raceId || null;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readRaceFromRequest(req) {
  const rawBody = await readRequestBody(req);
  if (!rawBody.trim()) return "";

  const contentType = req.headers["content-type"] || "";
  if (!contentType.includes("application/json")) {
    throw new Error("Race updates require an application/json request.");
  }

  const body = JSON.parse(rawBody);
  return body.race || body.url || "";
}

function fetchText(url, redirectsLeft = 4, maxResponseBytes = MAX_RESPONSE_BYTES) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "Cache-Control": "no-cache",
          "User-Agent": `therun-obs-overlay/${APP_VERSION} (+local OBS browser source)`,
        },
        timeout: 15000,
      },
      (response) => {
        const location = response.headers.location;
        if (location && response.statusCode >= 300 && response.statusCode < 400) {
          response.resume();
          if (redirectsLeft <= 0) {
            reject(new Error("Too many redirects while fetching race page."));
            return;
          }
          resolve(fetchText(new URL(location, url).toString(), redirectsLeft - 1, maxResponseBytes));
          return;
        }

        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`therun.gg returned HTTP ${response.statusCode}`));
          return;
        }

        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > maxResponseBytes) {
            request.destroy(new Error("Remote response was unexpectedly large."));
          }
        });
        response.on("end", () => resolve(body));
      }
    );

    request.on("timeout", () => request.destroy(new Error("Timed out while fetching race page.")));
    request.on("error", reject);
  });
}

async function getRaceData(raceId) {
  return getCachedRaceData(raceId, () => fetchRaceData(raceId));
}

async function getCachedRaceData(raceId, loader) {
  const cacheKey = raceId;
  const cached = cache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.time < CACHE_TTL_MS) {
    return cached.data;
  }

  if (cached?.failureTime && now - cached.failureTime < ERROR_RETRY_MS) {
    return makeStaleRaceData(cached.data, cached.lastError);
  }

  const inFlight = inFlightRaceRequests.get(cacheKey);
  if (inFlight) return inFlight;

  const request = (async () => {
    try {
      const data = await loader();
      cache.set(cacheKey, { time: Date.now(), data, failureTime: null, lastError: "" });
      return data;
    } catch (error) {
      if (!cached?.data) throw error;
      cached.failureTime = Date.now();
      cached.lastError = error.message || String(error);
      cache.set(cacheKey, cached);
      return makeStaleRaceData(cached.data, cached.lastError);
    }
  })();

  inFlightRaceRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (inFlightRaceRequests.get(cacheKey) === request) {
      inFlightRaceRequests.delete(cacheKey);
    }
  }
}

async function fetchRaceData(raceId) {
  const sourceUrl = `https://therun.gg/races/${encodeURIComponent(raceId)}`;
  const html = await fetchText(sourceUrl);
  const embeddedPageData = parseEmbeddedPageData(html, raceId);
  const splitPlansByRunner = await getRaceSplitPlans(embeddedPageData.race);
  return parseRaceHtml(html, raceId, sourceUrl, { embeddedPageData, splitPlansByRunner });
}

function makeStaleRaceData(data, error) {
  return {
    ...data,
    stale: true,
    staleReason: error || "TheRun data is temporarily unavailable.",
    servedAt: new Date().toISOString(),
  };
}

async function getRaceSplitPlans(race) {
  if (!race?.participants?.length) return new Map();
  const game = String(race.displayGame || race.game || "").trim();
  const category = String(race.displayCategory || race.category || "").trim();
  if (!game || !category) return new Map();

  const nestedParticipants = race.participants
    .filter((participant) => participant.visible !== false)
    .filter(participantUsesSubsplits);
  const plans = await Promise.all(
    nestedParticipants.map(async (participant) => {
      const plan = await getRunnerSplitPlan(participant.user, game, category);
      return plan ? [normalizeEventUsername(participant.user), plan] : null;
    })
  );

  return new Map(plans.filter(Boolean));
}

function participantUsesSubsplits(participant) {
  const liveData = participant?.liveData || {};
  const predictions = liveData.splitPredictions || participant?.splitPredictions || [];
  const names = [
    ...predictions.map((prediction) => prediction?.splitName),
    liveData.currentSplitName,
    liveData.previousSplitName,
  ];
  return names.some((name) => {
    const parsed = parseSplitLabel(name);
    return parsed.subIndex != null && parsed.total != null;
  });
}

async function getRunnerSplitPlan(username, game, category) {
  const cacheKey = `${normalizeEventUsername(username)}\u0000${game}\u0000${category}`;
  const cached = splitPlanCache.get(cacheKey);
  if (cached && Date.now() - cached.time < cached.ttl) return cached.plan;

  try {
    const runUrl = `https://therun.gg/${encodeURIComponent(username)}/${encodeURIComponent(game)}/${encodeURIComponent(category)}`;
    const runHtml = await fetchText(runUrl);
    const splitsFile = parseSplitsFilePath(runHtml);
    if (!splitsFile) throw new Error("No public splits file was found for this run.");

    const splitFileText = await fetchFirstAvailableText(getSplitsFileUrls(splitsFile), MAX_SPLITS_FILE_BYTES);
    const segmentNames = parseLiveSplitSegmentNames(splitFileText);
    const profile = buildSplitProfile(segmentNames.map((rawName) => ({ rawName })));
    if (!profile.mainSplitCount) throw new Error("The public splits file did not contain recognizable segments.");

    const plan = {
      mainSplitCount: profile.mainSplitCount,
      rawSplitCount: segmentNames.length,
      hasNestedSplits: profile.hasNestedSplits,
      splitsFile,
    };
    splitPlanCache.set(cacheKey, { time: Date.now(), ttl: SPLIT_PLAN_CACHE_TTL_MS, plan });
    return plan;
  } catch {
    splitPlanCache.set(cacheKey, { time: Date.now(), ttl: SPLIT_PLAN_FAILURE_TTL_MS, plan: null });
    return null;
  }
}

function parseSplitsFilePath(html) {
  const flightRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  for (const match of html.matchAll(flightRegex)) {
    const decoded = parseJsonString(match[1]);
    const splitsFileMatch = decoded.match(/"splitsFile":"([^"]+\.lss)"/i);
    if (splitsFileMatch) return decodeJsonStringValue(splitsFileMatch[1]);
  }
  return "";
}

function decodeJsonStringValue(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

function getSplitsFileUrls(splitsFile) {
  let decodedPath = splitsFile;
  try {
    decodedPath = decodeURIComponent(splitsFile);
  } catch {
    // Keep the original path if it contains malformed percent encoding.
  }
  const primaryPath = decodedPath
    .replaceAll("%", "%25")
    .replaceAll("+++", "+%2B+")
    .replaceAll("++", "%2B+")
    .replaceAll("NG+", "NG%2B");
  const baseUrl = "https://d2c9jb6sm40v74.cloudfront.net/";
  return [`${baseUrl}${primaryPath}`, `${baseUrl}${primaryPath.replaceAll("+", "%2B")}`];
}

async function fetchFirstAvailableText(urls, maxResponseBytes = MAX_RESPONSE_BYTES) {
  let lastError = null;
  for (const url of urls) {
    try {
      return await fetchText(url, 4, maxResponseBytes);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Could not download the public splits file.");
}

function parseLiveSplitSegmentNames(xml) {
  const names = [];
  for (const segmentMatch of xml.matchAll(/<Segment\b[^>]*>([\s\S]*?)<\/Segment>/gi)) {
    const nameMatch = segmentMatch[1].match(/<Name\b[^>]*>([\s\S]*?)<\/Name>/i);
    if (!nameMatch) continue;
    const rawName = nameMatch[1].replace(/^<!\[CDATA\[|\]\]>$/g, "");
    const name = decodeEntities(rawName).trim();
    if (name) names.push(name);
  }
  return names;
}

function parseRaceHtml(html, raceId, sourceUrl, options = {}) {
  const embeddedPageData = options.embeddedPageData || parseEmbeddedPageData(html, raceId);
  const embeddedRace = embeddedPageData.race;
  const raceEventIndex = buildRaceEventIndex(embeddedPageData.events);
  const metadata = parseMetadata(html);
  const visibleParticipantNames = embeddedRace?.participants?.length
    ? new Set(
        embeddedRace.participants
          .filter((participant) => participant.visible !== false)
          .map((participant) => normalizeEventUsername(participant.user))
      )
    : null;
  const embeddedRunners = parseEmbeddedParticipants(
    embeddedRace,
    raceEventIndex,
    options.splitPlansByRunner || new Map()
  );
  const standings = parseStandings(html);
  const cards = parseParticipantCards(html);
  const profilesByRunner = needsChatProfileFallback(embeddedRunners)
    ? buildProfilesByRunner(parseSplitRows(html, raceEventIndex))
    : new Map();

  const runnersByName = new Map();
  const addRunner = (runner) => {
    if (!runner || !runner.username) return;
    const existing = runnersByName.get(runner.username) || {};
    const merged = { ...existing };
    for (const [key, value] of Object.entries(runner)) {
      if ((value === "" || value == null) && existing[key] != null && existing[key] !== "") continue;
      merged[key] = value;
    }
    runnersByName.set(runner.username, merged);
  };

  standings.forEach(addRunner);
  cards.forEach(addRunner);
  embeddedRunners.forEach(addRunner);

  for (const [username, fallbackProfile] of profilesByRunner) {
    const existing = runnersByName.get(username) || { username };
    const profile = existing.splitProfile?.units?.length ? existing.splitProfile : fallbackProfile;
    const latestSplit = profile.units.at(-1) || null;
    runnersByName.set(username, {
      ...existing,
      latestSplit,
      splitProfile: profile,
      plannedMainSplitCount: existing.plannedMainSplitCount ?? getReliableMainSplitCount(existing, profile),
      percent: existing.percent || latestSplit?.percent,
    });
  }

  const preferredOrder = cards.length ? cards : standings.length ? standings : embeddedRunners;
  const orderedNames = preferredOrder.map((runner) => runner.username);
  const orderedNameSet = new Set(orderedNames);
  const leftovers = [...runnersByName.keys()].filter((name) => !orderedNameSet.has(name));
  const runners = [...orderedNames, ...leftovers]
    .map((name) => runnersByName.get(name))
    .filter(Boolean)
    .filter(
      (runner) =>
        !visibleParticipantNames || visibleParticipantNames.has(normalizeEventUsername(runner.username))
    )
    .map((runner) => {
      const normalizedRating = normalizeRatingForDisplay(runner);
      const isDisqualified = isDisqualifiedRunner(runner);
      const status = isDisqualified ? "Abandoned" : runner.status || inferStatus(runner.currentTime);
      const currentTime = normalizeCurrentTimeForDisplay(runner.currentTime, status);
      return {
        place: runner.place || "-",
        username: runner.username,
        rating: normalizedRating.rating,
        ratingDelta: normalizedRating.ratingDelta,
        percent: runner.percent || runner.latestSplit?.percent || "-",
        status,
        currentTime: currentTime || normalizeStatusTime(status) || "-",
        timingMethod: runner.timingMethod || "",
        streaming: runner.streaming === true,
        isDisqualified,
        disqualificationReason: runner.disqualificationReason || "",
        finalTimeMs: runner.finalTimeMs ?? null,
        abandonedAtMs: runner.abandonedAtMs ?? null,
        totalSplits: runner.totalSplits ?? null,
        plannedMainSplitCount: runner.plannedMainSplitCount ?? null,
        completedMainSplitCount: runner.completedMainSplitCount ?? runner.splitProfile?.units?.length ?? 0,
        splitPlanStatus: runner.splitPlanStatus || "unknown",
        joinOrder: runner.joinOrder ?? null,
        joinedAtMs: runner.joinedAtMs ?? null,
        isRaceCreator: runner.isRaceCreator === true,
        confirmationStatus: runner.confirmationStatus || "",
        latestSplit: runner.latestSplit || null,
        splitProfile: runner.splitProfile || null,
      };
    });

  if (!runners.length) {
    throw new Error("Could not find runners in the therun.gg race page.");
  }

  const rankedRunners = applyRaceComparisons(runners);

  return {
    ok: true,
    version: APP_VERSION,
    raceId,
    sourceUrl,
    title: metadata.title,
    game: metadata.game,
    category: metadata.category,
    raceStatus: embeddedRace?.status || "",
    participantCount: runners.length,
    lastEventAt: getLatestEventTimestamp(embeddedPageData.events),
    fetchedAt: new Date().toISOString(),
    stale: false,
    staleReason: "",
    runners: rankedRunners,
  };
}

function getLatestEventTimestamp(events) {
  let latestMs = null;
  let latestValue = "";
  for (const event of events || []) {
    const eventMs = dateToMillis(event.time);
    if (eventMs != null && (latestMs == null || eventMs > latestMs)) {
      latestMs = eventMs;
      latestValue = event.time;
    }
  }
  return latestValue;
}

function normalizeRatingForDisplay(runner) {
  const rating = String(runner.rating || "").trim();
  const ratingDelta = String(runner.ratingDelta || "").trim();
  const hasOutcome = isFinishedRunner(runner) || isAbandonedRunner(runner);

  if (hasOutcome) {
    return { rating, ratingDelta };
  }

  if (rating === "0" && /^-\d+$/.test(ratingDelta)) {
    return { rating: ratingDelta.slice(1), ratingDelta: "" };
  }

  return { rating, ratingDelta: "" };
}

function needsChatProfileFallback(runners) {
  return !runners.length || runners.some((runner) => !runner.splitProfile?.units?.length);
}

function parseMetadata(html) {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = decodeEntities((ogTitle && ogTitle[1]) || (titleTag && titleTag[1]) || "TheRun race");
  const cleanTitle = rawTitle.replace(/^The Run\s*\|\s*Race for\s*/i, "").trim();
  const [game, ...categoryParts] = cleanTitle.split(" - ");

  return {
    title: cleanTitle,
    game: game || cleanTitle,
    category: categoryParts.join(" - "),
  };
}

function parseEmbeddedPageData(html, raceId) {
  let race = null;
  const events = [];
  const eventKeys = new Set();
  const flightRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  for (const match of html.matchAll(flightRegex)) {
    const decoded = parseJsonString(match[1]);
    if (!decoded) continue;

    const jsonStart = decoded.indexOf("[");
    if (jsonStart < 0) continue;

    try {
      const payload = JSON.parse(decoded.slice(jsonStart).trim());
      if (!race) race = findRacePayload(payload);
      collectRaceEvents(payload, raceId, events, eventKeys);
    } catch {
      // Fall through to the older HTML scrapers.
    }
  }
  return { race, events };
}

function parseJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return "";
  }
}

function findRacePayload(value) {
  if (!value || typeof value !== "object") return null;
  if (value.race?.participants) return value.race;
  if (Array.isArray(value)) {
    for (const item of value) {
      const race = findRacePayload(item);
      if (race) return race;
    }
    return null;
  }
  for (const item of Object.values(value)) {
    const race = findRacePayload(item);
    if (race) return race;
  }
  return null;
}

function collectRaceEvents(value, raceId, events, eventKeys) {
  if (!value || typeof value !== "object") return;

  if (
    value.raceId === raceId &&
    typeof value.type === "string" &&
    value.time &&
    (value.data == null || typeof value.data === "object")
  ) {
    const eventKey = `${value.type}\u0000${value.time}\u0000${JSON.stringify(value.data || {})}`;
    if (!eventKeys.has(eventKey)) {
      eventKeys.add(eventKey);
      events.push(value);
    }
  }

  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) collectRaceEvents(child, raceId, events, eventKeys);
}

function parseEmbeddedParticipants(
  race,
  raceEventIndex = buildRaceEventIndex([]),
  splitPlansByRunner = new Map()
) {
  if (!race?.participants?.length) return [];
  const raceStartMs = dateToMillis(race.startTime);
  const visibleParticipants = race.participants.filter((participant) => participant.visible !== false);
  return visibleParticipants.map((participant, index) => {
    const liveData = participant.liveData || {};
    const splitPredictions = liveData.splitPredictions || participant.splitPredictions || [];
    const totalSplits = liveData.totalSplits ?? participant.totalSplits;
    const rawFinalTimeMs = numberOrNull(participant.finalTime);
    const splitRows = rowsFromSplitPredictions(
      splitPredictions,
      totalSplits,
      raceEventIndex,
      participant.user,
      rawFinalTimeMs,
      liveData
    );
    const profile = buildSplitProfile(splitRows);
    const currentTimeMs = numberOrNull(liveData.currentTime);
    const abandonedAtMs = getParticipantAbandonedAtMs(participant);
    const abandonedRaceTimeMs = getParticipantAbandonedRaceTimeMs(participant, liveData, abandonedAtMs, raceStartMs);
    const isDisqualified = Boolean(participant.disqualified);
    const disqualificationReason = cleanDisqualificationReason(participant.disqualifiedReason);
    const isFinished = isEmbeddedFinished(participant, liveData, rawFinalTimeMs);
    const finalTimeMs = isFinished ? rawFinalTimeMs || currentTimeMs || null : null;
    const displayTimeMs = isFinished ? finalTimeMs : abandonedRaceTimeMs;
    const status = getEmbeddedStatus(participant, isFinished, abandonedAtMs, liveData, profile);
    const ratingBefore = numberOrNull(participant.ratingBefore);
    const ratingAfter = numberOrNull(participant.ratingAfter);
    const hasRatingOutcome = isFinished || abandonedAtMs != null;
    const hasPostRaceRating = hasRatingOutcome && ratingAfter > 0;
    const displayRating = hasPostRaceRating ? ratingAfter : ratingBefore > 0 ? ratingBefore : "";
    const ratingDelta = hasPostRaceRating && ratingBefore > 0 ? ratingAfter - ratingBefore : null;
    const usesSubsplits = participantUsesSubsplits(participant);
    const splitPlan = splitPlansByRunner.get(normalizeEventUsername(participant.user));
    const plannedSplitCount = getMatchingPlannedMainSplitCount(splitPlan, totalSplits);
    const splitPlanStatus = !usesSubsplits
      ? "not required"
      : !splitPlan
        ? "unavailable"
        : plannedSplitCount
          ? "matched"
          : "raw count mismatch";

    return {
      place: "",
      username: participant.user || "",
      rating: displayRating === "" ? "" : String(displayRating),
      ratingDelta: ratingDelta == null ? "" : `${ratingDelta >= 0 ? "+" : ""}${ratingDelta}`,
      percent: getRunnerPercent(liveData, profile, isFinished),
      status,
      currentTime: displayTimeMs != null ? millisToTime(displayTimeMs) : "",
      timingMethod: getTimingMethod(liveData, race),
      streaming: liveData.streaming === true || participant.streaming === true,
      isDisqualified,
      disqualificationReason,
      finalTimeMs,
      abandonedAtMs,
      totalSplits: numberOrNull(totalSplits),
      plannedMainSplitCount:
        plannedSplitCount || getReliableMainSplitCount({ finalTimeMs, status }, profile),
      completedMainSplitCount: profile.units.length,
      splitPlanStatus,
      joinOrder: index,
      joinedAtMs: dateToMillis(participant.joinedAtDate),
      isRaceCreator: participant.user === race.creator,
      confirmationStatus: getConfirmationStatus(participant, race, isFinished),
      latestSplit: profile.units.at(-1) || null,
      splitProfile: profile,
    };
  });
}

function getTimingMethod(liveData, race) {
  if (liveData?.gameTime === true) return "IGT";
  if (liveData?.gameTime === false) return "RTA";
  if (race?.gameTime === true) return "IGT";
  if (race?.gameTime === false) return "RTA";
  return "";
}

function getMatchingPlannedMainSplitCount(splitPlan, totalSplits) {
  if (!splitPlan?.mainSplitCount) return null;
  const rawTotalSplitCount = numberOrNull(totalSplits);
  if (rawTotalSplitCount != null && splitPlan.rawSplitCount !== rawTotalSplitCount) return null;
  return splitPlan.mainSplitCount;
}

function rowsFromSplitPredictions(
  predictions,
  totalSplits,
  raceEventIndex = buildRaceEventIndex([]),
  username = "",
  finalTimeMs = null,
  liveData = null
) {
  const byIndex = new Map();
  const currentSplitIndex = numberOrNull(liveData?.currentSplitIndex);
  const currentSplitArrivalMs = absoluteTimestampToMillis(liveData?.splitStartedAt);
  for (const prediction of predictions) {
    const splitIndex = numberOrNull(prediction.splitIndex);
    const currentTime = numberOrNull(prediction.currentTime);
    const splitName = String(prediction.splitName || "").trim();
    if (splitIndex == null || currentTime == null || currentTime <= 0 || !splitName) continue;
    const indexedArrivalMs = getRaceEventArrivalTimeMs(
      raceEventIndex,
      username,
      currentTime,
      splitName,
      finalTimeMs
    );
    const liveArrivalMs = splitIndex === currentSplitIndex ? currentSplitArrivalMs : null;
    byIndex.set(splitIndex, {
      ...prediction,
      arrivalTimeMs: indexedArrivalMs ?? liveArrivalMs,
    });
  }

  return [...byIndex.values()]
    .sort((a, b) => Number(a.splitIndex) - Number(b.splitIndex))
    .map((prediction) => {
      const splitIndex = numberOrNull(prediction.splitIndex);
      const currentTime = numberOrNull(prediction.currentTime);
      return {
        rawName: prediction.splitName,
        time: millisToTime(currentTime),
        preciseTime: millisToTime(currentTime, true),
        timeMs: currentTime,
        arrivalTimeMs: numberOrNull(prediction.arrivalTimeMs),
        percent: splitPercent(splitIndex, totalSplits),
      };
    });
}

function buildRaceEventIndex(events) {
  const splitArrivals = new Map();
  const finishArrivals = new Map();

  for (const event of events || []) {
    const arrivalTimeMs = dateToMillis(event.time);
    const username = String(event.data?.user || "").trim();
    const splitTimeMs = numberOrNull(event.data?.time);
    if (arrivalTimeMs == null || !username || splitTimeMs == null) continue;

    if (event.type === "participant-split") {
      const splitName = String(event.data?.splitName || "").trim();
      if (!splitName) continue;
      splitArrivals.set(splitEventKey(username, splitTimeMs, splitName), arrivalTimeMs);
    }

    if (event.type === "participant-finish") {
      finishArrivals.set(finishEventKey(username, splitTimeMs), arrivalTimeMs);
    }
  }

  return { splitArrivals, finishArrivals };
}

function getRaceEventArrivalTimeMs(index, username, splitTimeMs, splitName, finalTimeMs = null) {
  const splitArrival = index?.splitArrivals?.get(splitEventKey(username, splitTimeMs, splitName));
  if (splitArrival != null) return splitArrival;

  if (finalTimeMs != null && Math.abs(splitTimeMs - finalTimeMs) <= 1) {
    return index?.finishArrivals?.get(finishEventKey(username, finalTimeMs)) ?? null;
  }
  return null;
}

function splitEventKey(username, splitTimeMs, splitName) {
  return `${normalizeEventUsername(username)}\u0000${Math.round(splitTimeMs)}\u0000${normalizeEventSplitName(splitName)}`;
}

function finishEventKey(username, splitTimeMs) {
  return `${normalizeEventUsername(username)}\u0000${Math.round(splitTimeMs)}`;
}

function normalizeEventUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEventSplitName(value) {
  return cleanTimeText(value).toLowerCase();
}

function isEmbeddedFinished(participant, liveData, rawFinalTimeMs) {
  const status = String(participant.status || "").trim().toLowerCase();
  return (
    liveData.runFinished === true ||
    rawFinalTimeMs > 0 ||
    Boolean(participant.confirmedAtDate) ||
    ["done", "finished", "confirmed"].includes(status)
  );
}

function getEmbeddedStatus(participant, isFinished, abandonedAtMs, liveData, profile) {
  const status = String(participant.status || "").trim().toLowerCase();
  if (participant.disqualified) return "Abandoned";
  if (abandonedAtMs != null || /abandoned/i.test(participant.status || "")) return "Abandoned";
  if (isFinished) return "Done";
  if (status === "ready") return "Ready";
  if (status === "racing" || status === "running" || status === "started") return "Racing";
  if (hasRunActivity(liveData, profile)) return "Racing";
  return "Not Ready";
}

function hasRunActivity(liveData, profile) {
  const currentTime = numberOrNull(liveData.currentTime);
  const progress = numberOrNull(liveData.runPercentageSplits);
  return currentTime > 0 || progress > 0 || Boolean(profile?.units?.length);
}

function getConfirmationStatus(participant, race, isFinished) {
  if (!isFinished) return "";
  if (participant.confirmedAtDate || participant.status === "confirmed" || race.autoConfirm) return "confirmed";
  return "waiting for confirmation";
}

function getParticipantAbandonedAtMs(participant) {
  return dateToMillis(participant.abandondedAtDate || participant.abandonedAtDate || participant.forfeitedAtDate);
}

function getParticipantAbandonedRaceTimeMs(participant, liveData, abandonedAtMs, raceStartMs = null) {
  const explicitValue = participant.abandonedTime || participant.abandondedTime || participant.forfeitedTime;
  const explicitTime = timeToMillis(explicitValue);
  if (explicitTime != null) return explicitTime;
  const explicitMs = numberOrNull(explicitValue);
  if (explicitMs != null && explicitMs >= 0) return explicitMs;

  const startedAtMs = getLiveDataStartedAtMs(liveData) ?? raceStartMs;
  if (abandonedAtMs == null || startedAtMs == null) return null;

  const elapsedMs = abandonedAtMs - startedAtMs;
  const maxReasonableRaceMs = 72 * 60 * 60 * 1000;
  return elapsedMs >= 0 && elapsedMs <= maxReasonableRaceMs ? elapsedMs : null;
}

function getLiveDataStartedAtMs(liveData) {
  const numericStartedAt = numberOrNull(liveData?.startedAt);
  if (numericStartedAt != null) return numericStartedAt;
  return dateToMillis(liveData?.startedAt);
}

function cleanDisqualificationReason(value) {
  return cleanTimeText(value).replace(/[()]/g, "").trim();
}

function getRunnerPercent(liveData, profile, isFinished) {
  if (isFinished) return "100%";
  const runPercent = numberOrNull(liveData.runPercentageSplits);
  if (runPercent != null) return `${Math.max(0, Math.min(100, Math.floor(runPercent * 100)))}%`;
  return profile.units.at(-1)?.percent || "-";
}

function splitPercent(splitIndex, totalSplits) {
  const total = numberOrNull(totalSplits);
  if (!total || splitIndex == null) return "-";
  return `${Math.max(0, Math.min(100, Math.floor((splitIndex / total) * 100)))}%`;
}

function parseStandings(html) {
  const tableMatch = html.match(/standingsTable[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i);
  if (!tableMatch) return [];

  return [...tableMatch[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)]
    .map((match) => {
      const row = match[1];
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
      const userMatch = row.match(/<a[^>]+href="\/([^"\/]+)\/races"[^>]*>([\s\S]*?)<\/a>/i);
      if (!userMatch) return null;

      const ratingText = textFromHtml(cells[2] || "");
      const ratingMatch = ratingText.match(/^(\d+)([+-]\d+)?/);
      const statusCell = cells[4] || "";
      const statusText = cleanTimeText(textFromHtml(statusCell));
      const statusTitle = statusCell.match(/<abbr[^>]+title="([^"]+)"/i)?.[1];
      const isDisqualified = /disqual/i.test(`${statusText} ${statusTitle || ""}`);

      return {
        place: normalizePlace(textFromHtml(cells[0] || "")),
        username: textFromHtml(userMatch[2]),
        rating: ratingMatch?.[1] || "",
        ratingDelta: ratingMatch?.[2] || "",
        percent: textFromHtml(cells[3] || ""),
        status: isStatusWord(statusText) ? statusText : "",
        currentTime: statusTitle ? shortTime(statusTitle) : statusText,
        isDisqualified,
        disqualificationReason: "",
        finalTimeMs: statusTitle && !isStatusWord(statusText) ? timeToMillis(statusTitle) : null,
      };
    })
    .filter(Boolean);
}

function parseParticipantCards(html) {
  const startRegex = /<div class="col"><div class="[^"]*participantCard[^"]*"[^>]*>/gi;
  const starts = [...html.matchAll(startRegex)].map((match) => match.index);
  const cards = [];

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] || findCardSectionEnd(html, start);
    const segment = html.slice(start, end);
    const userMatch = segment.match(/participantName[\s\S]*?<a[^>]+href="\/([^"\/]+)\/races"[^>]*>([\s\S]*?)<\/a>/i);
    if (!userMatch) continue;

    const placeMatch = segment.match(/participantPlacing[\s\S]*?<span>([\s\S]*?)<\/span>/i);
    const ratingMatch = segment.match(/font-monospace">([\s\S]*?)<\/span>/i);
    const timerMatch = segment.match(/timerDisplay[^>]*>([\s\S]*?)<\/span>\s*<hr/i);
    const metaMatch = segment.match(/participantMeta[^>]*>([\s\S]*?)<\/div>\s*<hr/i);
    const metaText = textFromHtml(metaMatch?.[1] || "");
    const status = metaText.match(/(Done|DNF|Not Ready|Ready|Racing|Forfeit|Forfeited|Abandoned)$/i)?.[1] || "";

    const ratingText = textFromHtml(ratingMatch?.[1] || "");
    const parsedRating = ratingText.match(/^(\d+)([+-]\d+)?/);
    const timerHtml = timerMatch?.[1] || "";
    const timerTitle = timerHtml.match(/<abbr[^>]+title="([^"]+)"/i)?.[1];
    const currentTime = cleanTimeText(textFromHtml(timerHtml));
    const isDisqualified = /disqual/i.test(`${status} ${currentTime} ${metaText}`);
    const abandonedAtMs = /^abandoned$/i.test(status) ? timeToMillis(timerTitle || currentTime) : null;
    const liveDataText = textFromHtml(segment);
    const totalSplits = Number(liveDataText.match(/\b\d+\s*\/\s*(\d+)\s*-/)?.[1]) || null;

    cards.push({
      place: normalizePlace(textFromHtml(placeMatch?.[1] || "")),
      username: textFromHtml(userMatch[2]),
      rating: parsedRating?.[1] || "",
      ratingDelta: parsedRating?.[2] || "",
      status,
      currentTime,
      isDisqualified,
      disqualificationReason: "",
      finalTimeMs: /^done$/i.test(status) ? timeToMillis(timerTitle || currentTime) : null,
      abandonedAtMs,
      totalSplits,
      joinOrder: index,
    });
  }

  return dedupeByUsername(cards);
}

function findCardSectionEnd(html, start) {
  const markers = [
    html.indexOf('<div class="pb-4 d-none', start + 1),
    html.indexOf('<div class="d-none d-lg-block', start + 1),
  ].filter((index) => index > start);

  return markers.length ? Math.min(...markers) : html.length;
}

function parseSplitRows(html, raceEventIndex = buildRaceEventIndex([])) {
  const chatStart = html.indexOf("chatMessages");
  if (chatStart < 0) return [];

  const chatEnd = html.indexOf('<div class="mb-4"><form', chatStart);
  const chat = html.slice(chatStart, chatEnd > chatStart ? chatEnd : undefined);
  const splitRegex = /<div class="[^"]*chatMessage[^"]*"[\s\S]*?<a[^>]+href="\/([^"\/]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<span class="fst-italic">([\s\S]*?)<\/span>\s*<!-- -->\|\s*<abbr[^>]+title="([^"]+)"[^>]*>([\s\S]*?)<\/abbr>\s*\|\s*(?:<!-- -->\s*)*(\d+)\s*(?:<!-- -->)?%/gi;
  const rows = [];

  for (const match of chat.matchAll(splitRegex)) {
    const preciseTime = match[4];
    const username = textFromHtml(match[2]);
    const rawName = textFromHtml(match[3]);
    const timeMs = timeToMillis(preciseTime);
    rows.push({
      username,
      rawName,
      time: shortTime(match[5] || match[4]),
      preciseTime,
      timeMs,
      arrivalTimeMs: getRaceEventArrivalTimeMs(raceEventIndex, username, timeMs, rawName),
      percent: `${match[6]}%`,
    });
  }

  return rows;
}

function buildProfilesByRunner(splitRowsNewestFirst) {
  const rowsByRunner = new Map();
  for (const row of splitRowsNewestFirst) {
    const rows = rowsByRunner.get(row.username) || [];
    rows.push(row);
    rowsByRunner.set(row.username, rows);
  }

  const profiles = new Map();
  for (const [username, newestFirstRows] of rowsByRunner) {
    const chronologicalRows = newestFirstRows.slice().reverse();
    profiles.set(username, buildSplitProfile(chronologicalRows));
  }
  return profiles;
}

function buildSplitProfile(rows) {
  const events = rows.map((row) => ({
    ...row,
    parsed: parseSplitLabel(row.rawName),
  }));
  const units = [];
  const groupTotals = [];
  let currentGroup = null;

  for (const event of events) {
    const parsed = event.parsed;
    if (!parsed.subIndex || !parsed.total) {
      currentGroup = null;
      units.push(makeSplitUnit(event, parsed.name));
      groupTotals.push(1);
      continue;
    }

    const shouldStartGroup =
      !currentGroup ||
      currentGroup.closed ||
      parsed.subIndex === 1 ||
      parsed.subIndex <= currentGroup.lastSubIndex ||
      parsed.total !== currentGroup.total;

    if (shouldStartGroup) {
      currentGroup = {
        total: parsed.total,
        lastSubIndex: 0,
        explicitGroup: "",
        finalName: "",
        closed: false,
      };
    }

    currentGroup.lastSubIndex = parsed.subIndex;
    if (parsed.group) currentGroup.explicitGroup = parsed.group;
    if (parsed.subIndex === parsed.total) {
      currentGroup.finalName = parsed.name;
      currentGroup.closed = true;
      const groupName = currentGroup.explicitGroup || currentGroup.finalName || parsed.name || "Split";
      units.push(makeSplitUnit(event, groupName));
      groupTotals.push(currentGroup.total);
    }
  }

  return {
    units,
    mainSplitCount: units.length,
    groupTotals,
    hasNestedSplits: events.some((event) => event.parsed.subIndex != null && event.parsed.total != null),
  };
}

function makeSplitUnit(event, displayName) {
  return {
    name: displayName,
    time: shortTime(event.preciseTime || event.time),
    timeMs: event.timeMs,
    arrivalTimeMs: event.arrivalTimeMs ?? null,
    percent: event.percent,
  };
}

function parseSplitLabel(rawName) {
  let value = cleanTimeText(rawName).replace(/^-+\s*/, "");
  const groupMatch = value.match(/^\{([^}]+)\}\s*(.*)$/);
  const group = groupMatch ? groupMatch[1].trim() : "";
  if (groupMatch) value = groupMatch[2].trim();

  const subSplitMatch = value.match(/^(\d+)\s*(?:\/|\bof\b)\s*(\d+)(?:\s+(.+))?$/i);
  if (subSplitMatch) {
    return {
      group,
      subIndex: Number(subSplitMatch[1]),
      total: Number(subSplitMatch[2]),
      name: String(subSplitMatch[3] || "").trim() || value,
    };
  }

  return {
    group,
    subIndex: null,
    total: null,
    name: value || rawName,
  };
}

function applyRaceComparisons(runners) {
  const runnersWithKeys = runners.map((runner, originalIndex) => {
    const profile = runner.splitProfile;
    const structureKey = getComparisonStructureKey(runner, profile);
    return {
      ...runner,
      originalIndex,
      comparisonStructureKey: structureKey,
      raceDelta: null,
      raceDeltaMs: null,
      isComparisonBaseline: false,
      comparisonStatus: "",
    };
  });
  const disqualifiedRunners = runnersWithKeys.filter(isDisqualifiedRunner).sort(compareDisqualifiedPlacement);
  const nonDisqualifiedRunners = runnersWithKeys.filter((runner) => !isDisqualifiedRunner(runner));
  const abandonedRunners = nonDisqualifiedRunners.filter(isAbandonedRunner).sort(compareAbandonedPlacement);
  const contenders = nonDisqualifiedRunners.filter((runner) => !isAbandonedRunner(runner));

  const finishedCandidates = contenders.filter((runner) => !isDnfRunner(runner) && runner.finalTimeMs != null);
  if (finishedCandidates.length) {
    return applyFinishedComparisons(contenders, finishedCandidates, abandonedRunners, disqualifiedRunners);
  }

  const primaryKey = choosePrimaryComparisonKey(contenders);
  if (!primaryKey) return applyUnrankedComparisons(contenders, abandonedRunners, disqualifiedRunners);

  const comparable = contenders.filter(
    (runner) => isComparableWithPrimaryKey(runner, primaryKey) && runner.splitProfile?.units?.length
  );
  const rankedCandidates = comparable.filter((runner) => !isDnfRunner(runner));
  const rankedCandidateSet = new Set(rankedCandidates);
  const incompatible = contenders.filter((runner) => !rankedCandidateSet.has(runner));
  const ranked = rankedCandidates.slice().sort(compareByRealTimeProgress);

  const baseline = ranked[0] || null;
  const rankedWithPlaces = ranked.map((runner, index) => {
    const deltaMs = baseline && runner !== baseline ? getSplitDeltaAgainstBaseline(runner, baseline) : null;
    const comparisonStatus =
      runner === baseline
        ? "leader"
        : !areTimingMethodsCompatible(runner, baseline)
          ? "timing method mismatch"
          : deltaMs == null
            ? "no shared parent split"
            : "comparable";
    return {
      ...runner,
      place: `#${index + 1}`,
      raceDeltaMs: deltaMs,
      raceDelta: deltaMs == null ? null : formatDelta(deltaMs),
      isComparisonBaseline: runner === baseline,
      comparisonStatus,
    };
  });

  let fallbackPlace = rankedWithPlaces.length;
  const bottomRunners = incompatible
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((runner) => {
      const place = runner.place && runner.place !== "-" ? normalizeDisplayPlace(runner.place) : !isDnfRunner(runner) ? `#${++fallbackPlace}` : "-";
      return {
        ...runner,
        place,
        raceDelta: null,
        raceDeltaMs: null,
        comparisonStatus: getUnrankedComparisonStatus(runner, primaryKey),
      };
    });

  return appendOutcomePlaces([...rankedWithPlaces, ...bottomRunners], abandonedRunners, disqualifiedRunners).map(stripInternalRunnerFields);
}

function applyFinishedComparisons(runners, finishedCandidates, abandonedRunners = [], disqualifiedRunners = []) {
  const finished = finishedCandidates.slice().sort((a, b) => (a.finalTimeMs ?? Infinity) - (b.finalTimeMs ?? Infinity));
  const baseline = finished[0] || null;
  const finishedNames = new Set(finished.map((runner) => runner.username));
  const active = runners
    .filter((runner) => !finishedNames.has(runner.username) && !isDnfRunner(runner))
    .map((runner) => {
      const isComparable = baseline ? areComparisonStructuresCompatible(runner, baseline) : false;
      const timingCompatible = baseline ? areTimingMethodsCompatible(runner, baseline) : false;
      const deltaMs = isComparable && timingCompatible ? getSplitDeltaAgainstBaseline(runner, baseline) : null;
      const comparisonStatus = !runner.splitProfile?.units?.length
        ? "no completed parent split"
        : !isComparable
          ? "different parent split count"
          : !timingCompatible
            ? "timing method mismatch"
            : deltaMs == null
              ? "no shared parent split"
              : "comparable";
      return {
        ...runner,
        isStructurallyComparable: isComparable,
        raceDeltaMs: deltaMs,
        raceDelta: deltaMs == null ? null : formatDelta(deltaMs),
        comparisonStatus,
      };
    })
    .sort((a, b) => {
      if (a.isStructurallyComparable !== b.isStructurallyComparable) {
        return a.isStructurallyComparable ? -1 : 1;
      }
      return compareByRealTimeProgress(a, b);
    });
  const dnf = runners.filter((runner) => !finishedNames.has(runner.username) && isDnfRunner(runner));

  let place = 0;
  const rankedFinished = finished.map((runner) => {
    const timingCompatible = baseline ? areTimingMethodsCompatible(runner, baseline) : false;
    const deltaMs = baseline && runner !== baseline && timingCompatible ? runner.finalTimeMs - baseline.finalTimeMs : null;
    return {
      ...runner,
      place: `#${++place}`,
      raceDeltaMs: deltaMs,
      raceDelta: deltaMs == null ? null : formatDelta(deltaMs),
      isComparisonBaseline: runner === baseline,
      comparisonStatus:
        runner === baseline ? "leader" : timingCompatible ? "comparable" : "timing method mismatch",
    };
  });

  const rankedActive = active.map((runner) => ({
    ...runner,
    place: `#${++place}`,
    isComparisonBaseline: false,
  }));

  const rankedDnf = dnf
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((runner) => ({
      ...runner,
      place: "-",
      raceDelta: null,
      raceDeltaMs: null,
      isComparisonBaseline: false,
      comparisonStatus: "not comparable",
    }));

  return appendOutcomePlaces([...rankedFinished, ...rankedActive, ...rankedDnf], abandonedRunners, disqualifiedRunners).map(stripInternalRunnerFields);
}

function applyUnrankedComparisons(runners, abandonedRunners = [], disqualifiedRunners = []) {
  const unranked = runners.map((runner) => ({
    ...runner,
    comparisonStatus: runner.splitProfile?.units?.length ? "not comparable" : "no completed parent split",
  }));
  return appendOutcomePlaces(unranked, abandonedRunners, disqualifiedRunners).map(stripInternalRunnerFields);
}

function appendOutcomePlaces(rankedRunners, abandonedRunners = [], disqualifiedRunners = []) {
  return appendDisqualifiedPlaces(appendAbandonedPlaces(rankedRunners, abandonedRunners), disqualifiedRunners);
}

function appendAbandonedPlaces(rankedRunners, abandonedRunners = []) {
  const highestExistingPlace = rankedRunners.reduce((highest, runner) => {
    const placeNumber = Number.parseInt(String(runner.place || "").replace("#", ""), 10);
    return Number.isFinite(placeNumber) ? Math.max(highest, placeNumber) : highest;
  }, 0);
  const nonAbandonedCount = rankedRunners.filter((runner) => !isDnfRunner(runner)).length;
  let place = Math.max(highestExistingPlace, nonAbandonedCount);
  const rankedAbandoned = abandonedRunners.map((runner) => ({
    ...runner,
    place: `#${++place}`,
    raceDelta: null,
    raceDeltaMs: null,
    isComparisonBaseline: false,
    comparisonStatus: "abandoned",
  }));
  return [...rankedRunners, ...rankedAbandoned];
}

function appendDisqualifiedPlaces(rankedRunners, disqualifiedRunners = []) {
  const rankedDisqualified = disqualifiedRunners.map((runner) => ({
    ...runner,
    place: "-",
    status: "Abandoned",
    currentTime: getDisqualifiedDisplayTime(runner),
    confirmationStatus: "",
    raceDelta: null,
    raceDeltaMs: null,
    isComparisonBaseline: false,
    isDisqualified: true,
    comparisonStatus: "disqualified",
  }));
  return [...rankedRunners, ...rankedDisqualified];
}

function getDisqualifiedDisplayTime(runner) {
  const time = extractTimeText(runner.currentTime);
  return time || "-";
}

function getComparisonStructureKey(runner, profile) {
  const reliableCount = runner.plannedMainSplitCount ?? getReliableMainSplitCount(runner, profile);
  if (reliableCount) return `main:${reliableCount}`;
  return profile?.units?.length ? "main:unknown" : "";
}

function isComparableWithPrimaryKey(runner, primaryKey) {
  return runner.comparisonStructureKey === primaryKey || runner.comparisonStructureKey === "main:unknown";
}

function getUnrankedComparisonStatus(runner, primaryKey) {
  if (!runner.splitProfile?.units?.length) return "no completed parent split";
  if (!isComparableWithPrimaryKey(runner, primaryKey)) return "different parent split count";
  return "not comparable";
}

function choosePrimaryComparisonKey(runners) {
  const counts = new Map();
  for (const runner of runners) {
    if (!runner.comparisonStructureKey || runner.comparisonStructureKey === "main:unknown") continue;
    counts.set(runner.comparisonStructureKey, (counts.get(runner.comparisonStructureKey) || 0) + 1);
  }
  if (!counts.size) {
    return runners.some((runner) => runner.comparisonStructureKey === "main:unknown") ? "main:unknown" : "";
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const topCount = sorted[0][1];
  const tiedKeys = sorted.filter((entry) => entry[1] === topCount).map((entry) => entry[0]);
  if (tiedKeys.length === 1) return tiedKeys[0];

  const creatorWithKey = runners.find(
    (runner) => runner.isRaceCreator && tiedKeys.includes(runner.comparisonStructureKey)
  );
  if (creatorWithKey) return creatorWithKey.comparisonStructureKey;

  const firstJoinedWithKey = runners
    .slice()
    .sort(compareRunnerJoinOrder)
    .find((runner) => tiedKeys.includes(runner.comparisonStructureKey));
  return firstJoinedWithKey?.comparisonStructureKey || tiedKeys[0];
}

function compareRunnerJoinOrder(a, b) {
  const aJoinedAt = a.joinedAtMs ?? Number.POSITIVE_INFINITY;
  const bJoinedAt = b.joinedAtMs ?? Number.POSITIVE_INFINITY;
  if (aJoinedAt !== bJoinedAt) return aJoinedAt - bJoinedAt;
  return (a.joinOrder ?? a.originalIndex) - (b.joinOrder ?? b.originalIndex);
}

function compareByRealTimeProgress(a, b) {
  const aLength = a.splitProfile?.units?.length || 0;
  const bLength = b.splitProfile?.units?.length || 0;
  if (aLength !== bLength) return bLength - aLength;

  const aArrivalMs = aLength ? numberOrNull(a.splitProfile.units[aLength - 1]?.arrivalTimeMs) : null;
  const bArrivalMs = bLength ? numberOrNull(b.splitProfile.units[bLength - 1]?.arrivalTimeMs) : null;
  if (aArrivalMs != null || bArrivalMs != null) {
    if (aArrivalMs == null) return 1;
    if (bArrivalMs == null) return -1;
    if (aArrivalMs !== bArrivalMs) return aArrivalMs - bArrivalMs;
  }

  return a.originalIndex - b.originalIndex;
}

function areComparisonStructuresCompatible(a, b) {
  const aKey = a?.comparisonStructureKey || "";
  const bKey = b?.comparisonStructureKey || "";
  if (!aKey || !bKey) return false;
  return aKey === bKey || aKey === "main:unknown" || bKey === "main:unknown";
}

function areTimingMethodsCompatible(a, b) {
  const aMethod = String(a?.timingMethod || "").trim().toUpperCase();
  const bMethod = String(b?.timingMethod || "").trim().toUpperCase();
  return !aMethod || !bMethod || aMethod === bMethod;
}

function getSplitDeltaAgainstBaseline(runner, baseline) {
  if (!runner?.splitProfile?.units?.length || !baseline?.splitProfile?.units?.length) return null;
  if (!areTimingMethodsCompatible(runner, baseline)) return null;

  const runnerUnits = runner.splitProfile.units;
  const baselineUnits = baseline.splitProfile.units;
  const preferredIndex = getLatestSharedIndex(runner, baseline);
  if (preferredIndex == null || preferredIndex < 0) return null;

  const runnerUnit = runnerUnits[preferredIndex];
  const baselineUnit = baselineUnits[preferredIndex];
  if (!runnerUnit || !baselineUnit || runnerUnit.timeMs == null || baselineUnit.timeMs == null) return null;
  return runnerUnit.timeMs - baselineUnit.timeMs;
}

function getLatestSharedIndex(a, b) {
  const aLength = a.splitProfile?.units?.length || 0;
  const bLength = b.splitProfile?.units?.length || 0;
  const sharedIndex = Math.min(aLength, bLength) - 1;
  return sharedIndex >= 0 ? sharedIndex : null;
}

function isFinishedRunner(runner) {
  return /^done$/i.test(runner.status || "") || runner.finalTimeMs != null;
}

function isDnfRunner(runner) {
  return isDisqualifiedRunner(runner) || /dnf|abandoned|forfeit/i.test(`${runner.status || ""} ${runner.currentTime || ""}`);
}

function isAbandonedRunner(runner) {
  return !isDisqualifiedRunner(runner) && (runner.abandonedAtMs != null || /abandoned/i.test(`${runner.status || ""} ${runner.currentTime || ""}`));
}

function compareAbandonedPlacement(a, b) {
  const aTime = a.abandonedAtMs ?? timeToMillis(a.currentTime) ?? Number.NEGATIVE_INFINITY;
  const bTime = b.abandonedAtMs ?? timeToMillis(b.currentTime) ?? Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return bTime - aTime;
  return a.originalIndex - b.originalIndex;
}

function isDisqualifiedRunner(runner) {
  return runner.isDisqualified === true || /disqual|dsq/i.test(`${runner.status || ""} ${runner.currentTime || ""}`);
}

function compareDisqualifiedPlacement(a, b) {
  return (a.originalIndex ?? 0) - (b.originalIndex ?? 0);
}

function getReliableMainSplitCount(runner, profile) {
  if (!profile?.units?.length) return null;
  if (runner.plannedMainSplitCount) return runner.plannedMainSplitCount;
  if (isFinishedRunner(runner)) return profile.mainSplitCount || profile.units.length;

  const rawTotalSplits = numberOrNull(runner.totalSplits);
  if (!profile.hasNestedSplits && rawTotalSplits && rawTotalSplits >= profile.units.length) {
    return rawTotalSplits;
  }

  return null;
}

function stripInternalRunnerFields(runner) {
  const {
    originalIndex,
    splitProfile,
    comparisonStructureKey,
    isStructurallyComparable,
    abandonedAtMs,
    joinOrder,
    joinedAtMs,
    isRaceCreator,
    ...publicRunner
  } = runner;
  if (!publicRunner.latestSplit) return publicRunner;

  return {
    ...publicRunner,
    latestSplit: {
      name: publicRunner.latestSplit.name,
      time: publicRunner.latestSplit.time,
      percent: publicRunner.latestSplit.percent,
    },
  };
}

function dedupeByUsername(runners) {
  const seen = new Set();
  return runners.filter((runner) => {
    if (seen.has(runner.username)) return false;
    seen.add(runner.username);
    return true;
  });
}

function inferStatus(currentTime) {
  if (/abandoned/i.test(currentTime || "")) return "Abandoned";
  return "";
}

function normalizeStatusTime(status) {
  if (!status) return "";
  return isStatusWord(status) ? status : "";
}

function normalizeCurrentTimeForDisplay(currentTime, status) {
  const clean = cleanTimeText(currentTime);
  if (/abandoned|forfeit|dnf/i.test(`${status || ""} ${clean}`)) {
    return extractTimeText(clean) || clean;
  }
  return clean;
}

function extractTimeText(value) {
  const match = String(value || "").match(/(\d+:)?\d{1,2}:\d{2}(?:\.\d+)?/);
  return match ? shortTime(match[0]) : "";
}

function isStatusWord(value) {
  return /^(DNF|Done|Not Ready|Ready|Racing|Forfeit|Forfeited|Abandoned)$/i.test(value || "");
}

function normalizePlace(value) {
  const clean = String(value || "-").replace(/\.$/, "").trim();
  return clean || "-";
}

function normalizeDisplayPlace(value) {
  const clean = normalizePlace(value);
  if (!clean || clean === "-") return "-";
  return clean.startsWith("#") ? clean : `#${clean}`;
}

function shortTime(value) {
  return cleanTimeText(String(value || "").replace(/\.\d+$/, ""));
}

function numberOrNull(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateToMillis(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function absoluteTimestampToMillis(value) {
  const numeric = numberOrNull(value);
  if (numeric != null && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  return dateToMillis(value);
}

function millisToTime(value, includeMillis = false) {
  const ms = numberOrNull(value);
  if (ms == null) return "";

  const totalSeconds = Math.max(0, ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const secondsText = includeMillis
    ? seconds.toFixed(3).padStart(6, "0")
    : String(Math.floor(seconds)).padStart(2, "0");

  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${secondsText}`;
  return `${minutes}:${secondsText}`;
}

function timeToMillis(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "-") return null;
  const timerMatch = raw.match(/(\d+:)?\d{1,2}:\d{2}(?:\.\d+)?/);
  if (!timerMatch) return null;

  const parts = timerMatch[0].split(":");
  const secondsPart = parts.pop();
  const seconds = Number(secondsPart);
  const minutes = Number(parts.pop() || 0);
  const hours = Number(parts.pop() || 0);
  if (![seconds, minutes, hours].every(Number.isFinite)) return null;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function formatDelta(ms) {
  const sign = ms < 0 ? "-" : "+";
  const absoluteSeconds = Math.abs(ms) / 1000;
  const hours = Math.floor(absoluteSeconds / 3600);
  const minutes = Math.floor((absoluteSeconds % 3600) / 60);
  const seconds = absoluteSeconds % 60;

  if (hours > 0) {
    return `${sign}${hours}:${String(minutes).padStart(2, "0")}:${seconds.toFixed(1).padStart(4, "0")}`;
  }
  if (minutes > 0) {
    return `${sign}${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
  }
  return `${sign}${seconds.toFixed(1)}`;
}

function cleanTimeText(value) {
  return String(value || "")
    .replace(/\s*:\s*/g, ":")
    .replace(/\s*-\s*/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

function textFromHtml(value) {
  return decodeEntities(String(value || ""))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === "#") {
      const isHex = code[1]?.toLowerCase() === "x";
      const number = Number.parseInt(code.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : entity;
    }
    return named[code.toLowerCase()] || entity;
  });
}

function serveStatic(req, res, pathname) {
  const routePath = pathname === "/" || pathname === "/overlay" || pathname === "/control" ? "/index.html" : pathname;
  const unsafePath = path.normalize(decodeURIComponent(routePath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, unsafePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    const type = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

    if (requestUrl.pathname === "/health") {
      sendJson(res, 200, { ok: true, version: APP_VERSION });
      return;
    }

    if (requestUrl.pathname === "/api/current-race") {
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, version: APP_VERSION, currentRace });
        return;
      }

      if (req.method === "POST") {
        const raceInput = await readRaceFromRequest(req);
        const raceId = normalizeRaceInput(raceInput);
        const data = await getRaceData(raceId);
        const nextRace = {
          raceId,
          sourceUrl: data.sourceUrl,
          title: data.title,
          updatedAt: new Date().toISOString(),
        };
        writeState(nextRace);
        sendJson(res, 200, { ok: true, version: APP_VERSION, currentRace: nextRace, race: data });
        return;
      }

      sendJson(res, 405, { ok: false, error: "Method not allowed." });
      return;
    }

    if (requestUrl.pathname === "/api/race") {
      const raceInput = requestUrl.searchParams.get("race") || requestUrl.searchParams.get("url") || getCurrentRaceId();
      const raceId = normalizeRaceInput(raceInput);
      const data = await getRaceData(raceId);
      sendJson(res, 200, data);
      return;
    }

    serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message || String(error),
    });
  }
});

if (require.main === module) {
  server.listen(port, "127.0.0.1", () => {
    console.log(`TheRun OBS overlay is running: http://127.0.0.1:${port}/overlay`);
    console.log(`Paste new race URLs at: http://127.0.0.1:${port}/control`);
  });
}

module.exports = {
  APP_VERSION,
  applyRaceComparisons,
  buildRaceEventIndex,
  buildSplitProfile,
  getCachedRaceData,
  getRaceData,
  getMatchingPlannedMainSplitCount,
  getSplitsFileUrls,
  makeStaleRaceData,
  normalizeRaceInput,
  parseEmbeddedParticipants,
  parseEmbeddedPageData,
  parseLiveSplitSegmentNames,
  parseRaceHtml,
  parseSplitsFilePath,
  parseSplitLabel,
  rowsFromSplitPredictions,
};
