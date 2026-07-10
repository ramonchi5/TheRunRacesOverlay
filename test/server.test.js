const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyRaceComparisons,
  buildRaceEventIndex,
  buildSplitProfile,
  getMatchingPlannedMainSplitCount,
  getSplitsFileUrls,
  makeStaleRaceData,
  parseEmbeddedParticipants,
  parseLiveSplitSegmentNames,
  parseSplitLabel,
  rowsFromSplitPredictions,
} = require("../server");

function splitRow(rawName, timeMs, arrivalTimeMs, rawSplitIndex) {
  return {
    rawName,
    time: "",
    preciseTime: "",
    timeMs,
    arrivalTimeMs,
    percent: "-",
    rawSplitIndex,
  };
}

function profileFromTimes(times, arrivals) {
  return buildSplitProfile(
    times.map((timeMs, index) => splitRow(`Split ${index + 1}`, timeMs, arrivals[index], index + 1))
  );
}

function activeRunner(username, times, arrivals, options = {}) {
  const profile = profileFromTimes(times, arrivals);
  return {
    place: "-",
    username,
    rating: "1500",
    ratingDelta: "",
    percent: "-",
    status: "Racing",
    currentTime: "10:00",
    timingMethod: options.timingMethod ?? "IGT",
    streaming: false,
    finalTimeMs: null,
    abandonedAtMs: null,
    totalSplits: options.totalSplits ?? times.length,
    plannedMainSplitCount: options.plannedMainSplitCount ?? times.length,
    joinOrder: options.joinOrder ?? 0,
    joinedAtMs: options.joinedAtMs ?? null,
    isRaceCreator: options.isRaceCreator ?? false,
    latestSplit: profile.units.at(-1) || null,
    splitProfile: profile,
    splitProfileMainOnly: profile,
  };
}

test("recognizes LiveSplit subsplit labels", () => {
  assert.deepEqual(parseSplitLabel("-{Tutorial} 2 of 5 Gourd"), {
    group: "Tutorial",
    subIndex: 2,
    total: 5,
    name: "Gourd",
  });
  assert.deepEqual(parseSplitLabel("{Tutorial}5/5 Geni"), {
    group: "Tutorial",
    subIndex: 5,
    total: 5,
    name: "Geni",
  });
});

test("collapses completed subsplit groups and ignores partial groups", () => {
  const profile = buildSplitProfile([
    splitRow("-1/3 Window", 10_000, 1_000, 1),
    splitRow("-2/3 Gourd", 20_000, 2_000, 2),
    splitRow("{Tutorial}3/3 Geni", 30_000, 3_000, 3),
    splitRow("Bull", 50_000, 5_000, 4),
    splitRow("-1/2 Entry", 60_000, 6_000, 5),
  ]);

  assert.equal(profile.hasNestedSplits, true);
  assert.equal(profile.mainSplitCount, 2);
  assert.deepEqual(profile.groupTotals, [3, 1]);
  assert.deepEqual(
    profile.units.map((unit) => ({ name: unit.name, timeMs: unit.timeMs, arrivalTimeMs: unit.arrivalTimeMs })),
    [
      { name: "Tutorial", timeMs: 30_000, arrivalTimeMs: 3_000 },
      { name: "Bull", timeMs: 50_000, arrivalTimeMs: 5_000 },
    ]
  );
});

test("reads a complete LiveSplit plan and counts parent groups", () => {
  const xml = `
    <Run>
      <Segments>
        <Segment><Name>-1/2 Entry</Name></Segment>
        <Segment><Name>{Tutorial}2/2 Geni</Name></Segment>
        <Segment><Name>Bull &amp; Skip</Name></Segment>
        <Segment><Name>-1/3 Path</Name></Segment>
        <Segment><Name>-2/3 Door</Name></Segment>
        <Segment><Name>{Shura}3/3 Finish</Name></Segment>
      </Segments>
    </Run>`;
  const names = parseLiveSplitSegmentNames(xml);
  const profile = buildSplitProfile(names.map((rawName) => ({ rawName })));

  assert.deepEqual(names, [
    "-1/2 Entry",
    "{Tutorial}2/2 Geni",
    "Bull & Skip",
    "-1/3 Path",
    "-2/3 Door",
    "{Shura}3/3 Finish",
  ]);
  assert.equal(profile.mainSplitCount, 3);
  assert.deepEqual(profile.groupTotals, [2, 1, 3]);
});

