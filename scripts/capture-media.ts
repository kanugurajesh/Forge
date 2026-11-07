/**
 * Reproducible README media: screenshots + a narrated walkthrough video.
 *
 *   npm run demo -- --no-heal --serve   # then, in another shell:
 *   npx tsx scripts/capture-media.ts demoted
 *
 *   npm run demo -- --serve             # full lifecycle, then:
 *   npx tsx scripts/capture-media.ts full
 *
 * Writes docs/images/*.png and (full) docs/media/forge-walkthrough.{mp4,gif}.
 * Needs ffmpeg on PATH for the mp4/gif conversion.
 */
import { chromium, type Locator, type Page } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE = `http://127.0.0.1:${process.env.PORT ?? 4317}`;
const IMG = "docs/images";
const MEDIA = "docs/media";
const phase = process.argv[2] ?? "full";

/** A visible cursor + click ripple, since recorded videos don't show the pointer. */
const CURSOR = `
addEventListener("DOMContentLoaded", () => {
  const c = document.createElement("div");
  c.id = "__cursor";
  Object.assign(c.style, { position: "fixed", left: "-40px", top: "-40px", width: "18px", height: "18px", borderRadius: "50%",
    background: "rgba(79,70,229,.85)", border: "2px solid #fff", boxShadow: "0 1px 6px rgba(0,0,0,.35)", zIndex: 2147483647,
    pointerEvents: "none", transform: "translate(-50%,-50%)", transition: "width .12s, height .12s" });
  document.documentElement.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", () => { c.style.width = c.style.height = "28px"; }, true);
  addEventListener("mouseup", () => { c.style.width = c.style.height = "18px"; }, true);
});`;

