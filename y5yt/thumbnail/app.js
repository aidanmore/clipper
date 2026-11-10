"use strict";

(() => {
  const panel = document.getElementById("thumbnail-panel");
  const episodes = document.getElementById("thumbnail-episodes");
  const search = document.getElementById("thumbnail-search");
  const catalogStatus = document.getElementById("thumbnail-catalog-status");
  const back = document.getElementById("thumbnail-back");
  const preview = document.getElementById("thumbnail-preview");
  const position = document.getElementById("thumbnail-position");
  const positionControl = document.getElementById("thumbnail-position-control");
  const positionLabel = document.getElementById("thumbnail-position-label");
  const dragHint = document.getElementById("thumbnail-drag-hint");
  const save = document.getElementById("thumbnail-save");
  const status = document.getElementById("thumbnail-status");
  const fileInput = document.getElementById("thumbnail-file");
  const fileControl = document.getElementById("thumbnail-file-control");
  const coverSource = document.getElementById("thumbnail-cover-source");
  const halftone = document.getElementById("thumbnail-halftone");
  const modes = [...panel.querySelectorAll('[name="thumbnail-framing"]')];
  const local = location.hostname === "127.0.0.1";
  const feedUrl = "https://anchor.fm/s/1014cea94/podcast/rss";
  const appleUrl = "https://itunes.apple.com/lookup?id=1809708437&entity=podcastEpisode&limit=200&country=US";
  const itunes = "http://www.itunes.com/dtds/podcast-1.0.dtd";
  const jpgLimit = 2_000_000;
  const exportWidth = 3840;
  const exportHeight = 2160;
  const sample = document.createElement("canvas");
  sample.width = 160;
  sample.height = 90;
  const sampleContext = sample.getContext("2d", { willReadFrequently: true });
  let catalog = [];
  let appleEpisodes;
  let selection;
  let art;
  let mode = "crop";
  let revision = 0;
  let drag;

  function announce(text, error = false) {
    status.textContent = text;
    status.dataset.error = error;
  }

  function crop(image, width, height) {
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const cropWidth = width / scale;
    const cropHeight = height / scale;
    return {
      width: cropWidth,
      height: cropHeight,
      xTravel: Math.max(0, image.naturalWidth - cropWidth),
      yTravel: Math.max(0, image.naturalHeight - cropHeight),
    };
  }

  function printScreen(canvas, context) {
    const { width, height } = preview;
    sampleContext.drawImage(canvas, 0, 0, sample.width, sample.height);
    const pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data;
    const rowStep = 6 * Math.SQRT1_2;
    context.save();
    context.scale(canvas.width / width, canvas.height / height);
    context.fillStyle = "rgba(14, 9, 6, 0.44)";
    context.beginPath();
    for (let row = 0, y = rowStep / 2; y < height; row++, y += rowStep) {
      const sampleRow = Math.floor(y * sample.height / height) * sample.width;
      for (let x = (row % 2 + 0.5) * rowStep; x < width; x += rowStep * 2) {
        const index = (sampleRow + Math.floor(x * sample.width / width)) * 4;
        const light = (0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2]) / 255;
        if (light < 0.035 || light > 0.96) continue;
        const radius = 2.55 * Math.sqrt(1 - light);
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, Math.PI * 2);
      }
    }
    context.fill();
    context.restore();
  }

  function draw(canvas, image, framing, fraction, screened) {
    const { width, height } = canvas;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    if (!image) return;
    context.imageSmoothingQuality = "high";
    if (framing === "fit") {
      const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
      const w = image.naturalWidth * scale;
      const h = image.naturalHeight * scale;
      context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
    } else {
      const { width: w, height: h, xTravel, yTravel } = crop(image, width, height);
      context.drawImage(image, xTravel * fraction, yTravel * fraction, w, h, 0, 0, width, height);
    }
    if (screened) printScreen(canvas, context);
  }

  function refresh() {
    draw(preview, art, mode, Number(position.value) / 1000, halftone.checked);
    const area = art && crop(art, preview.width, preview.height);
    const vertical = area && area.yTravel > 0.5;
    const movable = mode === "crop" && area && (vertical || area.xTravel > 0.5);
    positionControl.hidden = !movable;
    dragHint.hidden = !movable;
    preview.dataset.draggable = Boolean(movable);
    positionLabel.textContent = vertical ? "Vertical crop position" : "Horizontal crop position";
    dragHint.textContent = vertical ? "Drag the preview up or down, or use the slider." :
      "Drag the preview left or right, or use the slider.";
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Cover art is unavailable for editing."));
      image.src = url;
    });
  }

  async function getAppleEpisodes() {
    if (!appleEpisodes) {
      appleEpisodes = fetch(appleUrl).then((response) => {
        if (!response.ok) throw new Error("The Apple Podcasts catalog is unavailable.");
        return response.json();
      }).then(({ results }) => results).catch((error) => { appleEpisodes = null; throw error; });
    }
    return appleEpisodes;
  }

  async function getArt(episode) {
    if (local && episode.cover) {
      try {
        return await loadImage("/api/cover?guid=" + encodeURIComponent(episode.guid));
      } catch {
        // Fall back to the same artwork source used on the public page.
      }
    }

    try {
      const records = await getAppleEpisodes();
      const rendition = records.find(({ episodeGuid }) => episodeGuid === episode.guid)?.artworkUrl600;
      if (rendition) {
        const original = new URL(rendition);
        if (original.protocol === "https:" && original.hostname.endsWith(".mzstatic.com")) {
          const large = new URL(original);
          large.pathname = large.pathname.replace(/\/\d+x\d+bb\.(?:jpg|png)$/i, "/3000x3000bb.jpg");
          return await loadImage(large.href).catch(() => loadImage(original.href));
        }
      }
    } catch {
      // Some new episodes are in RSS before they reach the Apple directory.
    }

    if (episode.cover) return loadImage(episode.cover);
    throw new Error("No cover art is listed for this episode.");
  }

  function showArt(image) {
    art = image;
    position.value = "500";
    fileControl.hidden = true;
    save.disabled = false;
    announce("");
    refresh();
  }

  async function setEpisode(episode) {
    if (!episode || episode === selection) return;
    const request = ++revision;
    selection = episode;
    art = null;
    drag = null;
    preview.dataset.dragging = "false";
    position.value = "500";
    fileInput.value = "";
    fileControl.hidden = true;
    save.disabled = true;
    coverSource.hidden = !episode.cover;
    if (episode.cover) coverSource.href = episode.cover;
    preview.setAttribute("aria-label", "16:9 thumbnail preview for " + episode.title);
    const url = new URL(location.href);
    url.searchParams.set("episode", episode.guid);
    history.replaceState(null, "", url);
    back.href = "../?episode=" + encodeURIComponent(episode.guid);
    panel.hidden = false;
    announce("Loading episode art…");
    refresh();
    try {
      const image = await getArt(episode);
      if (request === revision) showArt(image);
    } catch {
      if (request !== revision) return;
      fileControl.hidden = false;
      announce("Couldn’t load the artwork for editing. Choose a cover file to continue.", true);
    }
  }

  function jpeg(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  async function saveThumbnail() {
    if (!art) return;
    const request = revision;
    const episode = selection;
    save.disabled = true;
    announce("Preparing JPG…");
    const canvas = document.createElement("canvas");
    canvas.width = exportWidth;
    canvas.height = exportHeight;
    try {
      draw(canvas, art, mode, Number(position.value) / 1000, halftone.checked);
      let blob;
      for (const quality of [0.94, 0.88, 0.8, 0.7, 0.6, 0.45, 0.3]) {
        if (request !== revision) return;
        blob = await jpeg(canvas, quality);
        if (blob && blob.size < jpgLimit) break;
      }
      if (request !== revision) return;
      if (!blob || blob.type !== "image/jpeg" || blob.size >= jpgLimit) {
        throw new Error("Couldn’t save a JPG under 2 MB.");
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      const episodeName = (episode.number || episode.title).normalize("NFKC").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72);
      link.href = url;
      link.download = ["yellow-five", episodeName, "thumbnail.jpg"].filter(Boolean).join("-");
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      announce("JPG ready.");
    } catch (error) {
      if (request === revision) announce(error.message, true);
    } finally {
      canvas.width = canvas.height = 1;
      if (request === revision) save.disabled = false;
    }
  }

  function updateArchive() {
    const query = search.value.trim().normalize("NFKC").toLowerCase();
    const matches = catalog.filter(({ title, number }) =>
      title.normalize("NFKC").toLowerCase().includes(query) || number === query.replace(/^#/, ""));
    const placeholder = new Option(matches.length ? "Choose an episode…" : "No matching episodes", "");
    placeholder.disabled = true;
    episodes.replaceChildren(placeholder, ...matches.map(({ guid, title }) => new Option(title, guid)));
    episodes.value = matches.includes(selection) ? selection.guid : "";
    episodes.disabled = !matches.length;
  }

  async function loadArchive() {
    try {
      const response = await fetch(local ? "/api/feed" : feedUrl);
      if (!response.ok) throw new Error("The feed is temporarily unavailable.");
      const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
      catalog = [...xml.querySelectorAll("channel > item")].map((item) => {
        const tagged = (name) => item.getElementsByTagNameNS(itunes, name)[0];
        const image = tagged("image")?.getAttribute("href") || "";
        return {
          guid: item.querySelector("guid")?.textContent.trim(),
          title: item.querySelector("title")?.textContent,
          number: tagged("episode")?.textContent || "",
          cover: image.startsWith("https://") ? image : "",
        };
      }).filter(({ guid, title }) => guid && title);
      if (!catalog.length) throw new Error("The feed returned no episodes.");
      const guid = new URL(location.href).searchParams.get("episode");
      setEpisode(catalog.find((episode) => episode.guid === guid) || catalog[0]);
      updateArchive();
    } catch (error) {
      catalogStatus.textContent = "Couldn’t load the Yellow Five archive. " + error.message;
      catalogStatus.dataset.error = "true";
    }
  }

  for (const control of modes) {
    control.addEventListener("change", () => {
      mode = control.value;
      refresh();
    });
  }
  position.addEventListener("input", refresh);
  halftone.addEventListener("change", refresh);
  search.addEventListener("input", updateArchive);
  episodes.addEventListener("change", () => setEpisode(catalog.find(({ guid }) => guid === episodes.value)));
  preview.addEventListener("pointerdown", (event) => {
    if (positionControl.hidden || event.button !== 0 || !event.isPrimary) return;
    const { width, height } = preview.getBoundingClientRect();
    const area = crop(art, preview.width, preview.height);
    const vertical = area.yTravel > 0.5;
    const travel = vertical ? area.yTravel * height / area.height : area.xTravel * width / area.width;
    drag = { id: event.pointerId, start: vertical ? event.clientY : event.clientX,
      vertical, travel, value: Number(position.value) };
    preview.setPointerCapture(event.pointerId);
    preview.dataset.dragging = "true";
  });
  preview.addEventListener("pointermove", (event) => {
    if (drag?.id !== event.pointerId) return;
    const point = drag.vertical ? event.clientY : event.clientX;
    const value = drag.value + 1000 * (drag.start - point) / drag.travel;
    position.value = String(Math.max(0, Math.min(1000, Math.round(value))));
    refresh();
  });
  preview.addEventListener("lostpointercapture", () => {
    drag = null;
    preview.dataset.dragging = "false";
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const request = ++revision;
    const url = URL.createObjectURL(file);
    try {
      const image = await loadImage(url);
      if (request === revision) showArt(image);
    } catch {
      if (request === revision) announce("Couldn’t open that image file.", true);
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  save.addEventListener("click", saveThumbnail);
  loadArchive();
})();