test("builds TheRun's public split-file fallback URLs", () => {
  assert.deepEqual(getSplitsFileUrls("Runner/Game%3A+Name-Category.lss"), [
    "https://d2c9jb6sm40v74.cloudfront.net/Runner/Game:+Name-Category.lss",
    "https://d2c9jb6sm40v74.cloudfront.net/Runner/Game:%2BName-Category.lss",
  ]);
});

test("ignores a public split plan that no longer matches the race snapshot", () => {
  const plan = { mainSplitCount: 14, rawSplitCount: 59 };
  assert.equal(getMatchingPlannedMainSplitCount(plan, 59), 14);
  assert.equal(getMatchingPlannedMainSplitCount(plan, 62), null);
});

test("attaches exact wall-clock event arrivals to split predictions", () => {
  const arrival = "2026-07-10T13:00:17.126Z";
  const eventIndex = buildRaceEventIndex([
    {
      raceId: "pnx7",
      type: "participant-split",
      time: arrival,
      data: { user: "Runner", time: 30_000, splitName: "{Tutorial}3/3 Geni" },
    },
  ]);
  const rows = rowsFromSplitPredictions(
    [
      { splitIndex: 1, currentTime: 10_000, splitName: "-1/3 Window" },
      { splitIndex: 2, currentTime: 20_000, splitName: "-2/3 Gourd" },
      { splitIndex: 3, currentTime: 30_000, splitName: "{Tutorial}3/3 Geni" },
    ],
    30,
    eventIndex,
    "Runner"
  );

  const profile = buildSplitProfile(rows);
  assert.equal(profile.units.length, 1);
  assert.equal(profile.units[0].arrivalTimeMs, Date.parse(arrival));
});

test("active leader is furthest ahead, then first to reach the tied split", () => {
  const furtherAhead = activeRunner("Further", [100_000, 220_000, 360_000], [1_000, 3_000, 7_000], {
    totalSplits: 5,
    plannedMainSplitCount: 5,
    joinOrder: 0,
  });
  const fasterClock = activeRunner("FasterClock", [90_000, 180_000], [900, 2_000], {
    totalSplits: 5,
    plannedMainSplitCount: 5,
    joinOrder: 1,
  });

  const ranked = applyRaceComparisons([fasterClock, furtherAhead]);
  assert.equal(ranked[0].username, "Further");
  assert.equal(ranked[0].isComparisonBaseline, true);
  assert.equal(ranked[1].username, "FasterClock");
  assert.equal(ranked[1].raceDelta, "-40.0");
});

test("earliest real-world arrival wins a progress tie even with a slower timer", () => {
  const fasterClock = activeRunner("FasterClock", [100_000, 200_000], [1_000, 5_000], {
    totalSplits: 4,
    plannedMainSplitCount: 4,
    joinOrder: 0,
  });
  const firstArrival = activeRunner("FirstArrival", [110_000, 220_000], [1_100, 4_000], {
    totalSplits: 4,
    plannedMainSplitCount: 4,
    joinOrder: 1,
  });

  const ranked = applyRaceComparisons([fasterClock, firstArrival]);
  assert.equal(ranked[0].username, "FirstArrival");
  assert.equal(ranked[1].username, "FasterClock");
  assert.equal(ranked[1].raceDelta, "-20.0");
});

