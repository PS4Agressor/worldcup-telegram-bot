import "dotenv/config";
import Database from "better-sqlite3";
import cron from "node-cron";
import http from "http";
import axios from "axios";
import { Telegraf, Markup } from "telegraf";

const { BOT_TOKEN, TZ = "Europe/Riga", ADMIN_ONLY_SETTINGS = "true" } = process.env;

if (!BOT_TOKEN) {
  throw new Error("Missing BOT_TOKEN");
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

db.exec(`
CREATE TABLE IF NOT EXISTS tracked_teams (
  chat_id TEXT NOT NULL,
  team_name TEXT NOT NULL,
  PRIMARY KEY (chat_id, team_name)
);

CREATE TABLE IF NOT EXISTS sent_events (
  chat_id TEXT NOT NULL,
  fixture_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  PRIMARY KEY (chat_id, fixture_key, event_type)
);
`);

const WORLD_CUP_TEAMS = ["France", "Portugal", "Norway"];

const FIXTURES = {
  france: [
    { key: "france-senegal-2026-06-16", home: "France", away: "Senegal", date: "2026-06-16T19:00:00Z" },
    { key: "france-iraq-2026-06-22", home: "France", away: "Iraq", date: "2026-06-22T21:00:00Z" },
    { key: "norway-france-2026-06-26", home: "Norway", away: "France", date: "2026-06-26T19:00:00Z" },
  ],
  portugal: [
    { key: "portugal-congo-dr-2026-06-17", home: "Portugal", away: "Congo DR", date: "2026-06-17T17:00:00Z" },
    { key: "portugal-uzbekistan-2026-06-23", home: "Portugal", away: "Uzbekistan", date: "2026-06-23T17:00:00Z" },
    { key: "colombia-portugal-2026-06-27", home: "Colombia", away: "Portugal", date: "2026-06-27T23:30:00Z" },
  ],
  norway: [
    { key: "iraq-norway-2026-06-16", home: "Iraq", away: "Norway", date: "2026-06-16T21:00:00Z" },
    { key: "norway-senegal-2026-06-22", home: "Norway", away: "Senegal", date: "2026-06-22T23:00:00Z" },
    { key: "norway-france-2026-06-26", home: "Norway", away: "France", date: "2026-06-26T19:00:00Z" },
  ],
};

const SCOREBOARD_URL = "https://www.espn.com/soccer/scoreboard/_/league/fifa.world";

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

const isSent = (chatId, fixtureKey, eventType) =>
  !!db
    .prepare("SELECT 1 FROM sent_events WHERE chat_id = ? AND fixture_key = ? AND event_type = ?")
    .get(String(chatId), fixtureKey, eventType);

const markSent = (chatId, fixtureKey, eventType) =>
  db
    .prepare("INSERT OR IGNORE INTO sent_events (chat_id, fixture_key, event_type) VALUES (?, ?, ?)")
    .run(String(chatId), fixtureKey, eventType);

function fmtDate(date) {
  return new Date(date).toLocaleString("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getFixturesForTeam(teamName) {
  return FIXTURES[teamName.toLowerCase()] || [];
}

function getNextFixtureForTeam(teamName) {
  const now = Date.now();
  return (
    getFixturesForTeam(teamName)
      .filter((f) => new Date(f.date).getTime() > now)
      .sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null
  );
}

function teamNextBlock(teamName) {
  const f = getNextFixtureForTeam(teamName);
  if (!f) return null;
  return `${teamName}:\n${f.home} vs ${f.away}\n${fmtDate(f.date)}`;
}

function settingsKeyboard(chatId) {
  const current = trackedTeams(chatId).map((t) => t.team_name);
  const rows = WORLD_CUP_TEAMS.map((name) => [
    Markup.button.callback(
      `${current.includes(name) ? "✅" : "➕"} ${name}`,
      `toggle:${name}`
    ),
  ]);
  rows.push([Markup.button.callback("📋 My tracked teams", "list_teams")]);
  return Markup.inlineKeyboard(rows);
}

async function isAdmin(ctx) {
  if (ADMIN_ONLY_SETTINGS !== "true" || ctx.chat.type === "private") return true;
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function fetchScoreFromEspn(home, away) {
  try {
    const response = await axios.get(SCOREBOARD_URL, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const html = response.data || "";
    const homePattern = escapeRegex(home);
    const awayPattern = escapeRegex(away);

    const bothTeamsNearby = new RegExp(
      `${homePattern}[\\s\\S]{0,300}?(\\d+)[\\s\\S]{0,120}?${awayPattern}[\\s\\S]{0,300}?(\\d+)`,
      "i"
    );

    const reverseNearby = new RegExp(
      `${awayPattern}[\\s\\S]{0,300}?(\\d+)[\\s\\S]{0,120}?${homePattern}[\\s\\S]{0,300}?(\\d+)`,
      "i"
    );

    const m1 = html.match(bothTeamsNearby);
    if (m1) {
      return { homeScore: m1[1], awayScore: m1[2] };
    }

    const m2 = html.match(reverseNearby);
    if (m2) {
      return { homeScore: m2[2], awayScore: m2[1] };
    }

    return null;
  } catch (e) {
    console.error("Score fetch failed:", e.message);
    return null;
  }
}

bot.start(async (ctx) => {
  await ctx.reply(
    "World Cup bot is ready. Use /settings to track France, Portugal, and Norway."
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    [
      "Commands:",
      "/settings - choose teams to track in this chat",
      "/list - show tracked teams",
      "/matches - show next match for tracked teams",
      "/teststart - sample kickoff alert",
      "/testresult - sample final result alert",
      "/help - show help",
    ].join("\n")
  );
});

bot.command("settings", async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.reply("Only group admins can change settings.");
  }
  await ctx.reply("Select teams to track in this chat:", settingsKeyboard(ctx.chat.id));
});

bot.action(/^toggle:(.+)$/i, async (ctx) => {
  if (!(await isAdmin(ctx))) {
    return ctx.answerCbQuery("Admins only");
  }

  const teamName = ctx.match[1];
  if (!WORLD_CUP_TEAMS.includes(teamName)) {
    return ctx.answerCbQuery("Team not found");
  }

  const exists = trackedTeams(ctx.chat.id).find(
    (t) => t.team_name.toLowerCase() === teamName.toLowerCase()
  );

  if (exists) {
    removeTrackedTeam(ctx.chat.id, teamName);
    await ctx.answerCbQuery(`Removed ${teamName}`);
  } else {
    addTrackedTeam(ctx.chat.id, teamName);
    await ctx.answerCbQuery(`Added ${teamName}`);
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
  if (!teams.length) {
    return ctx.reply("No teams selected yet. Use /settings.");
  }

  const lines = teams.map((t) => teamNextBlock(t.team_name)).filter(Boolean);

  await ctx.reply(
    lines.length
      ? lines.map((x) => `\n${x}`).join("\n")
      : "No upcoming World Cup matches found for selected teams."
  );
});

bot.command("teststart", async (ctx) => {
  await ctx.reply("⚽ Match starting now\nFrance vs Senegal\n2026 FIFA World Cup");
});

bot.command("testresult", async (ctx) => {
  await ctx.reply("🏁 Full time\nFrance 2 - 1 Senegal\n2026 FIFA World Cup");
});

async function pollMatches() {
  const tracked = allTrackedTeams();
  if (!tracked.length) return;

  const now = Date.now();

  for (const row of tracked) {
    const fixtures = getFixturesForTeam(row.team_name).sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    for (const fx of fixtures) {
      const kickoff = new Date(fx.date).getTime();
      const started = now >= kickoff && now < kickoff + 10 * 60 * 1000;
      const finishedWindow = now >= kickoff + 105 * 60 * 1000;

      if (started && !isSent(row.chat_id, fx.key, "start")) {
        await bot.telegram.sendMessage(
          row.chat_id,
          `⚽ Match starting now\n${fx.home} vs ${fx.away}\n${fmtDate(fx.date)}\n2026 FIFA World Cup`
        );
        markSent(row.chat_id, fx.key, "start");
      }

      if (finishedWindow && !isSent(row.chat_id, fx.key, "result")) {
        const score = await fetchScoreFromEspn(fx.home, fx.away);

        if (score) {
          await bot.telegram.sendMessage(
            row.chat_id,
            `🏁 Full time\n${fx.home} ${score.homeScore} - ${score.awayScore} ${fx.away}\n2026 FIFA World Cup`
          );
          markSent(row.chat_id, fx.key, "result");
        }
      }
    }
  }
}

cron.schedule("* * * * *", async () => {
  try {
    await pollMatches();
  } catch (e) {
    console.error("Polling error:", e.message);
  }
});

bot.launch();
console.log("2026 FIFA World Cup Telegram bot is running");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
