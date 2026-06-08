Yes — paste this full bot.js exactly as-is. It keeps the free Render port fix, keeps the Telegram commands, and changes the fixture lookup so it pulls all not-started World Cup fixtures and filters them locally for the tracked team, which is more reliable than the earlier team + next shortcut. Render web services must bind to PORT, Telegram bots can use polling, and API-Football exposes fixture status values like upcoming matches through the fixtures endpoint.

js
import "dotenv/config";
import axios from "axios";
import Database from "better-sqlite3";
import cron from "node-cron";
import http from "http";
import { Telegraf, Markup } from "telegraf";

const {
  BOT_TOKEN,
  FOOTBALL_API_KEY,
  WORLD_CUP_LEAGUE_ID = "1",
  WORLD_CUP_SEASON = "2026",
  TZ = "Europe/Riga",
  ADMIN_ONLY_SETTINGS = "true",
} = process.env;

if (!BOT_TOKEN || !FOOTBALL_API_KEY) {
  throw new Error("Missing BOT_TOKEN or FOOTBALL_API_KEY");
}

const bot = new Telegraf(BOT_TOKEN);
const db = new Database("worldcup-2026.sqlite");

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("World Cup Telegram bot is alive");
});

server.listen(PORT, HOST, () => {
  console.log(`Health server listening on ${HOST}:${PORT}`);
});

const api = axios.create({
  baseURL: "https://v3.football.api-sports.io",
  timeout: 15000,
  headers: { "x-apisports-key": FOOTBALL_API_KEY },
});

db.exec(`
CREATE TABLE IF NOT EXISTS tracked_teams (
  chat_id TEXT NOT NULL,
  team_id INTEGER NOT NULL,
  team_name TEXT NOT NULL,
  PRIMARY KEY (chat_id, team_id)
);
CREATE TABLE IF NOT EXISTS sent_events (
  chat_id TEXT NOT NULL,
  fixture_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (chat_id, fixture_id, event_type)
);
`);

const DEFAULT_TEAMS = [
  "Argentina",
  "Brazil",
  "Portugal",
  "France",
  "England",
  "Spain",
  "Germany",
  "Netherlands",
  "Belgium",
  "Croatia",
  "Italy",
  "Uruguay",
];

async function searchTeam(name) {
  const r = await api.get("/teams", { params: { search: name } });
  return r.data?.response?.[0] || null;
}

async function getWorldCupFixturesByDate(date) {
  const r = await api.get("/fixtures", {
    params: {
      league: WORLD_CUP_LEAGUE_ID,
      season: WORLD_CUP_SEASON,
      date,
    },
  });
  return r.data?.response || [];
}

async function getUpcomingWorldCupFixtures() {
  const r = await api.get("/fixtures", {
    params: {
      league: WORLD_CUP_LEAGUE_ID,
      season: WORLD_CUP_SEASON,
      status: "NS",
    },
  });
  return r.data?.response || [];
}

async function getNextFixtureForTeam(teamId) {
  const fixtures = await getUpcomingWorldCupFixtures();
  const now = Date.now();

  const upcoming = fixtures
    .filter(
      (fx) =>
        (fx.teams.home.id === teamId || fx.teams.away.id === teamId) &&
        new Date(fx.fixture.date).getTime() > now
    )
    .sort(
      (a, b) =>
        new Date(a.fixture.date).getTime() -
        new Date(b.fixture.date).getTime()
    );

  return upcoming[0] || null;
}

const trackedTeams = (chatId) =>
  db
    .prepare("SELECT * FROM tracked_teams WHERE chat_id = ? ORDER BY team_name")
    .all(String(chatId));

const allTrackedTeams = () => db.prepare("SELECT * FROM tracked_teams").all();

const addTrackedTeam = (chatId, teamId, teamName) =>
  db
    .prepare(
      "INSERT OR IGNORE INTO tracked_teams (chat_id, team_id, team_name) VALUES (?, ?, ?)"
    )
    .run(String(chatId), teamId, teamName);

const removeTrackedTeam = (chatId, teamId) =>
  db
    .prepare("DELETE FROM tracked_teams WHERE chat_id = ? AND team_id = ?")
    .run(String(chatId), teamId);

const isSent = (chatId, fixtureId, eventType) =>
  !!db
    .prepare(
      "SELECT 1 FROM sent_events WHERE chat_id=? AND fixture_id=? AND event_type=?"
    )
    .get(String(chatId), fixtureId, eventType);

const markSent = (chatId, fixtureId, eventType) =>
  db
    .prepare(
      "INSERT OR IGNORE INTO sent_events (chat_id, fixture_id, event_type) VALUES (?, ?, ?)"
    )
    .run(String(chatId), fixtureId, eventType);

const fmtDate = (date) =>
  new Date(date).toLocaleString("en-GB", { timeZone: TZ });

const matchLine = (fx) =>
  `${fx.teams.home.name} vs ${fx.teams.away.name}\n${fmtDate(fx.fixture.date)}`;

async function isAdmin(ctx) {
  if (ADMIN_ONLY_SETTINGS !== "true" || ctx.chat.type === "private") return true;
  try {
    const m = await ctx.getChatMember(ctx.from.id);
    return ["creator", "administrator"].includes(m.status);
  } catch {
    return false;
  }
}

