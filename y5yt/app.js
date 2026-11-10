"use strict";

const $ = (id) => document.getElementById(id);
const feedUrl = "https://anchor.fm/s/1014cea94/podcast/rss";
const appleUrl = "https://itunes.apple.com/lookup?id=1809708437&entity=podcastEpisode&limit=200&country=US";
const itunes = "http://www.itunes.com/dtds/podcast-1.0.dtd";
let episodes = [];
let current = null;
let companion = null;
let job = null;
let appleEpisodes = null;
let pollTimer;
let appliedTranscript = null;

function message(id, text, error = false) {
  $(id).textContent = text;
  $(id).dataset.error = error;
}

async function request(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Request failed (" + response.status + ").");
  }
  return response;
}

function https(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function showNotes(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  function read(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    if (["SCRIPT", "STYLE", "TEMPLATE"].includes(node.tagName)) return "";
    if (node.tagName === "BR") return "\n";
    const body = [...node.childNodes].map(read).join("");
    if (node.tagName === "A") {
      const href = https(node.getAttribute("href"));
      return href && body.trim() !== href ? [body, href].filter(Boolean).join(" ") : body;
    }
    if (node.tagName === "LI") return "\n• " + body;
    return /^(P|DIV|UL|OL|BLOCKQUOTE|H[1-6])$/.test(node.tagName) ? body + "\n\n" : body;
  }
  return [...template.content.childNodes].map(read).join("").replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").trim();
}

function parseFeed(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Yellow Five’s feed is temporarily unreadable.");
  return [...xml.querySelectorAll("channel > item")].map((item) => {
    const tagged = (name) => item.getElementsByTagNameNS(itunes, name)[0];
    return {
      guid: item.querySelector("guid")?.textContent.trim(),
      title: item.querySelector("title")?.textContent || "",
      number: tagged("episode")?.textContent || "",
      duration: tagged("duration")?.textContent || "",
      date: item.querySelector("pubDate")?.textContent || "",
      description: showNotes(item.querySelector("description")?.textContent || ""),
      audio: https(item.querySelector("enclosure")?.getAttribute("url")),
      cover: https(tagged("image")?.getAttribute("href")),
      hostLink: https(item.querySelector("link")?.textContent),
    };
  }).filter((episode) => episode.guid && episode.title);
}

function archiveOptions() {
  const query = $("search").value.trim().toLowerCase().normalize("NFKC");
  const matches = episodes.filter(({ title, number }) =>
    title.toLowerCase().normalize("NFKC").includes(query) || number === query.replace(/^#/, ""));
  const placeholder = new Option(matches.length ? "Choose an episode…" : "No matching episodes", "");
  placeholder.disabled = true;
  $("episodes").replaceChildren(placeholder, ...matches.map(({ guid, title }) => new Option(title, guid)));
  $("episodes").value = matches.includes(current) ? current.guid : "";
}

function source(id, url) {
  $(id).hidden = !url;
  if (url) $(id).href = url;
  else $(id).removeAttribute("href");
}

function selectEpisode(episode) {
  if (!episode || episode === current) return;
  current = episode;
  appliedTranscript = null;
  const url = new URL(location.href);
  url.searchParams.set("episode", current.guid);
  history.replaceState(null, "", url);
  if (![...$("episodes").options].some(({ value }) => value === current.guid)) {
    $("search").value = "";
  }
  archiveOptions();
  $("workspace").hidden = false;
  $("episode-title").textContent = current.title;
  $("title").value = current.title;
  $("description").value = current.description;
  $("transcript").value = "";
  const date = new Date(current.date);
  $("episode-info").textContent = [
    Number.isNaN(date.valueOf()) ? "" : date.toLocaleDateString(undefined, { dateStyle: "medium" }),
    current.duration,
  ].filter(Boolean).join(" · ");
  $("cover").hidden = !current.cover;
  if (current.cover) $("cover").src = current.cover;
  else $("cover").removeAttribute("src");
  source("audio-source", current.audio);
  source("cover-source", current.cover);
  message("copy-status", "");
  applyTags("");
  syncJob();
}

async function resolveLink(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Paste an HTTPS episode link.");
  if (url.hostname === "podcasters.spotify.com" || url.hostname === "creators.spotify.com") {
    return episodes.find((episode) => episode.hostLink && new URL(episode.hostLink).pathname === url.pathname);
  }
  if (url.hostname !== "podcasts.apple.com" || !url.pathname.endsWith("/id1809708437")) {
    throw new Error("Paste an Apple Podcasts link for a Yellow Five episode, or choose it from the archive.");
  }
  const id = url.searchParams.get("i");
  if (!/^\d+$/.test(id || "")) throw new Error("This is the show link. Open an individual episode and copy its link.");
  if (!appleEpisodes) appleEpisodes = (await (await request(appleUrl)).json()).results;
  const episodeGuid = appleEpisodes.find((entry) => String(entry.trackId) === id)?.episodeGuid;
  return episodes.find((episode) => episode.guid === episodeGuid);
}

function updateCounts() {
  const title = [...$("title").value].length;
  const description = new TextEncoder().encode($("description").value).length;
  const tags = Y5Tags.budget(Y5Tags.splitTags($("tags").value));
  message("title-count", title + " / 100 characters", title > 100);
  message("description-count", description + " / 5,000 bytes", description > 5000);
  message("tags-count", tags + " / 500 characters including YouTube’s separator rules", tags > 500);
}

function applyTags(transcript) {
  const { tags, topicCount } = Y5Tags.suggest(current.title, current.description, transcript);
  $("tags").value = tags.join(", ");
  const hint = !transcript ? "Show and episode title tags. Add a transcript to suggest spoken topics." :
    topicCount ? topicCount + " transcript-based topic suggestions. Check the names and keep the most relevant ones." :
    "No clear recurring topics found in this transcript. You can edit the tags directly.";
  message("tag-source", hint);
  updateCounts();
}

function syncJob() {
  if (!companion || !current) return;
  const active = job?.state === "running";
  const selected = job?.guid === current.guid ? job : null;
  $("render").disabled = active || !companion.ffmpeg || !current.audio || !current.cover;
  $("transcribe").disabled = active || !companion.ffmpeg || !current.audio;
  $("video-download").hidden = !selected?.video;
  if (selected?.video) {
    $("video-download").href = "/api/video?guid=" + encodeURIComponent(current.guid);
    $("video-download").download = selected.video;
  }
  const progress = $("progress");
  progress.hidden = !active || !selected;
  if (selected?.progress == null) progress.removeAttribute("value");
  else progress.value = selected.progress;
  const status = selected?.error || selected?.stage || (active ? "Another episode is processing." : "");
  message("job-status", status, Boolean(selected?.error));
  if (selected?.transcript && selected.transcript !== appliedTranscript) {
    appliedTranscript = selected.transcript;
    $("transcript").value = selected.transcript;
    applyTags(selected.transcript);
  }
}

async function refreshJob() {
  clearTimeout(pollTimer);
  try {
    const status = await (await request("/api/status")).json();
    job = status.job;
    syncJob();
    if (job?.state === "running") pollTimer = setTimeout(refreshJob, 1500);
  } catch (error) {
    message("job-status", "Waiting for the local launcher. " + error.message, true);
    if (job?.state === "running") pollTimer = setTimeout(refreshJob, 3000);
  }
}

async function startJob(action) {
  if (!current) return;
  $("render").disabled = true;
  $("transcribe").disabled = true;
  try {
    job = await (await request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Y5YT": "1" },
      body: JSON.stringify({ guid: current.guid, action }),
    })).json();
    syncJob();
    refreshJob();
  } catch (error) {
    syncJob();
    message("job-status", error.message, true);
  }
}

async function copyField(id) {
  const field = $(id);
  const value = id === "tags" ? Y5Tags.splitTags(field.value).join(", ") : field.value;
  if (id === "tags" && Y5Tags.budget(Y5Tags.splitTags(value)) > 500) {
    message("copy-status", "Trim the tags to YouTube’s 500-character limit first.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    field.focus();
    field.select();
    if (!document.execCommand("copy")) {
      message("copy-status", "The field is selected. Copy it with your device’s copy command.", true);
      return;
    }
  }
  message("copy-status", id[0].toUpperCase() + id.slice(1) + " copied.");
}

async function init() {
  $("find-link").disabled = true;
  $("episodes").disabled = true;
  try {
    if (location.hostname === "127.0.0.1") {
      companion = await (await request("/api/status")).json().catch(() => null);
    }
  } catch {
    companion = null;
  }
  if (companion) {
    job = companion.job;
    $("mode").textContent = "Local renderer";
    $("local-controls").hidden = false;
    $("with-transcript-label").hidden = !companion.whisper;
    $("transcribe").hidden = !companion.whisper;
    message("output", companion.ffmpeg ? "Saves to " + companion.output :
      "FFmpeg and FFprobe are missing. See the setup instructions below.", !companion.ffmpeg);
  } else {
    $("setup").open = true;
  }
  try {
    const response = await request(companion ? "/api/feed" : feedUrl);
    episodes = parseFeed(await response.text());
    if (!episodes.length) throw new Error("The feed returned no episodes.");
    archiveOptions();
    $("find-link").disabled = false;
    $("episodes").disabled = false;
    const guid = new URL(location.href).searchParams.get("episode") || job?.guid;
    if (guid) selectEpisode(episodes.find((episode) => episode.guid === guid));
    if (job?.state === "running") refreshJob();
    message("archive-status", episodes.length + " Yellow Five episodes available.");
  } catch (error) {
    message("archive-status", "Could not load the archive. " + error.message, true);
  }
}

$("search").addEventListener("input", archiveOptions);
$("episodes").addEventListener("change", () => selectEpisode(episodes.find(({ guid }) => guid === $("episodes").value)));
$("link-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("find-link").disabled = true;
  try {
    const episode = await resolveLink($("episode-link").value.trim());
    if (!episode) throw new Error("That episode is unavailable in the feed lookup. Try the archive search.");
    selectEpisode(episode);
    message("archive-status", "Found " + episode.title);
  } catch (error) {
    message("archive-status", error.message, true);
  } finally {
    $("find-link").disabled = false;
  }
});
$("render").addEventListener("click", () => startJob(companion.whisper && $("with-transcript").checked ? "both" : "render"));
$("transcribe").addEventListener("click", () => startJob("transcribe"));
$("use-transcript").addEventListener("click", () => applyTags($("transcript").value.trim()));
for (const id of ["title", "description", "tags"]) $(id).addEventListener("input", updateCounts);
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", () => copyField(button.dataset.copy));
}
init();
