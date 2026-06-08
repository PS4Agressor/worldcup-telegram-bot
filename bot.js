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

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("World Cup Telegram bot is alive");
  })
  .listen(PORT, HOST, () => {
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
  team_name TEXT NOT NULL,
  PRIMARY KEY (chat_id, team_name)
);
CREATE TABLE IF NOT EXISTS sent_events (
  chat_id TEXT NOT NULL,
  fixture_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (chat_id, fixture_id, event_type)
);
`);

const WORLD_CUP_TEAMS = [
  "Mexico","South Korea","South Africa","Czechia",
  "Canada","Switzerland","Qatar","Bosnia & Herzegovina",
  "Brazil","Morocco","Scotland","Haiti",
  "United States","Australia","Paraguay","Türkiye",
  "Germany","Ecuador","Ivory Coast","Curaçao",
  "Netherlands","Japan","Tunisia","Sweden",
  "Belgium","Iran","Egypt","New Zealand",
  "Spain","Uruguay","Saudi Arabia","Cape Verde",
  "France","Senegal","Norway","Iraq",
  "Argentina","Austria","Algeria","Jordan",
  "Portugal","Colombia","Uzbekistan","Congo DR",
  "England","Croatia","Panama","Ghana"
];

const PAGE_SIZE = 8;

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

const trackedTeams = (chatId) =>
  db
    .prepare("SELECT team_name FROM tracked_teams WHERE chat_id = ? ORDER BY team_name")
    .all(String(chatId));

const allTrackedTeams = () =>
  db.prepare("SELECT chat_id, team_name FROM tracked_teams").all();

const addTrackedTeam = (chatId, teamName) =>
  db
    .prepare("INSERT OR IGNORE INTO tracked_teams (chat_id, team_name) VALUES (?, ?)")
    .run(String(chatId), teamName);

const removeTrackedTeam = (chatId, teamName) =>
  db
    .prepare("DELETE FROM tracked_teams WHERE chat_id = ? AND team_name = ?")
    .run(String(chatId), teamName);

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

function settingsKeyboard(chatId, page = 0) {
  const current = trackedTeams(chatId).map((t) => t.team_name);
  const start = page * PAGE_SIZE;
  const teams = WORLD_CUP_TEAMS.slice(start, start + PAGE_SIZE);

  const rows = teams.map((name) => {
    const enabled = current.includes(name);
    return [
      Markup.button.callback(
        `${enabled ? "✅" : "➕"} ${name}`,
        `toggle:${page}:${name}`
      ),
    ];
  });

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️ Prev", `page:${page - 1}`));
  if (start + PAGE_SIZE < WORLD_CUP_TEAMS.length) {
    nav.push(Markup.button.callback("Next ➡️", `page:${page + 1}`));
  }
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback("📋 My tracked teams", "list_teams")]);

  return Markup.inlineKeyboard(rows);
}

async function getNextFixtureForTeamName(teamName) {
  const fixtures = await getUpcomingWorldCupFixtures();
  const now = Date.now();

  const upcoming = fixtures
    .filter((fx) => {
      const home = fx.teams.home.name?.toLowerCase();
      const away = fx.teams.away.name?.toLowerCase();
      const target = teamName.toLowerCase();
      return (home === target || away === target) &&
        new Date(fx.fixture.date).getTime() > now;
    })
    .sort(
      (a, b) =>
        new Date(a.fixture.date).getTime() -
        new Date(b.fixture.date).getTime()
    );

  return upcoming[0] || null;
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
    settingsKeyboard(ctx.chat.id, 0)
  );
});

bot.action(/^page:(\d+)$/i, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery("Admins only");
  const page = Number(ctx.match[1] || 0);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(settingsKeyboard(ctx.chat.id, page).reply_markup);
});

bot.action(/^toggle:(\d+):(.+)$/i, async (ctx) => {
  if (!(await isAdmin(ctx))) return ctx.answerCbQuery("Admins only");

  const page = Number(ctx.match[1] || 0);
  const teamName = ctx.match[2];

  if (!WORLD_CUP_TEAMS.includes(teamName)) {
    return ctx.answerCbQuery("Team not found");
  }

  const existing = trackedTeams(ctx.chat.id).find(
    (t) => t.team_name.toLowerCase() === teamName.toLowerCase()
  );

  if (existing) {
    removeTrackedTeam(ctx.chat.id, teamName);
    await ctx.answerCbQuery(`Removed ${teamName}`);
  } else {
    addTrackedTeam(ctx.chat.id, teamName);
    await ctx.answerCbQuery(`Added ${teamName}`);
  }

  await ctx.editMessageReplyMarkup(settingsKeyboard(ctx.chat.id, page).reply_markup);
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
      const fx = await getNextFixtureForTeamName(team.team_name);
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

  const fixtures = await getUpcomingWorldCupFixtures().catch(() => []);
  const nowMs = Date.now();

  for (const row of tracked) {
    const related = fixtures
      .filter((fx) => {
        const home = fx.teams.home.name?.toLowerCase();
        const away = fx.teams.away.name?.toLowerCase();
        const target = row.team_name.toLowerCase();
        return home === target || away === target;
      })
      .sort(
        (a, b) =>
          new Date(a.fixture.date).getTime() -
          new Date(b.fixture.date).getTime()
      );

    for (const fx of related) {
      const fixtureId = fx.fixture.id;
      const kickoff = new Date(fx.fixture.date).getTime();
      const started = nowMs >= kickoff && nowMs < kickoff + 10 * 60 * 1000;
      const finished = ["FT", "AET", "PEN"].includes(fx.fixture.status.short);

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