/** Caption bar at the bottom of the frame, for the video. */
async function caption(page: Page, text: string) {
  await page.evaluate((t) => {
    let el = document.getElementById("__caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "__caption";
      Object.assign(el.style, { position: "fixed", left: "50%", bottom: "22px", transform: "translateX(-50%)", maxWidth: "88%",
        padding: "10px 18px", borderRadius: "10px", background: "rgba(17,17,27,.88)", color: "#fff", zIndex: 2147483646,
        font: "500 17px/1.35 system-ui, -apple-system, Segoe UI, sans-serif", pointerEvents: "none", textAlign: "center" });
      document.documentElement.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function moveTo(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const b = await target.boundingBox();
  if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
}

async function click(page: Page, target: Locator, pause = 500) {
  await moveTo(page, target);
  await page.waitForTimeout(150);
  await target.click();
  await page.waitForTimeout(pause);
}

async function type(page: Page, target: Locator, text: string) {
  await click(page, target, 150);
  await target.pressSequentially(text, { delay: 45 });
}

async function setLayout(page: Page, v: "v1" | "v2") {
  await page.context().clearCookies({ name: "relay_layout" });
  if (v === "v2") await page.context().addCookies([{ name: "relay_layout", value: "v2", url: BASE }]);
}

async function shot(page: Page, file: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(IMG, file) });
  console.log(`  ${join(IMG, file)}`);
}

async function screenshots(phase: string) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await ctx.newPage();
  console.log("screenshots:");

  if (phase === "demoted") {
    await page.goto(`${BASE}/#/p/relay.send_email`);
    await page.getByRole("tab", { name: /steps/ }).waitFor();
    await shot(page, "procedure-demoted.png");
  } else {
    await page.goto(`${BASE}/#/`);
    await page.getByText("relay.send_email").first().waitFor();
    await shot(page, "hub-registry.png");

    await page.goto(`${BASE}/#/compile`);
    await page.getByRole("button", { name: /Noisy/ }).click();
    await page.getByText(/steps/).first().waitFor();
    await shot(page, "hub-compile.png");

    await page.getByRole("button", { name: /Live BrowserOps run/ }).click();
    await page.waitForTimeout(800);
    await shot(page, "hub-compile-live.png");

    await page.goto(`${BASE}/#/p/relay.send_email`);
    await page.getByRole("tab", { name: /versions/ }).click();
    await shot(page, "procedure-versions.png");
    await page.getByRole("tab", { name: /runs/ }).click();
    await shot(page, "procedure-runs.png");

    const relay = await ctx.newPage();
    await relay.setViewportSize({ width: 1100, height: 700 });
    for (const v of ["v1", "v2"] as const) {
      await setLayout(relay, v);
      await relay.goto(`${BASE}/demo/`);
      await relay.locator("#compose-btn").click();
      await relay.locator("#composer[open]").waitFor();
      await shot(relay, `relay-${v}.png`);
    }
    await setLayout(relay, "v1");
  }
  await browser.close();
}

async function walkthrough() {
  mkdirSync(MEDIA, { recursive: true });
  const raw = join(MEDIA, "raw");
  rmSync(raw, { recursive: true, force: true });
  const size = { width: 1280, height: 800 };
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: size, recordVideo: { dir: raw, size }, colorScheme: "light" });
  await ctx.addInitScript(CURSOR);
  const page = await ctx.newPage();
  await setLayout(page, "v1");
  const beat = (ms = 1400) => page.waitForTimeout(ms);

  // 1. The task an agent did once
  await page.goto(`${BASE}/demo/`);
  await caption(page, "An agent sends an email once, the slow way: every step costs LLM tokens.");
  await page.mouse.move(640, 400);
  await beat();
  await click(page, page.locator("#compose-btn"));
  await type(page, page.locator("[name=to]"), "priya@relay.dev");
  await type(page, page.locator("[name=subject]"), "Launch checklist");
  await type(page, page.locator("textarea[name=body]"), "Looks good, ship it Friday.");
  await click(page, page.locator("[data-action=send]"), 900);
  await beat(800);

  // 2. Compile the recorded run
  await page.goto(`${BASE}/#/compile`);
  await caption(page, "Forge compiles the recorded tool calls into a deterministic BrowserOps procedure.");
  await beat(1000);
  await click(page, page.getByRole("button", { name: /Noisy/ }), 1600);
  await caption(page, "17 noisy calls → 7 steps. Every dropped call says why; replays use 0 LLM tokens.");
  await page.mouse.wheel(0, 380);
  await beat(2200);
  await page.mouse.wheel(0, -380);
  await click(page, page.getByRole("button", { name: /Live BrowserOps run/ }), 1200);
  await caption(page, "The same compiler on a real run captured from the live BrowserOps MCP server: 10 calls → 7 steps.");
  await beat(2600);

  // 3. Registry and trust
  await page.goto(`${BASE}/#/`);
  await caption(page, "Forge Hub: a procedure is trusted only after 3 clean strict runs.");
  await beat(1800);
  await click(page, page.getByRole("link", { name: /relay\.send_email/ }).first(), 1200);
  await caption(page, "Each step uses the most stable locator: data-testid first, copy-derived names last.");
  await beat(2200);

  // 4. Drift
  await setLayout(page, "v2");
  await page.goto(`${BASE}/demo/`);
  await caption(page, "Then the site ships a redesign at the same URL: “Compose” → “New message”, “Send” → “Send message”.");
  await beat(1000);
  await click(page, page.locator("#compose-btn"), 1800);
  await setLayout(page, "v1");

  await page.goto(`${BASE}/#/p/relay.send_email`);
  await click(page, page.getByRole("tab", { name: /runs/ }), 800);
  await caption(page, "Runs still complete by relocating, but past 40% relocation the Hub demotes the procedure, with the reason.");
  await beat(3000);

  // 5. Heal
  await click(page, page.getByRole("tab", { name: /versions/ }), 800);
  await caption(page, "forge heal re-proposes the drifted locator from the live page. v2 has to earn trust again.");
  await beat(3000);
  await caption(page, "Teach once. Replay without the agent. Catch drift. Heal.");
  await beat(2200);

  const video = page.video();
  await ctx.close();
  await browser.close();
  const webm = video ? await video.path() : readdirSync(raw).map((f) => join(raw, f))[0];
  const mp4 = join(MEDIA, "forge-walkthrough.mp4");
  const gif = join(MEDIA, "forge-walkthrough.gif");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", mp4]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf",
    "fps=8,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle", gif]);
  renameSync(webm, join(MEDIA, "raw.webm"));
  rmSync(raw, { recursive: true, force: true });
  rmSync(join(MEDIA, "raw.webm"), { force: true });
  console.log(`video:\n  ${mp4}\n  ${gif}`);
}

mkdirSync(IMG, { recursive: true });
await screenshots(phase);
if (phase === "full") await walkthrough();