function settingsKeyboard(chatId) {
  const current = trackedTeams(chatId).map((t) => t.team_name);
  const rows = DEFAULT_TEAMS.map((name) => {
    const enabled = current.includes(name);
    return [
      Markup.button.callback(`${enabled ? "✅" : "➕"} ${name}`, `toggle:${name}`),
    ];
  });
  rows.push([Markup.button.callback("📋 My tracked teams", "list_teams")]);
  return Markup.inlineKeyboard(rows);
}

bot.start(async (ctx) =>
  ctx.reply(
    "2026 FIFA World Cup bot is ready. Add me to your group and use /settings to select teams to track."
  )
);

bot.help(async (ctx) =>
  ctx.reply(
    [
      "Commands:",
      "/settings - choose teams to track in this chat",
      "/list - show tracked teams",
      "/matches - show next matches for tracked teams",
      "/teststart - sample kickoff alert",
      "/testresult - sample final result alert",
      "/help - show help",
    ].join("\n")
  )
);

bot.command("settings", async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.reply("Only group admins can change settings.");
  await ctx.reply(
    "Select 2026 World Cup teams to track in this chat:",
    settingsKeyboard(ctx.chat.id)
  );
});

bot.action(/^toggle:(.+)$/i, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery("Admins only");

  const name = ctx.match[1];
  const existing = trackedTeams(ctx.chat.id).find(
    (t) => t.team_name.toLowerCase() === name.toLowerCase()
  );

  if (existing) {
    removeTrackedTeam(ctx.chat.id, existing.team_id);
    await ctx.answerCbQuery(`Removed ${name}`);
  } else {
    const team = await searchTeam(name);
    if (!team) return ctx.answerCbQuery("Team not found");
    addTrackedTeam(ctx.chat.id, team.team.id, team.team.name);
    await ctx.answerCbQuery(`Added ${team.team.name}`);
  }

  await ctx.editMessageReplyMarkup(settingsKeyboard(ctx.chat.id).reply_markup);
});

bot.action("list_teams", async (ctx) => {
  await ctx.answerCbQuery();
  const teams = trackedTeams(ctx.chat.id);
  await ctx.reply(
    teams.length
      ? "Tracked teams:\n" + teams.map((t) => `- ${t.team_name}`).join("\n")
      : "No teams selected yet."
  );
});

bot.command("list", async (ctx) => {
  const teams = trackedTeams(ctx.chat.id);
  await ctx.reply(
    teams.length
      ? "Tracked teams:\n" + teams.map((t) => `- ${t.team_name}`).join("\n")
      : "No teams selected yet."
  );
});

bot.command("matches", async (ctx) => {
  const teams = trackedTeams(ctx.chat.id);
  if (!teams.length) return ctx.reply("No teams selected yet. Use /settings.");

  const lines = [];
  for (const team of teams) {
    try {
      const fx = await getNextFixtureForTeam(team.team_id);
      if (fx) lines.push(`\n${team.team_name}:\n${matchLine(fx)}`);
    } catch (e) {
      console.error(`Failed to fetch next match for ${team.team_name}:`, e.message);
    }
  }

  await ctx.reply(
    lines.length
      ? lines.join("\n")
      : "No upcoming World Cup matches found for selected teams."
  );
});

bot.command("teststart", (ctx) =>
  ctx.reply("⚽ Match starting now\nPortugal vs France\n2026 FIFA World Cup")
);

bot.command("testresult", (ctx) =>
  ctx.reply("🏁 Full time\nPortugal 2 - 1 France\n2026 FIFA World Cup")
);

async function pollMatches() {
  const tracked = allTrackedTeams();
  if (!tracked.length) return;

  const grouped = new Map();
  for (const row of tracked) {
    if (!grouped.has(row.team_id)) grouped.set(row.team_id, []);
    grouped.get(row.team_id).push(row);
  }

  const now = new Date();
  const dates = [0, 1].map((offset) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  });

  let fixtures = [];
  for (const date of dates) {
    try {
      fixtures = fixtures.concat(await getWorldCupFixturesByDate(date));
    } catch (e) {
      console.error(`Failed to fetch fixtures for ${date}:`, e.message);
    }
  }

  const nowMs = Date.now();

  for (const fx of fixtures) {
    const related = [
      ...(grouped.get(fx.teams.home.id) || []),
      ...(grouped.get(fx.teams.away.id) || []),
    ];

    if (!related.length) continue;

    const fixtureId = fx.fixture.id;
    const kickoff = new Date(fx.fixture.date).getTime();
    const started = nowMs >= kickoff && nowMs < kickoff + 10 * 60 * 1000;
    const finished = ["FT", "AET", "PEN"].includes(fx.fixture.status.short);

    for (const row of related) {
      if (started && !isSent(row.chat_id, fixtureId, "start")) {
        await bot.telegram.sendMessage(
          row.chat_id,
          `⚽ Match starting now\n${fx.teams.home.name} vs ${fx.teams.away.name}\n${fmtDate(fx.fixture.date)}\n2026 FIFA World Cup`
        );
        markSent(row.chat_id, fixtureId, "start");
      }

      if (finished && !isSent(row.chat_id, fixtureId, "result")) {
        await bot.telegram.sendMessage(
          row.chat_id,
          `🏁 Full time\n${fx.teams.home.name} ${fx.goals.home} - ${fx.goals.away} ${fx.teams.away.name}\n2026 FIFA World Cup`
        );
        markSent(row.chat_id, fixtureId, "result");
      }
    }
  }
}

cron.schedule("* * * * *", async () => {
  try {
    await pollMatches();
  } catch (e) {
    console.error("Polling error", e.message);
  }
});

bot.launch();
console.log("2026 FIFA World Cup Telegram bot is running");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