test("finished runners take over placement and final-time baseline", () => {
  const finishedProfile = profileFromTimes([100_000, 200_000, 300_000], [1_000, 2_000, 3_000]);
  const finished = {
    ...activeRunner("Finished", [100_000, 200_000, 300_000], [1_000, 2_000, 3_000], {
      totalSplits: 3,
      plannedMainSplitCount: 3,
    }),
    status: "Done",
    finalTimeMs: 300_000,
    currentTime: "5:00",
    splitProfile: finishedProfile,
    splitProfileMainOnly: finishedProfile,
  };
  const active = activeRunner("StillRacing", [90_000, 190_000], [900, 1_900], {
    totalSplits: 3,
    plannedMainSplitCount: 3,
  });

  const ranked = applyRaceComparisons([active, finished]);
  assert.equal(ranked[0].username, "Finished");
  assert.equal(ranked[0].place, "#1");
  assert.equal(ranked[0].isComparisonBaseline, true);
  assert.equal(ranked[1].username, "StillRacing");
  assert.equal(ranked[1].raceDelta, "-10.0");
});

test("creator split count resolves an otherwise tied structure choice", () => {
  const fifteen = activeRunner("Creator", [100_000], [1_000], {
    totalSplits: 15,
    plannedMainSplitCount: 15,
    isRaceCreator: true,
  });
  const sixteen = activeRunner("Other", [90_000], [900], {
    totalSplits: 16,
    plannedMainSplitCount: 16,
  });

  const ranked = applyRaceComparisons([sixteen, fifteen]);
  assert.equal(ranked[0].username, "Creator");
  assert.equal(ranked[0].isComparisonBaseline, true);
  assert.equal(ranked[1].username, "Other");
  assert.equal(ranked[1].raceDelta, null);
});

test("mixed timing methods preserve physical order but suppress active deltas", () => {
  const firstArrival = activeRunner("FirstArrival", [110_000, 220_000], [1_000, 4_000], {
    totalSplits: 4,
    plannedMainSplitCount: 4,
    timingMethod: "IGT",
  });
  const laterArrival = activeRunner("LaterArrival", [100_000, 200_000], [900, 5_000], {
    totalSplits: 4,
    plannedMainSplitCount: 4,
    timingMethod: "RTA",
  });

  const ranked = applyRaceComparisons([laterArrival, firstArrival]);
  assert.equal(ranked[0].username, "FirstArrival");
  assert.equal(ranked[0].isComparisonBaseline, true);
  assert.equal(ranked[1].username, "LaterArrival");
  assert.equal(ranked[1].raceDelta, null);
  assert.equal(ranked[1].comparisonStatus, "timing method mismatch");
});

test("mixed timing methods suppress final-time deltas", () => {
  const first = {
    ...activeRunner("First", [100_000, 200_000], [1_000, 2_000], {
      totalSplits: 2,
      plannedMainSplitCount: 2,
      timingMethod: "IGT",
    }),
    status: "Done",
    finalTimeMs: 200_000,
    currentTime: "3:20",
  };
  const second = {
    ...activeRunner("Second", [110_000, 220_000], [1_100, 2_100], {
      totalSplits: 2,
      plannedMainSplitCount: 2,
      timingMethod: "RTA",
    }),
    status: "Done",
    finalTimeMs: 220_000,
    currentTime: "3:40",
  };

  const ranked = applyRaceComparisons([second, first]);
  assert.equal(ranked[0].username, "First");
  assert.equal(ranked[1].username, "Second");
  assert.equal(ranked[1].raceDelta, null);
  assert.equal(ranked[1].comparisonStatus, "timing method mismatch");
});

test("excludes participants marked invisible", () => {
  const race = {
    creator: "Visible",
    participants: [
      { user: "Hidden", visible: false, liveData: {} },
      { user: "Visible", visible: true, ratingBefore: 1500, liveData: {} },
    ],
  };

  const runners = parseEmbeddedParticipants(race);
  assert.deepEqual(runners.map((runner) => runner.username), ["Visible"]);
});

test("stale fallback retains the last successful race snapshot", () => {
  const snapshot = {
    ok: true,
    version: "2.0.1",
    raceId: "test",
    fetchedAt: "2026-07-10T12:00:00.000Z",
    runners: [{ username: "Runner" }],
  };

  const stale = makeStaleRaceData(snapshot, "Temporary upstream failure");
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, "Temporary upstream failure");
  assert.equal(stale.fetchedAt, snapshot.fetchedAt);
  assert.deepEqual(stale.runners, snapshot.runners);
  assert.ok(stale.servedAt);
});
